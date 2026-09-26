import io
import re
from functools import wraps
from flask import abort
from flask_login import current_user

# Imported here, not inside generate_number(): this package is loaded under the
# name `app`, and when the shop is served inside the Essa backend that name
# belongs to something else by the time a request arrives. Safe at module level
# because every importer of this file (create_app and the blueprints) is itself
# imported from create_app, after `db` exists.
from app import db


def day_arg(name):
    """A `?name=YYYY-MM-DD` query argument (what an <input type=date> sends) as a
    date, or None when it is absent or unreadable — a bad date is no filter, not
    a 500. Used by every list screen's From / To filters."""
    from datetime import datetime
    from flask import request
    raw = (request.args.get(name) or "").strip()
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        return None


def role_required(*roles):
    def wrap(fn):
        @wraps(fn)
        def inner(*args, **kwargs):
            if not current_user.is_authenticated:
                abort(401)
            if current_user.role not in roles and not current_user.is_admin:
                abort(403)
            return fn(*args, **kwargs)
        return inner
    return wrap


def generate_number(prefix, model, field):
    """Generate next sequential number like INV-000123."""
    last = db.session.query(model).order_by(model.id.desc()).first()
    n = (last.id + 1) if last else 1
    return f"{prefix}-{n:06d}"


# ---------- Codes ----------
#
# The shop no longer issues product barcodes. It used to mint an EAN-13 for every
# product, which put two codes on one garment for the same item — and only the
# warehouse's QR meant anything upstairs. Products carry that QR and nothing else
# now; see app/warehouse_items.py.
#
# The Code 128 renderer below stays for CUSTOMER membership cards, which are the
# shop's own and have nothing to do with stock.

# Standard Code 128 bar/space width patterns (index 0-106; 106 = stop).
_CODE128_PATTERNS = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213",
    "122312", "132212", "221213", "221312", "231212", "112232", "122132",
    "122231", "113222", "123122", "123221", "223211", "221132", "221231",
    "213212", "223112", "312131", "311222", "321122", "321221", "312212",
    "322112", "322211", "212123", "212321", "232121", "111323", "131123",
    "131321", "112313", "132113", "132311", "211313", "231113", "231311",
    "112133", "112331", "132131", "113123", "113321", "133121", "313121",
    "211331", "231131", "213113", "213311", "213131", "311123", "311321",
    "331121", "312113", "312311", "332111", "314111", "221411", "431111",
    "111224", "111422", "121124", "121421", "141122", "141221", "112214",
    "112412", "122114", "122411", "142112", "142211", "241211", "221114",
    "413111", "241112", "134111", "111242", "121142", "121241", "114212",
    "124112", "124211", "411212", "421112", "421211", "212141", "214121",
    "412121", "111143", "111341", "131141", "114113", "114311", "411113",
    "411311", "113141", "114131", "311141", "411131", "211412", "211214",
    "211232", "2331112",
]
_CODE128_START_B = 104
_CODE128_STOP = 106


_SVG_HEAD_RE = re.compile(r'<svg([^>]*?)\bwidth="([\d.]+)"\s+height="([\d.]+)"')


def _scalable(svg):
    """Give a segno symbol a viewBox and crisp edges.

    segno emits `width`/`height` in pixels and no viewBox. An SVG without one has
    no mapping from user units to its viewport, so a CSS `width: 104px` resizes
    the viewport and leaves the drawing at its intrinsic size — and because the
    outermost svg clips by default, the overflow is cut off rather than scaled.
    A 65-module symbol at scale 3 is 195px of drawing inside a 104px box: nearly
    half the code, finder patterns and all, simply is not there. It still looks
    like a QR and no scanner can read it.

    `crispEdges` turns off antialiasing on module boundaries; at label sizes a
    softened edge costs real contrast, which is what a camera has least of.
    """
    if "viewBox" in svg:
        return svg
    m = _SVG_HEAD_RE.search(svg)
    if not m:
        return svg
    attrs, w, h = m.group(1), m.group(2), m.group(3)
    return svg.replace(
        m.group(0),
        f'<svg{attrs}width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
        f'shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet"',
        1)


def qr_svg(payload, scale=3):
    """Render a warehouse QR payload as inline SVG.

    The shop prints the SAME code the warehouse put on the item, so one tag works
    in both places and a piece scanned here is the piece the GRN created. Returns
    an empty string when there is nothing to encode, or when segno isn't installed
    — the label still carries its barcode and SKU, just without the square.

    Error correction 'M' and a 4-module quiet zone, matching what the warehouse
    prints: the same payload has to come off both tags identically, and a QR
    crowded to its edge is one a scanner reads slowly or not at all.
    """
    if not payload:
        return ""
    try:
        import segno
    except ImportError:
        return ""
    try:
        buf = io.BytesIO()      # segno writes bytes here; a StringIO raises
        segno.make(str(payload), error="m").save(
            buf, kind="svg", scale=scale, border=4, xmldecl=False, svgns=True)
        return _scalable(buf.getvalue().decode())
    except Exception:
        return ""


def qr_module_size_mm(payload, box_mm):
    """How many millimetres one module gets when this payload is drawn at `box_mm`.

    The number that decides whether a label scans: roughly 0.33mm is the floor for
    a phone camera in ordinary light. Exposed so a test can assert it rather than
    trusting a comment — a payload that grows quietly is what pushes a working
    label under the line.
    """
    if not payload:
        return 0.0
    try:
        import segno
    except ImportError:
        return 0.0
    n = segno.make(str(payload), error="m").symbol_size(border=4)[0]
    return box_mm / n if n else 0.0


def barcode_svg(code, module=2, height=64, quiet=10, with_text=True):
    """Render `code` as a Code 128-B barcode, returned as an inline SVG string.

    Pure Python, no dependencies — scans on any standard 1D barcode reader.
    """
    if not code:
        return ""
    code = str(code)
    # Only ASCII 32-126 is encodable in Code 128-B; skip anything else.
    values = [ord(c) - 32 for c in code if 32 <= ord(c) <= 126]
    if not values:
        return ""

    seq = [_CODE128_START_B] + values
    checksum = (_CODE128_START_B + sum(v * (i + 1) for i, v in enumerate(values))) % 103
    seq += [checksum, _CODE128_STOP]

    # Build the full run of module widths, then draw bars (odd runs are bars).
    widths = "".join(_CODE128_PATTERNS[i] for i in seq)
    x = quiet
    bars = []
    for i, w in enumerate(widths):
        w = int(w) * module
        if i % 2 == 0:  # bar
            bars.append(f'<rect x="{x}" y="0" width="{w}" height="{height}"/>')
        x += w
    total_w = x + quiet
    text_h = 16 if with_text else 0
    svg_h = height + text_h
    text = ""
    if with_text:
        text = (f'<text x="{total_w/2}" y="{svg_h-3}" text-anchor="middle" '
                f'font-family="monospace" font-size="13" fill="#000">{code}</text>')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w}" '
        f'height="{svg_h}" viewBox="0 0 {total_w} {svg_h}">'
        f'<rect width="{total_w}" height="{svg_h}" fill="#fff"/>'
        f'<g fill="#000">{"".join(bars)}</g>{text}</svg>'
    )
