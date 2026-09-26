from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict
from sqlalchemy import func
from sqlalchemy.orm import Session
from ..database import get_db
from .. import models
from ..services import outward as svc
from ..services import stock_locations as stock_loc
from ..services import stock_view
from ..services import scope
from ..services import dates as date_svc

router = APIRouter(prefix="/api/outward", tags=["stock-outward"])


class OutwardLineIn(BaseModel):
    product_id: Optional[int] = None
    barcode: Optional[str] = None
    qty: float
    accepted_qty: Optional[float] = None


class OutwardIn(BaseModel):
    date: Optional[str] = None
    # Where it leaves from, and where it goes. `to_warehouse_id` makes this a
    # warehouse-to-warehouse transfer that ARRIVES when it is received;
    # `to_store_id` dispatches to a shop, whose own database owns it from there.
    # `to_destination` alone still works and is matched to a known place by name.
    from_warehouse_id: Optional[int] = None
    to_warehouse_id: Optional[int] = None
    to_store_id: Optional[int] = None
    to_destination: Optional[str] = None
    packed_by: Optional[str] = None
    received_by: Optional[str] = None
    from_location: Optional[str] = "WAREHOUSE"
    lines: List[OutwardLineIn] = []


class ReceiveIn(BaseModel):
    """The Stock Inward side: who took the goods in, and how many of each line
    they accepted. Lines left out are accepted in full."""
    received_by: Optional[str] = None
    date: Optional[str] = None
    accepted: Optional[Dict[int, float]] = None      # outward_line_id -> qty


def _line_out(l, db: Session):
    prod = l.product
    # What is on hand AT THE SOURCE — the only figure that answers "can I send
    # this". The company total is shown beside it so a picker who is short can
    # see the goods exist somewhere rather than concluding they are out of stock.
    from ..services import stock_locations as stock_loc
    src = l.outward.from_warehouse_id if l.outward else None
    here = stock_loc.qty_at(db, prod.id, src) if (prod and src) else None
    return {
        "id": l.id, "product_id": l.product_id, "barcode": l.barcode,
        "description": l.description, "qty": l.qty,
        "accepted_qty": l.accepted_qty, "short_qty": l.short_qty,
        "rate": l.rate,
        "stock_on_hand": here if here is not None else (prod.stock_qty if prod else None),
        "stock_company_wide": prod.stock_qty if prod else None,
        "stock_by_warehouse": stock_loc.balances_for(db, prod.id) if prod else [],
        "value": round(float(l.qty or 0) * float(l.rate or 0), 2),
        # The whole product record — QR, name, size, colour, batch and the rest.
        # A dispatch or an acceptance is someone matching a row against a garment
        # in their hand; a barcode and a description cannot settle that, because
        # four sizes of one style share both.
        "product": stock_view.product_card(db, prod) if prod else None,
    }


def _totals(o):
    """(line_count, total_qty, accepted_qty, shortfall) off the note's own lines —
    the model's properties, for one note."""
    return len(o.lines), o.total_qty, o.total_accepted, o.shortfall


def _totals_by_note(db: Session, q):
    """The list's figures for every note `q` selects, in one grouped query rather
    than a lazy load of each note's lines — see stock_locations.outward_line_totals."""
    return stock_loc.outward_line_totals(db, q)


def _out(o, db: Session = None, with_lines=False, totals=None):
    if totals is None:
        n, sent, accepted, short = _totals(o)
    else:
        n, sent, acc = totals.get(o.id, (0, 0.0, 0.0))
        received = o.status == "received"
        accepted = acc if received else 0.0
        short = round(sent - acc, 3) if received else 0.0
    d = {"id": o.id, "code": o.code, "date": o.date, "to_destination": o.to_destination,
         "from_company": o.from_company, "from_location": o.from_location,
         "from_warehouse_id": o.from_warehouse_id,
         "from_warehouse": o.from_warehouse.name if o.from_warehouse else None,
         "to_warehouse_id": o.to_warehouse_id,
         "to_warehouse": o.to_warehouse.name if o.to_warehouse else None,
         "to_store_id": o.to_store_id,
         "to_store": o.to_store.name if o.to_store else None,
         # What KIND of movement this is, said once here rather than re-derived
         # on every screen that has to draw it differently.
         "kind": ("transfer" if o.to_warehouse_id else
                  "store" if o.to_store_id else "dispatch"),
         "is_transfer": o.is_transfer,
         "packed_by": o.packed_by, "received_by": o.received_by,
         "received_date": o.received_date, "status": o.status,
         "total_qty": sent, "accepted_qty": accepted,
         "shortfall": short, "line_count": n,
         "created_at": o.created_at.isoformat() if o.created_at else None,
         "posted_at": o.posted_at.isoformat() if o.posted_at else None,
         "received_at": o.received_at.isoformat() if o.received_at else None}
    if with_lines:
        d["lines"] = [_line_out(l, db) for l in o.lines]
    return d


def _get(oid: int, db: Session):
    o = db.get(models.StockOutward, oid)
    if not o:
        raise HTTPException(404, "outward not found")
    return o


@router.get("")
def list_outwards(status: str = "all", kind: str = "all",
                  limit: Optional[int] = None, offset: int = 0, q: str = "",
                  date_from: str = "", date_to: str = "",
                  db: Session = Depends(get_db),
                  warehouse_id: Optional[int] = Depends(scope.current)):
    """`status` filters the list: draft | posted | received. 'posted' is what the
    Stock Inward screen wants — dispatched, not yet accepted anywhere.

    `kind` narrows it to transfer (warehouse → warehouse), store, or dispatch.
    `warehouse_id` returns the notes that concern one building — sent from it OR
    coming to it, because both are that warehouse's business and making the
    screen ask twice is how the inbound half gets forgotten.

    Without `limit`, every matching note as a list. With it, one page:
    `{rows, total, counts}` — `q` searches destination, code and status, `total`
    is how many match, `counts` are per status for the chips (ignoring `status`
    and `q`, so every chip keeps its number while one is selected).
    `date_from` / `date_to` narrow the paged form to the dispatch date,
    inclusive — dates are stored ISO, so the range is a string comparison."""
    SO = models.StockOutward
    base = db.query(SO)
    if kind == "transfer":
        base = base.filter(SO.to_warehouse_id.isnot(None))
    elif kind == "store":
        base = base.filter(SO.to_store_id.isnot(None))
    elif kind == "dispatch":
        base = base.filter(SO.to_warehouse_id.is_(None), SO.to_store_id.is_(None))
    # Sent from here OR coming to here — both are this warehouse's business, and
    # filtering to the source alone is what makes an arriving transfer invisible
    # at the branch that has to count it in.
    base = scope.outwards(base, warehouse_id)
    filtered = base.filter(SO.status == status) if status and status != "all" else base

    if limit is None:
        totals = _totals_by_note(db, filtered)
        return [_out(o, totals=totals) for o in filtered.order_by(SO.id.desc()).all()]

    term = (q or "").strip()
    if term:
        like = f"%{term}%"
        filtered = filtered.filter(SO.to_destination.ilike(like) | SO.code.ilike(like)
                                   | SO.status.ilike(like))
    lo, hi = date_svc.to_iso(date_from), date_svc.to_iso(date_to)
    if lo or hi:
        # a note with no date is in no date range — and '' sorts before every
        # date, so without this it would match any "up to" bound
        filtered = filtered.filter(SO.date.isnot(None), SO.date != "")
    if lo:
        filtered = filtered.filter(SO.date >= lo)
    if hi:
        filtered = filtered.filter(SO.date <= hi)
    counts = dict(base.with_entities(SO.status, func.count(SO.id)).group_by(SO.status).all())
    counts["all"] = sum(counts.values())
    total = filtered.count()
    page = filtered.order_by(SO.id.desc()).offset(max(0, offset))
    if limit > 0:
        page = page.limit(limit)
    notes = page.all()
    totals = _totals_by_note(db, db.query(SO).filter(SO.id.in_([o.id for o in notes])))
    return {"rows": [_out(o, totals=totals) for o in notes], "total": total, "counts": counts}


@router.post("")
def create_outward(body: OutwardIn, db: Session = Depends(get_db)):
    try:
        o = svc.create_outward(db, body.model_dump())
    except ValueError as exc:
        db.rollback()
        raise HTTPException(400, str(exc))
    db.commit(); db.refresh(o)
    return _out(o, db, with_lines=True)


@router.get("/{oid}")
def get_outward(oid: int, db: Session = Depends(get_db)):
    return _out(_get(oid, db), db, with_lines=True)


@router.post("/{oid}/post")
def post_outward(oid: int, allow_negative: bool = False, db: Session = Depends(get_db)):
    o = _get(oid, db)
    res = svc.post_outward(db, o, allow_negative=allow_negative)
    if not res.get("ok"):
        db.rollback()
        raise HTTPException(400, res)
    db.commit()
    return res


@router.post("/{oid}/receive")
def receive_outward(oid: int, body: ReceiveIn, db: Session = Depends(get_db)):
    """Stock Inward — accept a dispatched transfer at the destination.

    Records the accepted quantity per line against the same document, so a short
    delivery is the difference between two columns rather than a second piece of
    paper nobody reconciles."""
    o = _get(oid, db)
    res = svc.receive_outward(db, o, accepted=body.accepted,
                              received_by=body.received_by, date=body.date)
    if not res.get("ok"):
        db.rollback()
        raise HTTPException(400, res.get("error"))
    db.commit()
    return res


@router.get("/{oid}/verify")
def verify_scan(oid: int, code: str, db: Session = Depends(get_db)):
    """Check a scanned garment against this transfer — is it on the note, and
    which line? Used by both ends: packing it out and counting it in."""
    o = _get(oid, db)
    res = svc.verify_code(db, o, code)
    if not res.get("ok"):
        raise HTTPException(404, res.get("error"))
    product = db.get(models.Product, res["product_id"])
    res["product"] = stock_view.product_card(db, product)
    return res
