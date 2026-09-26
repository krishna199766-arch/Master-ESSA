import os
import copy
import hashlib
import datetime as dt
from typing import List, Optional
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..database import get_db
from .. import models
from ..config import UPLOAD_DIR, COMPANY_GSTIN
from ..extraction import engine
from ..extraction.base import empty_invoice
from ..services import storage
from ..services import scope
from ..schemas import ConfirmRequest

router = APIRouter(prefix="/api/documents", tags=["documents"])


def _profile_dict(profile: models.SupplierProfile):
    if not profile:
        return None
    return {
        "template_key": profile.template_key,
        "default_tax_rates": profile.default_tax_rates or {},
        "tax_mode": profile.tax_mode,
        "has_tds": profile.has_tds,
        "uom_default": profile.uom_default,
        "column_map": profile.column_map or {},
        "reference_example": profile.reference_example or {},
    }


def _page_refs(doc: models.Document) -> List[str]:
    """Every stored page of this document, in order, first page first.

    `pages` is NULL on everything uploaded before a document could have more
    than one — and on the LR register's own documents, which never set it — so
    an empty list means "just stored_path", not "no pages". A manual entry has
    neither and is legitimately empty.

    One place, because the answer was previously spelled `doc.pages or
    [doc.stored_path]` at each call site and the image route did not spell it at
    all: it read stored_path directly, which is why the second page of a merged
    invoice could be sent to the extractor but never looked at.
    """
    refs = list(doc.pages or ([doc.stored_path] if doc.stored_path else []))
    return [r for r in refs if r]


class PagesMissing(RuntimeError):
    """The stored file behind one or more pages no longer resolves.

    Its own type because the answer to it is nothing like the answer to a bad
    photograph or an unreachable API. Nothing can be read, re-reading will not
    help, and the fix is on the server rather than on the invoice — so it is
    reported in those words instead of arriving as an empty invoice at 3%.
    """


def _doc_out(doc: models.Document):
    ex = doc.latest_extraction
    data = ex.data if ex else {}
    return {
        "id": doc.id,
        "filename": doc.filename,
        "status": doc.status,
        "supplier_id": doc.supplier_id,
        "supplier_name": doc.supplier.name if doc.supplier else (data.get("supplier", {}) or {}).get("name"),
        "grand_total": (data.get("totals", {}) or {}).get("grand_total"),
        "invoice_number": (data.get("invoice", {}) or {}).get("number"),
        "confidence": ex.confidence if ex else None,
        "uploaded_at": doc.uploaded_at.isoformat() if doc.uploaded_at else None,
        # The viewer hangs this off the image URL. Document ids are recycled —
        # "Clear all" empties the table and the next upload takes id 1 again — so
        # a URL built from the id alone can be answered from cache with the file
        # that used to live at that id. The hash changes when the bytes do, which
        # is the only thing that makes the URL mean one specific image.
        "content_hash": doc.content_hash,
        # Whether there is a photograph behind this row at all. A manually keyed
        # invoice has none, and the reviewer must not point an <img> at a route
        # that is going to 404 — a broken-image icon where the bill should be
        # reads as "the scan failed to load", which is a different and much more
        # alarming thing than "this one was typed in".
        "has_image": bool(doc.stored_path),
        # How many photographs are behind this row. One for an ordinary upload;
        # two or more for a bill photographed a page at a time and then merged.
        # The viewer needs it to offer the other pages — without it the merge
        # joined the pages in the database, sent them all to the extractor, and
        # still showed only page one, which reads as the merge having done
        # nothing at all.
        "page_count": len(_page_refs(doc)),
    }


@router.get("")
def list_documents(db: Session = Depends(get_db),
                   wid: Optional[int] = Depends(scope.current)):
    """The invoice queue for the warehouse this call is being made inside.

    Bills with no warehouse — everything keyed before workspaces existed — stay
    on every queue rather than disappearing from all of them. See services/scope.

    Invoices only. The LR register pages and purchase-order sheets read on their
    own screens are stored as Documents too, and listing them here put transport
    photographs in the invoice queue as bills with no number and no total. NULL
    is the type of every row that predates the column, and those were invoices.
    """
    q = db.query(models.Document).filter(or_(
        models.Document.document_type == "invoice",
        models.Document.document_type.is_(None)))
    q = scope.documents(q, wid)
    docs = q.order_by(models.Document.id.desc()).all()
    return [_doc_out(d) for d in docs]


@router.delete("/clear-all")
def clear_all(wipe_masters: bool = False, db: Session = Depends(get_db)):
    """Wipe all operational data (documents, extractions, LR entries, GRNs,
    inventory, outwards, returns, payments) for a clean slate. Deletes children
    before parents. By default KEEPS suppliers + trained profiles and the
    category master. Pass wipe_masters=true for a fully empty test database
    (also clears suppliers, profiles, agents, transporters — categories stay)."""
    # Every table is emptied with a BULK delete, which is fast but does not load
    # rows — so SQLAlchemy's `cascade="all, delete-orphan"` never fires and each
    # child has to be listed here explicitly. Anything hanging off Product or
    # PurchaseLine that is missing from this list survives the wipe as orphan rows,
    # and because ids restart afterwards it is then silently adopted by whatever
    # new row lands on the same id: piece codes reappearing under an unrelated
    # product, cartons pointing at lines that no longer exist. Add new child
    # tables here at the same time as you add them to models.py.
    order = [
        models.PaymentAllocation, models.Payment,
        models.PurchaseReturnLine, models.PurchaseReturn,
        models.StockOutwardLine, models.StockOutward,
        models.StockMovement,
        models.ProductUnit,                       # per-piece codes (Product child)
        models.Bundle,                            # carton labels (PurchaseLine child)
        models.GrnShortage,                       # billed-but-not-received
        models.PurchaseLineSplit, models.PurchaseLine, models.Purchase,
        models.LREntry,
        models.LineItem, models.Extraction, models.Document,
        models.Product,
    ]
    if wipe_masters:
        order += [models.SupplierProfile, models.Supplier, models.Agent, models.Transport]
    counts = {}
    for M in order:
        counts[M.__tablename__] = db.query(M).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "cleared": counts,
            "kept": "category master" + ("" if wipe_masters else " + suppliers + trained profiles")}


@router.delete("/{doc_id}")
def delete_document(doc_id: int, db: Session = Depends(get_db)):
    """Delete a single document and its extractions/line-items, plus any DRAFT
    GRN built from it. Blocks if its GRN is already posted to inventory (use
    Clear all for a full reset)."""
    doc = db.get(models.Document, doc_id)
    if not doc:
        raise HTTPException(404, "document not found")
    posted = db.query(models.Purchase).filter(
        models.Purchase.document_id == doc_id,
        models.Purchase.status == "posted").first()
    if posted:
        raise HTTPException(400, "This document's GRN is already posted to inventory. "
                                 "Use 'Clear all' to reset everything.")
    _detach_document(db, doc)   # FKs from profiles, LR rows and GRNs
    db.delete(doc)              # cascades extractions + line_items
    db.commit()
    return {"ok": True, "deleted_document": doc_id}


def _extract_into(doc: models.Document, db: Session) -> dict:
    """Read this document's stored pages and attach an Extraction to it.

    Split out of the upload so it can be run again on a document that already
    exists. Reading a dense two-page invoice can take minutes, and a request
    that runs out of time leaves the pages stored and the document with nothing
    attached — re-uploading to get past that would store the same images a
    second time and add another row to the list. The pages are already there;
    only the reading needs repeating.
    """
    # A reference that no longer resolves used to be passed on ANYWAY —
    # `materialise(r) or r` handed the extractor the path it had just failed to
    # find. What came back was a FileNotFoundError from inside the vision
    # provider, swallowed by the engine's fallback as "claude_vision failed
    # (FileNotFoundError); fell back to OCR" and turned into an empty invoice at
    # 3% confidence: no supplier, no number, no total, no lines. Every one of
    # those reads as "this bill could not be read", and the truth is that the
    # bill was never opened, because the file is gone.
    #
    # So the pages that resolve are read and the ones that do not are named. The
    # commonest cause by far is a server whose upload folder does not survive a
    # restart while its database does — see /api/status, `storage`.
    refs = _page_refs(doc)
    locals_, missing = [], []
    for n, ref in enumerate(refs, 1):
        local = storage.materialise(ref)
        (locals_.append(local) if local else missing.append(n))
    if not locals_:
        raise PagesMissing(
            f"The stored image for this document is no longer there "
            f"({len(refs) or 'no'} page(s) recorded, none readable). Nothing can "
            f"be read from it — the row is in the database but the file behind "
            f"it is not. Upload the invoice again.")
    local = locals_[0]

    # detect supplier via OCR header, load its learned profile
    ocr_text = engine._ocr_text(local)
    suppliers = db.query(models.Supplier).all()
    supplier, _ = engine.detect_supplier(ocr_text, suppliers)
    profile = None
    if supplier:
        doc.supplier_id = supplier.id
        profile = _profile_dict(supplier.active_profile)

    # Every page to the extractor — the totals are only on the last one.
    result = engine.run_extraction(locals_, profile=profile, ocr_text=ocr_text)

    # Said out loud, because of WHICH page tends to go missing and what is on
    # it. The reading below will reconcile lines against totals and find them
    # short, and the reviewer would be left looking for a mistake in the reading
    # of a page that was never read.
    if missing:
        result["warnings"] = result["warnings"] + [
            f"Page {', '.join(str(n) for n in missing)} of {len(refs)} could not be "
            f"opened — the stored file is gone, so anything printed only on it "
            f"(the totals are on the last page) is not in this reading."]

    # Back-fill the consignment fields (LR no & date, transporter, booking city)
    # from the matching LR register row BEFORE the extraction is stored, so the
    # review form opens with its transport block already populated. Provenance
    # goes in meta so the UI can badge those fields after a reload too.
    from ..services import lr_link
    lr_source = lr_link.fill_invoice_from_lr(db, result["data"], invoice_doc_id=doc.id)
    if lr_source:
        result["data"].setdefault("meta", {})["lr_source"] = lr_source
        result["warnings"] = result["warnings"] + lr_link.describe_invoice_fill(lr_source)

    # if the seeded/vision result named a supplier we didn't detect from OCR, link it
    if not doc.supplier_id:
        gstin = (result["data"].get("supplier") or {}).get("gstin")
        if gstin:
            match = db.query(models.Supplier).filter(models.Supplier.gstin == gstin).first()
            if match:
                doc.supplier_id = match.id

    ex = models.Extraction(
        document_id=doc.id, provider=result["provider"],
        profile_id=(supplier.active_profile.id if supplier and supplier.active_profile else None),
        data=result["data"], confidence=result["confidence"],
        warnings=result["warnings"], field_flags=result["field_flags"],
        raw_text=result.get("raw_text", ""),
    )
    db.add(ex)
    doc.status = "confirmed" if result["confidence"] >= 0.95 and not result["field_flags"] else "needs_review"
    db.commit()
    db.refresh(doc)
    db.refresh(ex)

    # cross-fill: if this invoice matches an existing LR row, fill its blanks
    lr_filled = lr_link.fill_lr_from_invoice(db, ex.data, doc.id)

    return {
        "document": _doc_out(doc),
        "extraction": {
            "id": ex.id, "provider": ex.provider, "confidence": ex.confidence,
            "warnings": ex.warnings, "field_flags": ex.field_flags, "data": ex.data,
        },
        "supplier_recognised": bool(supplier),
        "profile_used": bool(profile),
        "lr_filled": lr_filled,
    }


@router.post("/upload")
async def upload_and_extract(file: List[UploadFile] = File(...),
                             db: Session = Depends(get_db),
                             wid: Optional[int] = Depends(scope.current)):
    """One invoice, one or more pages.

    `file` is repeated rather than a second `files` field, so the same endpoint
    serves a single photograph and a two-page bill and nothing had to be
    versioned. A supplier's sixty-line invoice prints as "Tax Invoice" and "Tax
    Invoice(Page 2)"; uploaded separately they became two documents, each with
    half the lines and one of them with no totals at all, and the operator was
    left to key the second half into the first by hand.
    """
    if not file:
        raise HTTPException(400, "no file uploaded")

    raws = [await f.read() for f in file]
    # Hashed over every page together: the same two-page invoice uploaded twice
    # is one document, and page 1 alone is a different document from page 1 + 2.
    content_hash = hashlib.sha256(b"".join(raws)).hexdigest()

    refs = []
    for i, (f, raw) in enumerate(zip(file, raws)):
        ext = os.path.splitext(f.filename or "")[1] or ".bin"
        page_hash = hashlib.sha256(raw).hexdigest()
        refs.append(storage.save(raw, f"{page_hash[:16]}{ext}"))

    doc = models.Document(filename=file[0].filename,
                          stored_path=refs[0], pages=refs,
                          content_hash=content_hash, mime=file[0].content_type,
                          # Filed to the warehouse whose desk keyed it, so it
                          # lands on that branch's queue and nobody else's.
                          warehouse_id=wid,
                          status="uploaded")
    db.add(doc)
    db.commit()
    db.refresh(doc)

    return _extract_into(doc, db)


class ManualIn(BaseModel):
    filename: Optional[str] = None


@router.post("/manual")
def create_manual(body: Optional[ManualIn] = None, db: Session = Depends(get_db),
                  wid: Optional[int] = Depends(scope.current)):
    """Start an invoice that has no photograph — one keyed in by hand.

    Everything else on this screen arrives as an image and is read into the
    canonical dict by a provider. A bill dictated over the phone, one that came
    as a plain-text email, or one whose scan is unusable had nowhere to go: the
    only way to reach the review form was to upload a file, so the workaround
    was to photograph a printout of something already typed.

    The row is a document like any other — same list, same review form, same
    Confirm and Create GRN — with three differences: no stored file, an
    extraction whose provider is `human`, and a confidence of 0.

    That last one is deliberate. Confidence means "how sure is the READING",
    and nothing was read here. Writing 1.0 would badge an unchecked bill 100%
    and, worse, this app routes on that number: `_extract_into` confirms a
    document outright at >= 0.95, and the review queue is everything below it.
    A hand-keyed invoice must land in the queue and be confirmed by the person
    typing it, which is exactly what 0 with status `needs_review` does.
    """
    doc = models.Document(
        filename=(body.filename.strip() if body and body.filename and body.filename.strip()
                  else "Manual entry"),
        # stored_path is NOT NULL and there is no file. The empty string is the
        # "no image" marker — storage.read("") already answers None, so the
        # image route 404s on its own and _doc_out reports has_image: false.
        stored_path="", pages=[], content_hash=None, mime=None,
        warehouse_id=wid,
        status="needs_review",
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    ex = models.Extraction(
        document_id=doc.id, provider="human", data=empty_invoice(),
        confidence=0.0, warnings=[], field_flags={}, raw_text="",
    )
    db.add(ex)
    db.commit()
    db.refresh(ex)

    # Shaped like _extract_into's return so the frontend opens it through the
    # same path an upload takes, rather than growing a second way in.
    return {
        "document": _doc_out(doc),
        "extraction": {
            "id": ex.id, "provider": ex.provider, "confidence": ex.confidence,
            "warnings": ex.warnings, "field_flags": ex.field_flags, "data": ex.data,
        },
        "supplier_recognised": False,
        "profile_used": False,
        "lr_filled": [],
    }


def _detach_document(db: Session, doc: models.Document, move_to=None) -> None:
    """Clear every reference to this document before it is deleted.

    Six tables carry a foreign key to documents.id. SQLite does not enforce
    them — `PRAGMA foreign_keys` is off unless switched on — so deleting a
    referenced document has always worked on the warehouse PC and has always
    been an integrity violation. Postgres enforces them, so the same delete
    fails there with a 500 and no explanation. That is why this went unnoticed:
    the only database that would have complained was the one nobody ran.

    `move_to` re-points the references instead of clearing them, which is what a
    merge wants — the consignment linked to the absorbed half is linked to the
    invoice it is now part of, rather than quietly unlinked.
    """
    new_id = move_to.id if move_to is not None else None

    # A trained format cites the document it was learned from. Keep the profile
    # and forget the citation: the training is in the profile, not in the page.
    db.query(models.SupplierProfile).filter(
        models.SupplierProfile.trained_from_document_id == doc.id
    ).update({"trained_from_document_id": new_id}, synchronize_session=False)

    # The LR register points at documents twice: the page it was read FROM, and
    # the invoice it was matched TO.
    db.query(models.LREntry).filter(
        models.LREntry.document_id == doc.id
    ).update({"document_id": new_id}, synchronize_session=False)
    db.query(models.LREntry).filter(
        models.LREntry.invoice_document_id == doc.id
    ).update({"invoice_document_id": new_id}, synchronize_session=False)

    # A GRN is built FROM a reading, so it does not survive one being replaced.
    # Moved rather than deleted when merging: the receipt was against this bill.
    for p in db.query(models.Purchase).filter(models.Purchase.document_id == doc.id).all():
        if move_to is not None:
            p.document_id = new_id
        else:
            db.delete(p)                    # cascades purchase_lines


class MergeIn(BaseModel):
    """The other half of this invoice — the document to fold in and remove."""
    from_id: int


@router.post("/{doc_id}/merge")
def merge_documents(doc_id: int, body: MergeIn, db: Session = Depends(get_db)):
    """Fold another document's pages into this one and read the whole thing.

    For an invoice whose pages were uploaded one at a time — which is what
    everybody does until they know the upload takes both. What is left is two
    documents of the same bill: one with the first half of the lines, and one
    with the rest and the totals. Neither reconciles, because the totals belong
    to lines the other document holds.

    The pages are appended in DOCUMENT-ID order rather than in the order the two
    were named. Page 2 uploaded before page 1 is an ordinary mistake, and the
    reading depends on the order — the header is taken from the first page and
    the totals from the last.

    The absorbed document is deleted, not left as a duplicate: the whole point
    is to stop two half-invoices sitting in the list. Its GRN goes with it, and
    a posted one blocks the merge — a receipt already booked against half a bill
    has to be dealt with deliberately, not silently rewritten.
    """
    if body.from_id == doc_id:
        raise HTTPException(400, "That is the same document")
    target = db.get(models.Document, doc_id)
    other = db.get(models.Document, body.from_id)
    if not target or not other:
        raise HTTPException(404, "document not found")

    for d in (target, other):
        if d.status == "posted":
            raise HTTPException(400, f"'{d.filename}' is already posted to inventory. "
                                     "Un-post or clear it before merging.")

    first, second = (target, other) if target.id < other.id else (other, target)
    pages = _page_refs(first) + _page_refs(second)
    # The same photograph added twice adds nothing and costs a page of reading.
    seen, ordered = set(), []
    for ref in pages:
        if ref not in seen:
            seen.add(ref)
            ordered.append(ref)
    if not ordered:
        raise HTTPException(400, "Neither of these documents has a page behind it — "
                                 "there is nothing to merge.")

    # Checked BEFORE anything is written, because of what this operation costs
    # if it goes wrong. Two rows become one and both readings are replaced by a
    # reading of the whole; if the stored images are not actually there, that
    # replacement is an empty invoice and the two half-readings it replaced are
    # gone. The operator sees a merge that "did nothing" and has lost the data
    # they had. Refusing with the reason keeps both halves intact.
    gone = [n for n, ref in enumerate(ordered, 1) if storage.missing(ref)]
    if gone:
        raise HTTPException(400,
            f"Page {', '.join(str(n) for n in gone)} of {len(ordered)} cannot be "
            f"found in storage, so the merged invoice could not be read and both "
            f"halves would be lost. The rows are in the database but the image "
            f"files behind them are not — check /api/status, `storage`: an upload "
            f"folder that does not survive a restart loses files exactly this way. "
            f"Upload the invoice again, both pages at once.")

    # Every half-reading, kept until the whole document has actually been read.
    # These used to be deleted here, before the re-read was attempted — so a
    # read that failed left the merged document with no extraction at all, which
    # is the "merged and now there is nothing" outcome.
    superseded = [ex.id for ex in target.extractions]

    target.pages = ordered
    target.stored_path = ordered[0]
    target.filename = first.filename
    # The document's identity changed when its page set did, and content_hash is
    # what the viewer hangs its image URL off — left at page one's original
    # value, a merged invoice asks the browser for the very URL it asked for
    # before it had a second page. Hashed over the page REFERENCES: each one is
    # already named after its own content, so re-reading every page over the
    # network to learn what the names already say buys nothing.
    target.content_hash = hashlib.sha256("|".join(ordered).encode()).hexdigest()
    target.status = "uploaded"
    _detach_document(db, other, move_to=target)
    db.delete(other)
    db.commit()                             # the merge itself is now permanent
    db.refresh(target)

    # Re-reading is the slow part — a two-page bill of sixty lines is minutes of
    # vision — and it is also the part that can run out of time. Committed
    # separately above so a slow read cannot undo the merge: the pages are
    # joined either way, and a failure leaves one document to be read rather
    # than two halves to be merged again.
    try:
        out = _extract_into(target, db)
    except Exception as exc:                # noqa: BLE001 — reported, not raised
        db.rollback()
        target = db.get(models.Document, doc_id)
        # The half-reading survived (see `superseded`), so this is not the blank
        # document it used to be — say which of the two states it is in, because
        # "press Read it now" is the right advice for one and misleading for the
        # other.
        target.status = "needs_review" if target.extractions else "uploaded"
        db.commit()
        ex = target.latest_extraction
        return {
            "document": _doc_out(target),
            "extraction": ({"id": ex.id, "provider": ex.provider,
                            "confidence": ex.confidence, "warnings": ex.warnings,
                            "field_flags": ex.field_flags, "data": ex.data} if ex else None),
            "merged": {"pages": len(ordered), "absorbed": body.from_id},
            "read_failed": f"{type(exc).__name__}: {exc}"[:300],
        }

    # Read, and only now are the half-readings of no further use. Deleted by id
    # rather than through target.extractions, which by here also holds the new
    # one — walking the relationship would take the answer away with the
    # question.
    if superseded:
        db.query(models.Extraction).filter(
            models.Extraction.id.in_(superseded)).delete(synchronize_session=False)
        db.commit()
    out["merged"] = {"pages": len(ordered), "absorbed": body.from_id}
    return out


@router.post("/{doc_id}/extract")
def re_extract(doc_id: int, db: Session = Depends(get_db)):
    """Read an already-uploaded document again.

    What this is for: an upload whose reading ran out of time. The pages are
    stored and the document exists, but nothing is attached to it — it sits in
    the list as UPLOADED with no supplier and no total, and the only way past it
    was to upload the same photographs again and leave the first behind.

    Any existing extraction is replaced rather than added to, so a document that
    has been read twice does not accumulate versions of the same answer — but it
    is replaced AFTERWARDS, once there is something to replace it with. Deleted
    first, a re-read that failed took the previous reading with it and left the
    document blank, which is the one outcome nobody asked for by pressing this.

    A document already posted to inventory is refused: its GRN was built from the
    reading, and replacing it underneath would leave the two disagreeing.
    """
    doc = db.get(models.Document, doc_id)
    if not doc:
        raise HTTPException(404, "document not found")
    if doc.status == "posted":
        raise HTTPException(400, "This document is already posted to inventory — "
                                 "re-reading it would leave its GRN disagreeing with it.")
    superseded = [ex.id for ex in doc.extractions]
    try:
        out = _extract_into(doc, db)
    except PagesMissing as exc:
        # Not a 500. Nothing is broken in the server and trying again will do
        # exactly the same thing; the file is gone, and the message says so.
        raise HTTPException(400, str(exc)) from exc
    if superseded:
        db.query(models.Extraction).filter(
            models.Extraction.id.in_(superseded)).delete(synchronize_session=False)
        db.commit()
    return out


@router.get("/{doc_id}")
def get_document(doc_id: int, db: Session = Depends(get_db)):
    doc = db.get(models.Document, doc_id)
    if not doc:
        raise HTTPException(404, "document not found")
    ex = doc.latest_extraction
    return {
        "document": _doc_out(doc),
        "extraction": ({"id": ex.id, "provider": ex.provider, "confidence": ex.confidence,
                        "warnings": ex.warnings, "field_flags": ex.field_flags,
                        "data": ex.data, "is_correction": ex.is_correction} if ex else None),
        "history": [{"id": e.id, "provider": e.provider, "confidence": e.confidence,
                     "is_correction": e.is_correction,
                     "created_at": e.created_at.isoformat()} for e in doc.extractions],
    }


@router.get("/{doc_id}/image")
def get_image(doc_id: int, page: int = 0, db: Session = Depends(get_db)):
    """One page of this document's photograph. `page` is 0-based.

    It used to read `stored_path` and nothing else — which is page one, and was
    the whole of the answer even for a document that had two. A bill merged from
    two uploads therefore had both pages in the database and both pages sent to
    the extractor, while the reviewer could still only look at the first: the
    merge appeared to have done nothing.
    """
    from fastapi.responses import Response
    doc = db.get(models.Document, doc_id)
    if not doc:
        raise HTTPException(404, "document not found")
    refs = _page_refs(doc)
    if not refs:
        raise HTTPException(404, "image not found")
    # Clamped rather than rejected. The viewer asks for whichever page it had
    # open, and a document that lost a page — un-merged, or re-uploaded with
    # fewer — would answer a stale URL with a 404 that an <img> draws as a
    # broken file. Out of range means the request is old, not that the invoice
    # is missing, so it gets page one.
    ref = refs[page] if 0 <= page < len(refs) else refs[0]
    raw = storage.read(ref)
    if raw is None:
        raise HTTPException(404, "image not found")
    # From the page's OWN reference: `doc.mime` was recorded from page one, and
    # a bill photographed a page at a time can be a JPEG followed by a PNG.
    media = storage.mime_for(ref)
    if media == "application/octet-stream" and doc.mime:
        media = doc.mime
    # This URL is not content-addressed — it names a row, and rows are recycled:
    # "Clear all" empties the table, and SQLite hands the next upload the same id
    # the deleted one had. Without a directive the browser applies *heuristic*
    # freshness (a fraction of the file's age) and reuses the bytes it cached
    # under this URL without asking, so the viewer shows the invoice that used to
    # be document 2 next to the data of the one that is document 2 now.
    # no-cache means "ask before reusing". Caching it properly would mean putting
    # the content hash in the URL so the URL changes when the bytes do; until the
    # payload carries that hash, correct beats clever here.
    #
    # The bytes are served from here rather than by redirecting to where they are
    # stored. On a deployment that store is Vercel Blob, whose URLs are public
    # and do not expire — handing one to the browser would put a supplier invoice
    # outside the login for good, and this route is policed like every other.
    return Response(raw, media_type=media, headers={"Cache-Control": "no-cache"})


def _searched_for(data):
    """What the matcher actually looked for — so a failure explains itself."""
    inv = data.get("invoice") or {}
    num, lr = inv.get("number"), inv.get("lr_no")
    bits = [f"invoice no {num}" if num else "no invoice no on this document"]
    bits.append(f"LR no {lr}" if lr else "no LR no printed on this invoice")
    return " and ".join(bits)


@router.post("/{doc_id}/fetch-transport")
def fetch_transport(doc_id: int, lr_entry_id: Optional[int] = None,
                    db: Session = Depends(get_db)):
    """Pull this invoice's consignment fields (LR No & date, transporter, booking
    city) in from the LR register on demand.

    Upload already does this automatically, but the register is often photographed
    *after* the invoices it covers — this is how those invoices catch up without
    re-uploading. Same matching, quantity gate and blank-only rules as the
    automatic pass. A fill is recorded as a new extraction so the audit trail
    still shows where the values came from; a no-op leaves the document alone.

    Pass `lr_entry_id` to link a row the user picked from the suggestions. That
    is an explicit human decision, so it bypasses the automatic quantity gate —
    but the disagreement is still reported, and the row is linked back to this
    document so the register shows the pairing too.

    When nothing matches, the response carries `candidates`: register rows for
    the same supplier, ranked. Suggestions only — a supplier-name agreement is
    never enough to fill on its own."""
    from ..services import lr_link
    doc = db.get(models.Document, doc_id)
    if not doc:
        raise HTTPException(404, "document not found")
    prev = doc.latest_extraction
    if not prev:
        raise HTTPException(400, "this document has no extraction to fill")

    data = copy.deepcopy(prev.data or {})

    if lr_entry_id is not None:
        # the service links the row and pushes the invoice's no/date back into it
        report = lr_link.fill_invoice_from_lr_entry(db, data, lr_entry_id,
                                                    invoice_doc_id=doc.id)
        if report is None:
            raise HTTPException(404, f"LR register row {lr_entry_id} not found")
        lr = db.get(models.LREntry, lr_entry_id)
        notes = lr_link.describe_invoice_fill(report)
        detail = (f"Linked LR row {lr.lr_no or lr_entry_id}."
                  + (f" Filled {len(report['filled'])} field(s)." if report["filled"]
                     else " Nothing blank left to fill.")
                  + _register_fill_note(report))
        return _persist_lr_fill(db, doc, prev, data, report, notes, detail,
                                matched=True, always=True)

    report = lr_link.fill_invoice_from_lr(db, data, invoice_doc_id=doc.id)
    notes = lr_link.describe_invoice_fill(report)

    if not report:
        cands = lr_link.suggest_lr_candidates(db, data)
        detail = f"No register row carries {_searched_for(data)}."
        if cands:
            detail += (f" {len(cands)} row(s) for this supplier are listed below — "
                       "pick the consignment this invoice belongs to.")
        else:
            detail += " No register row for this supplier either."
        return {"ok": True, "matched": False, "filled": {}, "notes": [],
                "candidates": cands, "detail": detail}

    if not report.get("filled"):
        blocked = report.get("qty") == "mismatch"
        detail = ("Matched the register, but the quantities disagree — nothing filled."
                  if blocked else
                  "Matched the register, but there was nothing blank left to fill.")
        # a gate-blocked row is still the likeliest answer: offer it for linking
        forced = ([db.get(models.LREntry, i) for i in report["matched_lr_ids"]]
                  if blocked else [])
        return {"ok": True, "matched": True, "filled": {}, "notes": notes,
                "lr_source": report, "detail": detail,
                "candidates": (lr_link.suggest_lr_candidates(
                    db, data, include=[r for r in forced if r]) if blocked else None)}

    return _persist_lr_fill(db, doc, prev, data, report, notes,
                            f"Filled {len(report['filled'])} field(s) from the LR register."
                            + _register_fill_note(report),
                            matched=True)


_LR_FIELD_LABELS = {"inv_no": "Inv No", "inv_date": "Inv Date", "amount": "Amount",
                    "qty": "Qty", "item": "Item",
                    "freight_amount": "Freight", "supplier_name": "Supplier",
                    "transport": "Transport"}


def _register_fill_note(report):
    """" … and wrote Inv No + Inv Date back into the register." — the other half of
    the link, so the user knows the register row is now complete too."""
    written = sorted({f for fields in (report.get("register_filled") or {}).values()
                      for f in fields})
    if not written:
        return ""
    names = ", ".join(_LR_FIELD_LABELS.get(f, f) for f in written)
    return f" Wrote {names} back into the LR register."


def _persist_lr_fill(db, doc, prev, data, report, notes, detail, matched, always=False):
    """Record a register-sourced fill as a new extraction (audit trail intact).
    A fill that changed nothing adds no extraction row unless `always`."""
    ex_id = None
    if report.get("filled") or always:
        data.setdefault("meta", {})["lr_source"] = report
    if report.get("filled"):
        ex = models.Extraction(document_id=doc.id, provider="lr_register", data=data,
                               confidence=prev.confidence,
                               warnings=(prev.warnings or []) + notes,
                               field_flags=prev.field_flags or {},
                               is_correction=False)
        db.add(ex)
    db.commit()
    if report.get("filled"):
        db.refresh(ex)
        ex_id = ex.id
    return {"ok": True, "matched": matched, "filled": report.get("filled", {}),
            "notes": notes, "lr_source": report, "extraction_id": ex_id,
            "data": data, "detail": detail}


#: Date fields inside the canonical invoice. Normalised when a human confirms the
#: extraction — this is the moment the read stops being a guess and starts being a
#: record, and `invoice.date` in particular becomes `Purchase.invoice_date`, which
#: everything downstream ages and sorts a payable by.
_DATE_PATHS = ("invoice.date", "invoice.due_date", "invoice.order_date",
               "invoice.irn_date", "invoice.lr_date", "invoice.eway_date",
               "meta.grn_date")


def normalise_dates(data):
    """Rewrite the known date fields of a canonical invoice to ISO.

    Only the paths above, and only when they parse: a date the parser cannot read
    is left as the supplier wrote it, because the printed page is the record and a
    blank is a worse answer than an odd string."""
    from ..services import dates
    if not isinstance(data, dict):
        return data
    for path in _DATE_PATHS:
        section, _, key = path.partition(".")
        block = data.get(section)
        if isinstance(block, dict) and block.get(key):
            block[key] = dates.normalise(block[key])
    return data


@router.post("/{doc_id}/confirm")
def confirm(doc_id: int, req: ConfirmRequest, db: Session = Depends(get_db)):
    """Save the human-corrected extraction and (optionally) learn the supplier
    profile from it — this is the 'train once per format' action."""
    doc = db.get(models.Document, doc_id)
    if not doc:
        raise HTTPException(404, "document not found")
    corrected = normalise_dates(req.data)

    # persist the correction as a new extraction row (audit trail preserved)
    ex = models.Extraction(document_id=doc.id, provider="human", data=corrected,
                           confidence=1.0, warnings=[], field_flags={},
                           is_correction=True)
    db.add(ex)

    # ensure supplier exists / update it
    sup_info = corrected.get("supplier") or {}
    supplier = None
    if sup_info.get("gstin"):
        supplier = db.query(models.Supplier).filter(models.Supplier.gstin == sup_info["gstin"]).first()
    if not supplier and sup_info.get("name"):
        supplier = models.Supplier(name=sup_info["name"], gstin=sup_info.get("gstin"))
        db.add(supplier)
        db.flush()
    if supplier:
        supplier.name = sup_info.get("name") or supplier.name
        supplier.gstin = sup_info.get("gstin") or supplier.gstin
        supplier.state = sup_info.get("state") or supplier.state
        supplier.state_code = sup_info.get("state_code") or supplier.state_code
        supplier.address = sup_info.get("address") or supplier.address
        supplier.bank = sup_info.get("bank") or supplier.bank
        doc.supplier_id = supplier.id

    # auto-populate masters from whatever the extractor read (no manual entry)
    from ..services import masters as masters_svc
    inv_info = corrected.get("invoice") or {}
    masters_svc.get_or_create_transport(db, inv_info.get("transporter"))
    masters_svc.get_or_create_agent(db, inv_info.get("agent"))

    trained = False
    if req.train and supplier:
        spec = engine.learn_from_correction(corrected)
        existing = supplier.active_profile
        if existing:
            existing.is_active = False
            new_version = existing.version + 1
            samples = existing.sample_count + 1
        else:
            new_version, samples = 1, 1
        profile = models.SupplierProfile(
            supplier_id=supplier.id, template_key=spec["template_key"],
            version=new_version, is_active=True,
            detect_gstin=spec["detect_gstin"], detect_keywords=spec["detect_keywords"],
            tax_mode=spec["tax_mode"], default_tax_rates=spec["default_tax_rates"],
            has_tds=spec["has_tds"], uom_default=spec["uom_default"],
            reference_example=spec["reference_example"],
            trained_from_document_id=doc.id, sample_count=samples,
        )
        db.add(profile)
        trained = True

    # denormalise confirmed line items for reporting
    db.query(models.LineItem).filter(models.LineItem.document_id == doc.id).delete()
    for it in corrected.get("line_items", []):
        db.add(models.LineItem(document_id=doc.id, barcode=it.get("barcode"),
                               description=it.get("description"), hsn=it.get("hsn"),
                               qty=it.get("qty"), uom=it.get("uom"),
                               rate=it.get("rate"), amount=it.get("amount")))
    doc.status = "confirmed"
    db.commit()

    # cross-fill LR rows from the (corrected) invoice too
    from ..services import lr_link
    lr_filled = lr_link.fill_lr_from_invoice(db, corrected, doc.id)

    return {"ok": True, "trained_profile": trained,
            "supplier_id": supplier.id if supplier else None,
            "lr_filled": lr_filled}


@router.get("/{doc_id}/export")
def export_document(doc_id: int, format: str = "json", db: Session = Depends(get_db)):
    """Export the confirmed invoice as a purchase-entry payload (JSON) or a
    line-item CSV ready to import into the ERP purchase/GRN module."""
    doc = db.get(models.Document, doc_id)
    if not doc or not doc.latest_extraction:
        raise HTTPException(404, "nothing to export")
    data = doc.latest_extraction.data
    if format == "csv":
        import io, csv
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["barcode", "description", "hsn", "qty", "uom", "rate", "amount"])
        for it in data.get("line_items", []):
            w.writerow([it.get("barcode", ""), it.get("description", ""), it.get("hsn", ""),
                        it.get("qty", ""), it.get("uom", ""), it.get("rate", ""), it.get("amount", "")])
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")
    # default: purchase-entry JSON payload
    t = data.get("totals", {})
    payload = {
        "purchase_entry": {
            "supplier_gstin": (data.get("supplier") or {}).get("gstin"),
            "supplier_name": (data.get("supplier") or {}).get("name"),
            "invoice_number": (data.get("invoice") or {}).get("number"),
            "invoice_date": (data.get("invoice") or {}).get("date"),
            "taxable_total": t.get("taxable_total"),
            "tax_total": t.get("tax_total"),
            "grand_total": t.get("grand_total"),
            "taxes": data.get("taxes"),
            "line_items": data.get("line_items"),
        }
    }
    return JSONResponse(payload)
