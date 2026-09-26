"""Delivery — handing the goods over, against the bill they were paid on.

Billing and collection are two desks. The till took the money and took the stock
off the shelf; nothing until now recorded whether the customer actually left with
the garments. That gap is where a shop loses pieces and where "I paid for three
and got two" has no answer either way.

So this module moves NO stock and NO money — the sale did both, and a delivery
that adjusted either would be undoing a sale that plainly happened. What it
records is custody, the way `alterations.py` does: which bills, which pieces,
verified against the tag on each garment, handed over by a named person.

Three things about the shape are deliberate.

**One delivery, several bills.** A customer billed at two counters leaves with
one bundle, and the handover is the bundle. `DeliveryBill` is what makes the
left-hand list on the screen a list. The reference ERP scans a *settlement
number* here; this shop has no settlement document, and minting an empty one to
hold a number would be a record that never says anything. The delivery IS the
settlement.

**Part collection is a first-class answer, not a failure.** Two of five going
home while three wait for an alteration is the ordinary Saturday, so a delivery
saves what actually went out and the bill stays open for the balance. Anything
else forces the counter to choose between a lie and no record at all.

**A scan is the verification, and an override is visible.** Ordinary staff must
read a tag for every piece. A manager may pass one by hand — a label torn off in
a bag is real — and that costs a reason, their name and a line on the delivery
note. An override anyone could give is a scan that has quietly become optional,
and the verified count then means nothing.
"""
from datetime import datetime, timedelta

from flask import Blueprint, render_template, request, jsonify, session
from flask_login import login_required, current_user
from sqlalchemy import or_

from app import db, places, warehouse_items
from app.models import (Customer, Delivery, DeliveryBill, DeliveryLine,
                        DeliveryScan, Invoice, InvoiceItem)
from app.routes.pos import POST_KEYS, resolve_staff
from app.utils import day_arg, generate_number

delivery_bp = Blueprint("delivery", __name__)

#: How many of a customer's open bills a card or phone scan pulls in. A regular
#: has years of history and almost none of it is uncollected; the cap keeps one
#: scan from dragging the lot onto the screen.
CUSTOMER_BILL_LIMIT = 20

#: Quantities are compared to three decimals everywhere in this shop (fabric is
#: sold by the metre), so "did this line balance" needs a tolerance rather than ==.
QTY_TOLERANCE = 0.001


def _place():
    """(company, location, counter) for the desk doing the handing over.

    The same session keys the billing counter uses, so a desk configured once is
    configured for both — and read through `places.resolve`, so a counter that
    belongs to another branch is dropped rather than shown.

    The floor `resolve` also returns is dropped here. A handover happens where
    the customer is standing and moves neither stock nor money, so which storey
    it was on decides nothing — unlike a bill, whose number comes from it.
    """
    company, location, _floor, counter = places.resolve(
        *(session.get(k) for k in POST_KEYS))
    return company, location, counter


def resolve_tag(code):
    """The shop product a delivery scan means, without asking the warehouse.

    `warehouse_items.resolve_scan` is the shop's one scan entry point and this
    calls it first, but with `allow_import=False` — unlike the billing counter.
    The till pulls an unknown item in because a tag that exists must be sellable;
    a delivery desk is only ever verifying goods that are already on a bill in
    front of it, so a code the shop has never seen cannot be on that bill, and
    importing it would add a catalogue row for a mis-scan.

    That leaves one gap this closes. A bare per-piece code — `ESSA-00002-007`
    off an individual garment — is not a SKU, not a barcode and not a QR
    payload, so the shop's own tables do not hold it; `resolve_scan` finds it
    only by querying the warehouse's `product_units`, which is exactly what
    switching imports off gives up. Since a piece code IS its SKU with a
    sequence appended, the SKU is recoverable from the code itself, and the
    delivery desk then reads piece tags with no warehouse attached at all —
    which is the same standard the till already holds itself to.
    """
    product = warehouse_items.resolve_scan(code, allow_import=False)
    if product is not None:
        return product
    stem, sep, tail = str(code or "").strip().rpartition("-")
    if sep and stem and tail.isdigit():
        return warehouse_items.resolve_scan(stem, allow_import=False)
    return None


def piece_of(code, product):
    """The individual garment a scan identifies, or None if the tag names no one.

    The distinction this draws is the whole of the double-scan guard. A warehouse
    SKU tag (`E1|…`, or a bare SKU) is printed identically on every piece of that
    item, so reading it three times for a line of three is three garments and
    entirely correct. A per-piece tag (`EU1|…`, or a bare `ESSA-00002-007`) names
    one physical garment, so reading it twice is the same garment passing the
    counter twice — which is exactly how a short delivery gets signed off as
    complete.

    The bare form is recognised by asking the product it resolved to, rather than
    by pattern-matching a code shape: a piece code is its product's SKU with a
    sequence on the end, and comparing against the SKU we already have in hand is
    exact where a regex would be a guess about how codes are spelled.
    """
    payload = warehouse_items.parse_payload(code)
    if payload and payload.get("unit_code"):
        return payload["unit_code"]
    raw = str(code or "").strip()
    sku = (getattr(product, "sku", "") or "")
    if sku and raw.upper().startswith(sku.upper() + "-"):
        tail = raw[len(sku) + 1:]
        if tail.isdigit():
            return raw
    return None


def _pieces_already_out(item_ids):
    """{invoice_item_id: {piece codes already delivered}}.

    Scoped to the invoice line rather than to the garment everywhere, because a
    piece that came back on a credit note and was sold again is legitimately
    delivered a second time. What must not happen twice is one line's own piece
    satisfying that line twice.
    """
    out = {}
    if not item_ids:
        return out
    rows = (db.session.query(DeliveryLine.invoice_item_id, DeliveryScan.piece_code)
            .join(DeliveryScan, DeliveryScan.delivery_line_id == DeliveryLine.id)
            .filter(DeliveryLine.invoice_item_id.in_(list(item_ids)),
                    DeliveryScan.piece_code.isnot(None)).all())
    for item_id, piece in rows:
        out.setdefault(item_id, set()).add(piece)
    return out


def _bill_payload(inv, used):
    """One bill as the screen draws it — the row on the left, the lines on the right."""
    lines = []
    for item in inv.items:
        # A line with nothing left to collect is still SENT, greyed out on the
        # screen rather than dropped: a bill that shows three of its five lines
        # looks like a bill that has lost two.
        lines.append({
            "invoice_item_id": item.id,
            "invoice_id": inv.id,
            "bill_no": inv.invoice_number,
            "product_id": item.product_id,
            "name": item.product.name if item.product else "",
            "sku": item.product.sku if item.product else "",
            # What is printed on the garment, which is the column the counter
            # reads across when a scan does not land where they expected.
            "barcode": (item.product.barcode or item.product.sku) if item.product else "",
            "unit": item.product.unit if item.product else "pcs",
            "rate": round(item.unit_price or 0, 2),
            "qty": item.quantity,
            "delivered": item.delivered_qty,
            "returned": item.returned_qty,
            "pending": item.pending_qty,
        })
    return {
        "invoice_id": inv.id,
        "bill_no": inv.invoice_number,
        "date": inv.invoice_date.strftime("%d-%m-%Y") if inv.invoice_date else "",
        "customer": {
            "id": inv.customer.id if inv.customer else None,
            "name": inv.customer.name if inv.customer else "Walk-in customer",
            "phone": (inv.customer.phone or "") if inv.customer else "",
        },
        "qty": inv.total_qty,
        "pending": inv.pending_qty,
        "amount": round(inv.total or 0, 2),
        "status": inv.delivery_status,
        "lines": lines,
        # Per line, so the screen can refuse a repeat the moment it is read
        # rather than at save. The server checks again on create — this copy is
        # for the beep, not for the rule.
        "used_pieces": {str(i.id): sorted(used.get(i.id, set())) for i in inv.items},
    }


def _find_bills(code):
    """The bills a scan at the delivery desk means, newest first.

    Ordered so the most specific reading wins: a bill number is one bill and can
    only be that, a membership card is one customer, and a phone number is tried
    before a bare id because a ten-digit number is far more often a phone than an
    invoice's primary key.
    """
    text = str(code or "").strip()
    if not text:
        return [], None

    inv = Invoice.query.filter_by(invoice_number=text).first()
    if not inv:
        # Scanners and people both drop the case and the padding of a printed
        # number; the bill is the same bill either way.
        inv = Invoice.query.filter(Invoice.invoice_number.ilike(text)).first()
    if inv:
        return [inv], inv.customer

    customer = None
    upper = text.upper()
    if upper.startswith("CUST") and upper[4:].isdigit():
        customer = db.session.get(Customer, int(upper[4:]))
    if customer is None:
        customer = Customer.query.filter_by(phone=text).first()
    if customer is None and text.isdigit():
        inv = db.session.get(Invoice, int(text))
        if inv:
            return [inv], inv.customer
        return [], None
    if customer is None:
        return [], None

    # Everything this customer has paid for and not yet carried out. A bill they
    # already collected is not offered: it is done, and putting it on the screen
    # invites it being handed over a second time.
    recent = (Invoice.query.filter_by(customer_id=customer.id)
              .order_by(Invoice.invoice_date.desc()).limit(100).all())
    return [i for i in recent if i.pending_qty > 0][:CUSTOMER_BILL_LIMIT], customer


@delivery_bp.route("/")
@login_required
def index():
    """The delivery desk. Scan a bill, then scan the goods out against it."""
    company, location, counter = _place()
    return render_template("delivery/index.html",
                           chosen_company=company, chosen_location=location,
                           chosen_counter=counter,
                           places=places.picker_options(),
                           today=datetime.now().strftime("%d-%m-%Y"),
                           is_manager=current_user.is_manager)


@delivery_bp.route("/api/bill")
@login_required
def api_bill():
    """Resolve a scanned bill number, membership card or phone to bill(s)."""
    bills, customer = _find_bills(request.args.get("code", ""))
    if not bills:
        return jsonify({"error": "No bill or customer matches that code"}), 404
    used = _pieces_already_out([i.id for inv in bills for i in inv.items])
    return jsonify({
        "customer": {"id": customer.id, "name": customer.name,
                     "phone": customer.phone or ""} if customer else None,
        "bills": [_bill_payload(inv, used) for inv in bills],
    })


@delivery_bp.route("/api/scan")
@login_required
def api_scan():
    """Resolve a garment tag to the product it is, and the piece it is if any."""
    code = (request.args.get("code") or "").strip()
    product = resolve_tag(code)
    if not product:
        return jsonify({"error": "Nothing in this shop matches that tag"}), 404
    return jsonify({
        "product_id": product.id, "sku": product.sku,
        "barcode": product.barcode or product.sku, "name": product.name,
        "piece_code": piece_of(code, product),
    })


@delivery_bp.route("/create", methods=["POST"])
@login_required
def create():
    """Record the handover.

    Everything is re-checked here against the database, not trusted from the
    screen: the quantities the screen showed were true when the bill was scanned,
    and a second desk may have delivered against the same bill in the meantime.
    """
    data = request.get_json(silent=True) or request.form

    staff = resolve_staff(data.get("staff_code") or data.get("staff_id"))
    if staff is None:
        return jsonify({"error": "Identify the staff member handing the goods "
                                 "over — scan the ID card or enter the staff code."}), 400

    raw_lines = data.get("lines") or []
    if isinstance(raw_lines, str):
        import json
        raw_lines = json.loads(raw_lines or "[]")

    # Load every line first, so a delivery is refused whole rather than written
    # halfway and rolled back after some of it has been checked.
    wanted = []
    for row in raw_lines:
        try:
            item_id = int(row.get("invoice_item_id"))
            qty = round(float(row.get("quantity") or 0), 3)
        except (TypeError, ValueError):
            return jsonify({"error": "A line came through with no item or quantity"}), 400
        if qty <= 0:
            continue                      # a line nobody collected is not a line
        scans = [str(s).strip() for s in (row.get("scans") or []) if str(s).strip()]
        wanted.append((item_id, qty, scans,
                       (row.get("override_reason") or "").strip()[:256]))

    if not wanted:
        return jsonify({"error": "Nothing was scanned — there is no delivery to record."}), 400

    # One entry per invoice line. Each is checked against that line's own
    # remaining balance, so two entries for the same line would each be measured
    # against the whole of it and together hand over twice what is owed. The
    # screen keys its lines by id and cannot send a repeat; a client that does is
    # refused rather than quietly summed.
    seen_items = set()
    for item_id, *_ in wanted:
        if item_id in seen_items:
            return jsonify({"error": "The same invoice line came through twice."}), 400
        seen_items.add(item_id)

    items = {i.id: i for i in InvoiceItem.query
             .filter(InvoiceItem.id.in_([w[0] for w in wanted])).all()}
    missing = [w[0] for w in wanted if w[0] not in items]
    if missing:
        return jsonify({"error": f"Invoice line {missing[0]} no longer exists"}), 400

    already = _pieces_already_out(items.keys())
    seen_pieces = set()
    override_total = 0.0
    prepared = []

    for item_id, qty, scans, reason in wanted:
        item = items[item_id]
        pending = item.pending_qty
        if qty > pending + QTY_TOLERANCE:
            name = item.product.name if item.product else f"line {item_id}"
            return jsonify({
                "error": f"{name}: only {pending:g} left to collect on "
                         f"{item.invoice.invoice_number}, not {qty:g}. "
                         f"Re-scan the bill — someone may have delivered against "
                         f"it since this screen was opened."}), 400

        # Every tag is re-resolved here rather than trusted as matched. The screen
        # decided which line a scan belonged to; if that decision were taken on
        # faith, any garment in the shop could verify any line and the scan would
        # be a gesture rather than a check.
        accepted = []
        for code in scans:
            product = resolve_tag(code)
            if product is None:
                return jsonify({"error": f"“{code}” does not match anything in "
                                         f"this shop."}), 400
            if product.id != item.product_id:
                want = item.product.name if item.product else "this line"
                return jsonify({
                    "error": f"“{code}” is {product.name}, which is not {want}. "
                             f"That tag belongs to a different line."}), 400
            # A piece may satisfy its line once — checked against what this
            # delivery has already used AND against every earlier one.
            piece = piece_of(code, product)
            if piece:
                if piece in seen_pieces or piece in already.get(item_id, set()):
                    return jsonify({
                        "error": f"{piece} has already been handed over. "
                                 f"That is one garment, and it cannot go out twice."}), 400
                seen_pieces.add(piece)
            accepted.append((code, piece))

        if len(accepted) > qty + QTY_TOLERANCE:
            name = item.product.name if item.product else f"line {item_id}"
            return jsonify({
                "error": f"{name}: {len(accepted)} tags read against {qty:g} "
                         f"being collected."}), 400

        scanned = float(len(accepted))
        short = round(qty - scanned, 3)
        if short > QTY_TOLERANCE:
            if not current_user.is_manager:
                name = item.product.name if item.product else f"line {item_id}"
                return jsonify({
                    "error": f"{name}: {short:g} piece(s) not scanned. Scan every "
                             f"garment, or ask a manager to pass it by hand."}), 403
            if not reason:
                return jsonify({
                    "error": "Passing a piece without a scan needs a reason on it."}), 400
            override_total += short

        prepared.append((item, qty, scanned, accepted, reason if short > QTY_TOLERANCE else ""))

    company, location, counter = _place()
    if company is None:
        company = places.default_company()

    # Whose goods these are. Taken from the bills rather than asked for: they all
    # belong to one person by definition, and a walk-in simply has none.
    invoices = {item.invoice_id: item.invoice for item, *_ in prepared}
    customer_ids = {inv.customer_id for inv in invoices.values() if inv.customer_id}

    note = Delivery(
        number=generate_number("DLV", Delivery, "number"),
        customer_id=customer_ids.pop() if len(customer_ids) == 1 else None,
        staff_id=staff.id,
        cashier_id=current_user.id,
        company_id=company.id if company else None,
        location_id=location.id if location else None,
        counter_id=counter.id if counter else None,
        notes=(data.get("notes") or "").strip()[:256],
    )
    db.session.add(note)
    db.session.flush()

    for invoice_id in invoices:
        db.session.add(DeliveryBill(delivery_id=note.id, invoice_id=invoice_id))

    for item, qty, scanned, accepted, reason in prepared:
        line = DeliveryLine(
            delivery_id=note.id, invoice_item_id=item.id,
            product_id=item.product_id, quantity=qty, scanned=scanned,
            override_reason=reason or None,
            overridden_by_id=current_user.id if reason else None,
        )
        db.session.add(line)
        db.session.flush()
        for code, piece in accepted:
            db.session.add(DeliveryScan(delivery_line_id=line.id,
                                        code=code, piece_code=piece))

    db.session.commit()
    still = round(sum(inv.pending_qty for inv in invoices.values()), 3)
    return jsonify({
        "success": True, "delivery_id": note.id, "number": note.number,
        "qty": note.total_qty, "overridden": override_total,
        # What is still owed on these bills, so the desk can say it out loud
        # rather than the customer discovering it in the car park.
        "pending": still,
    })


@delivery_bp.route("/<int:did>")
@login_required
def view(did):
    note = Delivery.query.get_or_404(did)
    return render_template("delivery/note.html", note=note, print_mode=False)


@delivery_bp.route("/<int:did>/print")
@login_required
def print_note(did):
    note = Delivery.query.get_or_404(did)
    return render_template("delivery/note.html", note=note, print_mode=True)


@delivery_bp.route("/list")
@login_required
def list_deliveries():
    """Every handover, newest first."""
    q = (request.args.get("q") or "").strip()
    d_from, d_to = day_arg("from"), day_arg("to")
    query = Delivery.query
    if q:
        like = f"%{q}%"
        query = query.outerjoin(Customer, Delivery.customer_id == Customer.id) \
            .filter(or_(Delivery.number.ilike(like), Customer.name.ilike(like),
                        Customer.phone.ilike(like)))
    # a date range too — the list stops at 300, so an older handover needs one
    if d_from:
        query = query.filter(Delivery.created_at >= datetime.combine(d_from, datetime.min.time()))
    if d_to:
        query = query.filter(Delivery.created_at < datetime.combine(d_to, datetime.max.time()))
    # Everything each row prints, read with the rows: its customer, its staff,
    # its bills' numbers and its lines (with the bill line that prices them).
    # Row by row that was several queries per delivery — 14 s for 300 on a store
    # with 700k handovers.
    from sqlalchemy.orm import joinedload, selectinload
    notes = (query.options(joinedload(Delivery.customer), joinedload(Delivery.staff),
                           selectinload(Delivery.bills).joinedload(DeliveryBill.invoice),
                           selectinload(Delivery.lines).joinedload(DeliveryLine.invoice_item))
             .order_by(Delivery.id.desc()).limit(300).all())
    return render_template("delivery/list.html", notes=notes, q=q, d_from=d_from, d_to=d_to,
                           filtered=bool(q or d_from or d_to))


@delivery_bp.route("/pending")
@login_required
def pending():
    """Bills with goods the customer has paid for and not yet carried out.

    The reason part delivery is allowed to exist. Without this list a balance
    left behind is a fact known only to the person who was on the desk that
    afternoon, and the goods sit in a bag behind the counter until somebody asks.

    Bills are read newest-first and filtered in Python because what is owed is
    derived — from delivery lines and credit notes both — and is not a column SQL
    can filter on. The window is capped for the same reason.
    """
    days = request.args.get("days", type=int) or 30
    since = datetime.utcnow() - timedelta(days=days)
    recent = (Invoice.query.filter(Invoice.invoice_date >= since)
              .order_by(Invoice.invoice_date.desc()).limit(1000).all())
    rows = [inv for inv in recent if inv.pending_qty > 0]
    return render_template("delivery/pending.html", rows=rows, days=days,
                           owed=round(sum(i.pending_qty for i in rows), 3))
