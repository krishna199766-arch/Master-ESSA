"""Alterations — a sold garment gone back for tailoring.

Unlike a return, nothing financial is reversed: the garment belongs to the
customer, it left stock when it was sold, and it is coming back only so somebody
can take up a hem. What this tracks is custody — who holds the piece, what was
asked for, when it was promised, and whether the customer has it back — because
that is the thing a shop actually loses track of.

The lifecycle is deliberately three steps. "Pending" and "delivered" alone
cannot tell a garment still at the tailor from one sitting on the shelf waiting
to be collected, and those need different chasing: one is the tailor's problem,
the other is a phone call to the customer.

Any charge is settled at handover, not when the job is taken in — until the work
is done there is nothing to charge for.
"""
from datetime import date, datetime

from flask import (Blueprint, render_template, request, redirect, url_for,
                   flash, jsonify)
from flask_login import login_required, current_user

from app import db
from app.models import (Alteration, AlterationItem, Customer, Invoice, Tailor)
from app.routes.pos import resolve_staff
from app.utils import generate_number, role_required

alterations_bp = Blueprint("alterations", __name__)

OPEN_STATES = ("pending", "ready")


@alterations_bp.route("/")
@login_required
def index():
    """Take a garment in: find the bill it was sold on."""
    q = (request.args.get("q") or "").strip()
    invoice = None
    if q:
        invoice = Invoice.query.filter_by(invoice_number=q).first()
        if not invoice and q.isdigit():
            invoice = Invoice.query.get(int(q))
        if not invoice:
            flash(f"No invoice matches '{q}'.", "warning")
        elif invoice.is_cancelled:
            flash(f"{invoice.invoice_number} was cancelled — its garments are back in stock.",
                  "warning")
            invoice = None

    open_jobs = Alteration.query.filter(Alteration.status.in_(OPEN_STATES)) \
        .order_by(Alteration.promised_date.is_(None), Alteration.promised_date).all()
    tailors = Tailor.query.filter_by(active=True).order_by(Tailor.name).all()
    return render_template("alterations/index.html", q=q, invoice=invoice,
                           open_jobs=open_jobs, tailors=tailors, today=date.today())


@alterations_bp.route("/create", methods=["POST"])
@login_required
def create():
    invoice_id = request.form.get("invoice_id", type=int)
    inv = Invoice.query.get_or_404(invoice_id)
    if inv.is_cancelled:
        flash(f"{inv.invoice_number} was cancelled — it cannot go for alteration.", "danger")
        return redirect(url_for("alterations.index"))

    staff = resolve_staff(request.form.get("staff_code"))
    if staff is None:
        flash("Identify the staff member taking this in first.", "danger")
        return redirect(url_for("alterations.index", q=inv.invoice_number))

    taking = []
    for item in inv.items:
        qty = request.form.get(f"qty_{item.id}", type=float) or 0.0
        if qty <= 0:
            continue
        if qty > item.quantity:
            flash(f"{item.product.name}: only {item.quantity} were sold.", "danger")
            return redirect(url_for("alterations.index", q=inv.invoice_number))
        taking.append((item, qty, (request.form.get(f"note_{item.id}") or "").strip()[:256]))

    if not taking:
        flash("Nothing was marked for alteration.", "warning")
        return redirect(url_for("alterations.index", q=inv.invoice_number))

    promised = request.form.get("promised_date") or ""
    try:
        promised_date = datetime.strptime(promised, "%Y-%m-%d").date() if promised else None
    except ValueError:
        promised_date = None

    job = Alteration(
        number=generate_number("ALT", Alteration, "number"),
        invoice_id=inv.id,
        tailor_id=request.form.get("tailor_id", type=int) or None,
        staff_id=staff.id,
        promised_date=promised_date,
        charge=float(request.form.get("charge") or 0),
        remarks=(request.form.get("remarks") or "").strip()[:256],
    )
    db.session.add(job)
    db.session.flush()

    for item, qty, instructions in taking:
        db.session.add(AlterationItem(
            alteration_id=job.id, invoice_item_id=item.id,
            product_id=item.product_id, quantity=qty, instructions=instructions))

    db.session.commit()
    flash(f"Alteration {job.number} booked in.", "success")
    return redirect(url_for("alterations.view_job", aid=job.id))


@alterations_bp.route("/<int:aid>")
@login_required
def view_job(aid):
    job = Alteration.query.get_or_404(aid)
    return render_template("alterations/ticket.html", job=job, today=date.today())


@alterations_bp.route("/<int:aid>/ready", methods=["POST"])
@login_required
def mark_ready(aid):
    """Back from the tailor and waiting for the customer."""
    job = Alteration.query.get_or_404(aid)
    if job.status != "pending":
        flash(f"{job.number} is already {job.status}.", "warning")
    else:
        job.status = "ready"
        job.ready_at = datetime.utcnow()
        db.session.commit()
        flash(f"{job.number} is ready for collection.", "success")
    return redirect(request.referrer or url_for("alterations.view_job", aid=job.id))


@alterations_bp.route("/<int:aid>/deliver", methods=["POST"])
@login_required
def deliver(aid):
    """Handed back to the customer, and any charge settled."""
    job = Alteration.query.get_or_404(aid)
    if job.status == "delivered":
        flash(f"{job.number} was already delivered.", "warning")
        return redirect(url_for("alterations.view_job", aid=job.id))

    staff = resolve_staff(request.form.get("staff_code"))
    if staff is None:
        flash("Identify the staff member handing this over.", "danger")
        return redirect(url_for("alterations.view_job", aid=job.id))

    job.status = "delivered"
    job.delivered_at = datetime.utcnow()
    job.delivered_by_id = staff.id
    if job.charge:
        job.charge_method = request.form.get("charge_method") or "cash"
    db.session.commit()
    flash(f"{job.number} handed to the customer.", "success")
    return redirect(url_for("alterations.view_job", aid=job.id))


@alterations_bp.route("/list")
@login_required
def list_jobs():
    status = (request.args.get("status") or "open").strip()
    q = Alteration.query
    if status == "open":
        q = q.filter(Alteration.status.in_(OPEN_STATES))
    elif status == "overdue":
        q = q.filter(Alteration.status == "pending",
                     Alteration.promised_date.isnot(None),
                     Alteration.promised_date < date.today())
    elif status in ("pending", "ready", "delivered"):
        q = q.filter(Alteration.status == status)
    # job number, bill number or customer — alongside the status chips above
    term = (request.args.get("q") or "").strip()
    if term:
        from sqlalchemy import or_
        like = f"%{term}%"
        q = (q.join(Invoice, Alteration.invoice_id == Invoice.id)
             .outerjoin(Customer, Invoice.customer_id == Customer.id)
             .filter(or_(Alteration.number.ilike(like), Invoice.invoice_number.ilike(like),
                         Customer.name.ilike(like), Customer.phone.ilike(like))))
    jobs = q.order_by(Alteration.id.desc()).limit(300).all()
    return render_template("alterations/list.html", jobs=jobs, status=status,
                           today=date.today(), q=term)


# ---- the tailor list -------------------------------------------------------

@alterations_bp.route("/tailors", methods=["GET", "POST"])
@login_required
@role_required("admin", "manager")
def tailors():
    if request.method == "POST":
        name = (request.form.get("name") or "").strip()
        if not name:
            flash("A tailor needs a name.", "danger")
        else:
            db.session.add(Tailor(
                name=name,
                phone=(request.form.get("phone") or "").strip(),
                notes=(request.form.get("notes") or "").strip()[:256]))
            db.session.commit()
            flash(f"{name} added.", "success")
        return redirect(url_for("alterations.tailors"))

    rows = Tailor.query.order_by(Tailor.active.desc(), Tailor.name).all()
    # What each one is currently holding — the reason to open this page at all.
    holding = {
        t.id: Alteration.query.filter(Alteration.tailor_id == t.id,
                                      Alteration.status == "pending").count()
        for t in rows
    }
    return render_template("alterations/tailors.html", tailors=rows, holding=holding)


@alterations_bp.route("/tailors/<int:tid>/toggle", methods=["POST"])
@login_required
@role_required("admin", "manager")
def toggle_tailor(tid):
    t = Tailor.query.get_or_404(tid)
    t.active = not t.active
    db.session.commit()
    flash(f"{t.name} {'re-activated' if t.active else 'archived'}.", "info")
    return redirect(url_for("alterations.tailors"))
