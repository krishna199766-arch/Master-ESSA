"""Customer returns — goods coming back against the bill they went out on.

A return is not a sale in reverse; it is its own document (a credit note) that
undoes part of one invoice. Undoing it properly means touching everything the
sale touched:

  stock     the goods come back. Resellable ones go on the shelf; damaged ones
            come back and are immediately written off, so the movement log shows
            what really happened rather than a shelf count that quietly lies.
  GST       the tax on the returned lines is reversed, split the same way the
            invoice split it (IGST interstate, CGST/SGST otherwise).
  discount  a bill-level discount is refunded pro rata, or a customer returning
            one item of five would get back more than they paid for it.
  loyalty   points earned on the refunded amount are taken back, and what the
            customer actually spent comes down.
  commission the staff member on the ORIGINAL sale loses the credit — not
            whoever happens to be handling the return. See routes/staff.py.
  promotion a free item was earned by buying something. Hand that something
            back and it is not earned any more, so the promotions on the bill
            are re-checked and what the customer no longer qualifies for is
            either returned with it, charged for, or written off — whichever the
            scheme says. See app/promotions.review_return.

Nothing can come back twice: every line is capped at what it was sold for, less
what has already been credited.
"""
from datetime import date, datetime

from flask import (Blueprint, render_template, request, redirect, url_for,
                   flash, jsonify, current_app, session)
from flask_login import login_required, current_user

from app import db, promotions
from app.models import (CreditNote, CreditNoteItem, Customer, Invoice, InvoiceItem,
                        LoyaltyTxn, Product, StockMovement)
from app.routes.pos import resolve_staff
from app.utils import day_arg, generate_number, role_required

returns_bp = Blueprint("returns", __name__)


@returns_bp.route("/")
@login_required
def index():
    """Find the bill the goods went out on."""
    q = (request.args.get("q") or "").strip()
    invoice = None
    if q:
        invoice = Invoice.query.filter_by(invoice_number=q).first()
        if not invoice and q.isdigit():
            invoice = Invoice.query.get(int(q))
        if not invoice:
            flash(f"No invoice matches '{q}'.", "warning")
        elif invoice.is_cancelled:
            flash(f"{invoice.invoice_number} was cancelled — its goods are already back "
                  "and nothing can be returned against it.", "warning")
            invoice = None
    recent = CreditNote.query.order_by(CreditNote.id.desc()).limit(10).all()
    return render_template("returns/index.html", q=q, invoice=invoice, recent=recent)


@returns_bp.route("/api/review", methods=["POST"])
@login_required
def api_review():
    """What the marked quantities would do to this bill's promotions.

    Asked by the returns screen as the boxes are filled in, so the consequence
    of taking back a qualifying garment is on screen BEFORE the credit note is
    raised — not discovered as a smaller refund after the customer has agreed a
    figure.
    """
    data = request.get_json(silent=True) or {}
    inv = Invoice.query.get(int(data.get("invoice_id") or 0))
    if inv is None:
        return jsonify({"findings": [], "clawback": 0.0})
    taking = {int(k): float(v) for k, v in (data.get("taking") or {}).items()
              if float(v or 0) > 0}
    findings = promotions.review_return(inv, taking)
    return jsonify({
        "findings": [f.to_json() for f in findings],
        "clawback": round(sum(f.clawback for f in findings), 2),
        "blocked": [f.to_json() for f in findings
                    if f.policy == "require_return" and f.kept_qty > 0],
    })


@returns_bp.route("/create", methods=["POST"])
@login_required
def create():
    """Take back some of an invoice and hand the money over."""
    invoice_id = request.form.get("invoice_id", type=int)
    inv = Invoice.query.get_or_404(invoice_id)
    if inv.is_cancelled:
        flash(f"{inv.invoice_number} was cancelled — nothing can be returned against it.", "danger")
        return redirect(url_for("returns.index", q=inv.invoice_number))

    staff = resolve_staff(request.form.get("staff_code"))
    if staff is None:
        flash("Identify the staff member handling this return first.", "danger")
        return redirect(url_for("returns.index", q=inv.invoice_number))

    # What is actually coming back, line by line.
    taking = []
    for item in inv.items:
        qty = request.form.get(f"qty_{item.id}", type=float) or 0.0
        if qty <= 0:
            continue
        if qty > item.returnable_qty:
            flash(f"{item.product.name}: only {item.returnable_qty} left to return.", "danger")
            return redirect(url_for("returns.index", q=inv.invoice_number))
        condition = request.form.get(f"cond_{item.id}") or "resellable"
        taking.append((item, qty, condition))

    if not taking:
        flash("Nothing was marked for return.", "warning")
        return redirect(url_for("returns.index", q=inv.invoice_number))

    # ---- what this does to the promotions on the bill ------------------------
    # Checked before the note is written, because one of the answers is "not
    # like this": a scheme set to `require_return` will not let the qualifying
    # purchase go back without the free item that came with it.
    marked = {item.id: qty for item, qty, _ in taking}
    findings = promotions.review_return(inv, marked)
    blocked = [f for f in findings
               if f.policy == "require_return" and f.kept_qty > 0]
    if blocked:
        for f in blocked:
            flash(f.message, "danger")
        flash("Add the free item(s) to this return, or ask a manager to change "
              "the scheme's return rule.", "warning")
        return redirect(url_for("returns.index", q=inv.invoice_number))

    # cash · card · upi hand money back; store_credit keeps it as a note the
    # customer spends on a later bill (see app/vouchers.py)
    refund_method = request.form.get("refund_method") or "cash"
    if refund_method not in ("cash", "card", "upi", "store_credit"):
        refund_method = "cash"
    note = CreditNote(
        number=generate_number("CRN", CreditNote, "number"),
        invoice_id=inv.id,
        staff_id=staff.id,
        cashier_id=current_user.id,
        refund_method=refund_method,
        reason=(request.form.get("reason") or "").strip()[:256],
        # which till's drawer a cash refund comes out of — see app/drawer.py
        counter_id=session.get("counter_id"),
    )
    db.session.add(note)
    db.session.flush()

    goods = 0.0
    tax = 0.0
    for item, qty, condition in taking:
        line_total = round(qty * item.unit_price, 2)
        line_tax = round(line_total * (item.gst_rate or 0) / 100.0, 2)

        db.session.add(CreditNoteItem(
            credit_note_id=note.id, invoice_item_id=item.id,
            product_id=item.product_id, quantity=qty,
            unit_price=item.unit_price, gst_rate=item.gst_rate,
            line_total=line_total, tax_amount=line_tax, condition=condition,
        ))

        # The goods are back in the building either way; the log says so, and a
        # damaged one is then written off in its own right.
        product = Product.query.get(item.product_id)
        product.stock_qty += qty
        db.session.add(StockMovement(
            product_id=item.product_id, change=qty, reason="return",
            reference=note.number))
        if condition == "damaged":
            product.stock_qty -= qty
            db.session.add(StockMovement(
                product_id=item.product_id, change=-qty, reason="damaged",
                reference=note.number))

        goods += line_total
        tax += line_tax

    # A discount was given against the whole bill, so it comes back in the same
    # proportion as the goods being returned.
    share = (goods / inv.subtotal) if inv.subtotal else 0.0
    discount_back = round((inv.discount or 0) * share, 2)

    note.subtotal = round(goods, 2)
    note.discount = discount_back
    if inv.is_interstate:
        note.igst = round(tax, 2)
    else:
        note.cgst = round(tax / 2, 2)
        note.sgst = round(tax / 2, 2)

    # Free goods the customer keeps but has stopped qualifying for. Taken off
    # the refund rather than left alone: the garment was given on the strength
    # of a purchase that has now been undone, and a shop that refunds the
    # purchase AND lets the free item walk has paid twice for one sale.
    #
    # It is not tax and it is not a discount, so it reduces the refund without
    # touching either — the GST reversed is the GST on the goods that actually
    # came back. Reversing tax on a free item would be reversing tax nobody
    # charged, since a reward line is billed at zero (see app/promotions.py).
    #
    # Capped at what is being refunded, so a credit note never comes out
    # negative. A return that would owe the shop money is a conversation at the
    # counter, not a document that reads like a sale — but the shortfall is said
    # out loud below rather than quietly absorbed.
    refundable = round(goods - discount_back + tax, 2)
    wanted = promotions.settle_return(note, findings, user_id=current_user.id)
    clawback = min(wanted, refundable)
    note.promo_clawback = clawback
    note.total = round(refundable - clawback, 2)

    # Loyalty: take back what this refund earned, and correct what was spent.
    customer = inv.customer
    if customer:
        earned = inv.loyalty_earned or 0
        reverse = round(earned * share, 2)
        # Never push a balance negative — points already spent are gone, and a
        # customer should not owe the shop loyalty.
        reverse = min(reverse, customer.loyalty_points or 0)
        if reverse > 0:
            customer.loyalty_points = round((customer.loyalty_points or 0) - reverse, 2)
            note.loyalty_reversed = reverse
            db.session.add(LoyaltyTxn(
                customer_id=customer.id, points=-reverse,
                reason=f"return {note.number}", invoice_id=inv.id))
        customer.total_spent = round(max(0.0, (customer.total_spent or 0) - note.total), 2)

    db.session.commit()
    if note.refund_method == "store_credit":
        flash(f"Return recorded — {note.number} for {note.total:.2f} kept as store credit. "
              "The customer spends it at the counter under Credit note.", "success")
    else:
        flash(f"Return recorded — {note.number}, {note.total:.2f} refunded.", "success")
    for f in findings:
        if f.unearned_qty > 0:
            flash(f.message, "warning")
    if wanted > clawback:
        flash(f"₹{wanted - clawback:.2f} of free goods could not be recovered "
              f"from this refund — the return was worth less than the promotion "
              f"it broke.", "warning")
    return redirect(url_for("returns.view_note", nid=note.id))


@returns_bp.route("/<int:nid>")
@login_required
def view_note(nid):
    note = CreditNote.query.get_or_404(nid)
    return render_template("returns/note.html", note=note)


@returns_bp.route("/<int:nid>/print")
@login_required
def print_note(nid):
    note = CreditNote.query.get_or_404(nid)
    return render_template("returns/note.html", note=note, print_mode=True)


@returns_bp.route("/list")
@login_required
@role_required("admin", "manager")
def list_notes():
    from sqlalchemy.orm import joinedload
    # each row prints its bill, the bill's customer, and two people — read
    # with the rows rather than four queries per credit note
    from sqlalchemy import or_
    # Search (note number, bill number, customer) and a date range — the list
    # stops at 200, so without them an older note could not be reached at all.
    q = (request.args.get("q") or "").strip()
    d_from, d_to = day_arg("from"), day_arg("to")
    query = CreditNote.query
    if q:
        like = f"%{q}%"
        query = (query.join(Invoice, CreditNote.invoice_id == Invoice.id)
                 .outerjoin(Customer, Invoice.customer_id == Customer.id)
                 .filter(or_(CreditNote.number.ilike(like), Invoice.invoice_number.ilike(like),
                             Customer.name.ilike(like), Customer.phone.ilike(like))))
    if d_from:
        query = query.filter(CreditNote.created_at >= datetime.combine(d_from, datetime.min.time()))
    if d_to:
        query = query.filter(CreditNote.created_at < datetime.combine(d_to, datetime.max.time()))
    notes = (query.options(
                joinedload(CreditNote.invoice).joinedload(Invoice.customer),
                joinedload(CreditNote.invoice).joinedload(Invoice.staff),
                joinedload(CreditNote.invoice).joinedload(Invoice.cashier),
                joinedload(CreditNote.staff))
             .order_by(CreditNote.id.desc()).limit(200).all())
    total = sum(n.total for n in notes)
    return render_template("returns/list.html", notes=notes, total=total, q=q,
                           d_from=d_from, d_to=d_to, filtered=bool(q or d_from or d_to))
