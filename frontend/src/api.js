// ---------------------------------------------------------------------------
//  The signed-in session
//  --------------------------------------------------------------------------
//  Every call below is a bare `fetch`, and there are well over a hundred of
//  them. Rather than thread a token argument through all of those, the module
//  declares its own `fetch` at the top — a module-scoped binding shadows the
//  global one for this file, so the calls underneath are unchanged and none can
//  be forgotten later.
//
//  The token also goes back as a cookie at login, which is what carries the
//  <img> tags pointing at invoice scans and any report opened in a new tab —
//  neither of those can send a header.
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'essa_token'

export const session = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (t) => { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) },
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

// Called by App when a call comes back 401, so an expired or revoked token
// returns the whole app to the login screen instead of leaving every panel
// showing its own error.
let onUnauthorized = () => {}
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn || (() => {}) }

// ==========================================================================
//  The warehouse you are working INSIDE
//  ------------------------------------------------------------------------
//  Sent as a header on every call, from here, rather than threaded through the
//  fifty places that make one. The failure mode of threading it is a single
//  screen that forgets — and a screen that forgets does not look broken, it
//  looks like another warehouse's work has turned up in yours. One place cannot
//  forget one screen at a time.
//
//  Endpoints that don't scope simply ignore the header. Held in localStorage so
//  a reload keeps you where you were standing.
// ==========================================================================
const WAREHOUSE_KEY = 'essa_warehouse'
let warehouseListener = () => {}

export const warehouse = {
  get: () => {
    const raw = localStorage.getItem(WAREHOUSE_KEY)
    try { return raw ? JSON.parse(raw) : null } catch { return null }
  },
  set: (w) => {
    if (w && w.id) localStorage.setItem(WAREHOUSE_KEY, JSON.stringify(
      { id: w.id, name: w.name, code: w.code, catalogue: w.catalogue }))
    else localStorage.removeItem(WAREHOUSE_KEY)
    warehouseListener(w || null)
  },
  clear: () => warehouse.set(null),
  onChange: (fn) => { warehouseListener = fn || (() => {}) },
}

// A call made on behalf of a workspace other than the one on screen — the
// dashboard cache warming the Central Dashboard while somebody works inside
// Erode, or Erode's dashboard from the Command Center. Every api.* call reaches
// `fetch` synchronously, so pinning the header for the length of `fn` is enough;
// `id` null means company level, with no warehouse header at all.
let whOverride = null
export const asWarehouse = (id, fn) => {
  const prev = whOverride
  whOverride = { id: id || null }
  try { return fn() } finally { whOverride = prev }
}

const fetch = (url, opts = {}) => {
  const token = session.get()
  const headers = new Headers(opts.headers || {})
  if (token) headers.set('X-Essa-Token', token)
  const here = whOverride ? (whOverride.id ? { id: whOverride.id } : null) : warehouse.get()
  if (here && here.id) headers.set('X-Essa-Warehouse', String(here.id))
  return window.fetch(url, { ...opts, headers, credentials: 'same-origin' })
    .then((r) => {
      // 401 is "not signed in" and 403 is "signed in, not allowed" — only the
      // first should bounce anyone out. A user who opens an admin screen from a
      // stale bookmark gets told, and stays where they are.
      if (r.status === 401 && !String(url).includes('/api/auth/')) onUnauthorized()
      return r
    })
}

// The message the server sent, not "Error: 403" — the API answers a refused
// call with a sentence worth showing ("This needs admin access — you are signed
// in as user.").
// What the status means when the body carries no message of its own. A failure
// that answers with HTML — a gateway timeout, a crashed function — leaves
// `detail` undefined, and every screen then falls back to its own generic
// sentence ("Could not merge them"), which says nothing about what happened.
const STATUS_HINT = {
  401: 'not signed in',
  403: 'not allowed for this account',
  404: 'not found',
  413: 'the file is too large',
  502: 'the server could not reach something it depends on',
  504: 'timed out — a long invoice can take minutes; try again, or read it from the document',
}

const J = async (r) => {
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    const detail = j.detail
      || `HTTP ${r.status}${STATUS_HINT[r.status] ? ' — ' + STATUS_HINT[r.status] : ''}`
    throw Object.assign(new Error(String(r.status)), { status: r.status, detail })
  }
  return r.json()
}

// A JSON POST that keeps the server's sentence when it refuses.
//
// The pattern below it — `.then(async r => { … throw Object.assign(…) })` — is
// written out by hand at forty call sites and is the same eight lines each time.
// One screen whose every action can legitimately be refused with a reason worth
// reading is enough to justify naming it.
const PJ = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(J)

// One file, as multipart. No Content-Type is set on purpose: the browser has to
// write it itself so it can add the multipart boundary, and setting it by hand
// produces a body the server cannot parse.
const _upload = (url, file) => {
  const body = new FormData()
  body.append('file', file)
  return fetch(url, { method: 'POST', body }).then(J)
}

// ?a=1&b=2 from an object, skipping blanks — so an untouched filter is absent
// rather than sent as an empty string the server has to special-case
const qs = (params) => {
  const p = new URLSearchParams()
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== '' && v != null) p.append(k, v) })
  return p.toString() ? '?' + p : ''
}

export const api = {
  // auth
  login: (username, password) => fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('login'), { detail: j.detail }); return j }),
  verifyToken: (token) => fetch('/api/auth/verify?token=' + encodeURIComponent(token || '')).then(J),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then(J).catch(() => ({})),
  changePassword: (current_password, new_password) => fetch('/api/auth/change-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password, new_password }) }).then(J),

  // users — super admin only; the server refuses these for anyone else
  listUsers: () => fetch('/api/users').then(J),
  createUser: (body) => fetch('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }).then(J),
  updateUser: (id, body) => fetch(`/api/users/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }).then(J),
  resetUserPassword: (id, new_password) => fetch(`/api/users/${id}/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_password }) }).then(J),
  deleteUser: (id) => fetch(`/api/users/${id}`, { method: 'DELETE' }).then(J),
  // The screens and actions the access grid draws itself from. Fetched on its own
  // as well as riding on listUsers, so a server started before this existed can
  // be TOLD APART from one that simply has nothing to say — `status` survives on
  // the error for exactly that, the same way labelFields and productUnits do.
  permissionCatalog: () => fetch('/api/users/catalog')
    .then(r => { if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status }); return r.json() }),
  // The whole grant map at once, not a checkbox at a time: seventeen screens by
  // five actions is a dozen changes in one sitting, and a half-applied set of
  // permissions is not a thing that should be able to exist.
  setUserPermissions: (id, body) => fetch(`/api/users/${id}/permissions`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }).then(J),

  status: () => fetch('/api/status').then(J),
  // Aggregated series behind the graphical dashboard, in one call. `status` is
  // kept on the error for the same reason as askReport: a 404/405 here is a
  // server still running from before this endpoint existed, which is a restart
  // rather than a fault, and the screen can say which.
  dashboardCharts: (months) => fetch('/api/dashboard/charts' + (months ? `?months=${months}` : ''))
    .then(r => { if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status }); return r.json() }),
  listDocuments: () => fetch('/api/documents').then(J),
  getDocument: (id) => fetch(`/api/documents/${id}`).then(J),
  // Read an already-uploaded document again — for one whose reading ran out of
  // time and left it with no extraction attached.
  reExtract: (id) => fetch(`/api/documents/${id}/extract`, { method: 'POST' }).then(J),
  // Fold another document's pages into this one — for an invoice whose pages
  // were uploaded separately and became two half-invoices.
  mergeDocuments: (id, from_id) => fetch(`/api/documents/${id}/merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_id }) }).then(J),
  deleteDocument: (id) => fetch(`/api/documents/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('del'), { detail: j.detail }); return j }),
  clearAllDocuments: (wipeMasters) => fetch('/api/documents/clear-all' + (wipeMasters ? '?wipe_masters=true' : ''), { method: 'DELETE' }).then(J),
  // `v` is the document's content hash — see _doc_out. Without it the URL names
  // a recycled row id and the browser can serve the previous occupant's invoice.
  // `page` is 0-based: a merged invoice is one document with a photograph per
  // page, and page 1 is not the whole of it — the totals are on the last one.
  imageUrl: (id, v, page = 0) =>
    `/api/documents/${id}/image?page=${page}` + (v ? `&v=${v}` : ''),
  // One invoice, however many pages it was photographed as. The field is
  // repeated rather than renamed, so the server sees a list either way and a
  // single page behaves exactly as it always did.
  upload: (files) => {
    const fd = new FormData()
    for (const f of (files.length === undefined ? [files] : files)) fd.append('file', f)
    return fetch('/api/documents/upload', { method: 'POST', body: fd }).then(J)
  },
  // An invoice with no photograph — one dictated over the phone, or whose scan
  // is unusable. Comes back in the same shape as `upload`, holding a blank
  // canonical invoice, so the review form opens on it exactly as it would on an
  // extracted one. Everything after this point (confirm, GRN) is unchanged.
  createManualDocument: (filename) => fetch('/api/documents/manual', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: filename || null }) }).then(J),
  confirm: (id, data, train) =>
    fetch(`/api/documents/${id}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, train }),
    }).then(J),
  // pull LR No / LR Date / Transporter / Book City in from the LR register.
  // lrEntryId links a row the user picked from the suggestions instead of relying
  // on the invoice-no / LR-no match.
  fetchTransport: (id, lrEntryId) => fetch(
    `/api/documents/${id}/fetch-transport` + (lrEntryId ? `?lr_entry_id=${lrEntryId}` : ''),
    { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('lrfetch'), { detail: j.detail }); return j }),
  exportUrl: (id, format) => `/api/documents/${id}/export?format=${format}`,
  listSuppliers: () => fetch('/api/suppliers').then(J),
  getSupplier: (id) => fetch(`/api/suppliers/${id}`).then(J),

  // purchases / GRN
  listPurchases: () => fetch('/api/purchases').then(J),
  // one page — { rows, total, counts }. status: draft | posted | short | all
  // filters: invoice_no, supplier, grn_no, date_from, date_to (invoice date, inclusive)
  purchasesPage: ({ limit, offset, q, status, invoice_no, supplier, grn_no, date_from, date_to }) =>
    fetch('/api/purchases' + qs({ limit, offset, q, status, invoice_no, supplier, grn_no,
      date_from, date_to })).then(J),
  // the dashboard's GRN figures: { drafts, recent, posted, short_lines, short_value }
  purchasesSummary: () => fetch('/api/purchases/summary').then(J),
  getPurchase: (id) => fetch(`/api/purchases/${id}`).then(J),
  // which warehouse took this delivery in. Draft only — once posted the stock is
  // standing somewhere and moving it is unpost → set → post.
  setGrnWarehouse: (id, warehouse_id) => fetch(`/api/purchases/${id}/warehouse`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ warehouse_id }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('wh'), { detail: j.detail }); return j }),
  buildGrn: (docId) => fetch(`/api/purchases/from-document/${docId}`, { method: 'POST' }).then(J),
  postGrn: (id) => fetch(`/api/purchases/${id}/post`, { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('post'), { detail: j.detail }); return j }),
  // reverse a posted GRN back to draft (guarded: payments / debit notes / dispatches)
  unpostCheck: (id) => fetch(`/api/purchases/${id}/unpost-check`).then(J),
  unpostGrn: (id) => fetch(`/api/purchases/${id}/unpost`, { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('unpost'), { detail: j.detail }); return j }),
  deletePurchase: (id) => fetch(`/api/purchases/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('del'), { detail: j.detail }); return j }),
  // size breakup of one billed line — [] clears it
  setLineSplits: (lineId, rows) => fetch(`/api/purchases/lines/${lineId}/splits`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('splits'), { detail: j.detail }); return j }),
  // shortage entry: what the supplier billed and the boxes didn't hold. Recorded
  // before posting — after it, the gap is invisible (stock says 40, the invoice
  // says 50, and nothing remembers why). [] clears the line's shortages.
  setLineShortages: (lineId, rows, recorded_by) => fetch(`/api/purchases/lines/${lineId}/shortages`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, recorded_by }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('short'), { detail: j.detail }); return j }),
  grnShortages: (pid) => fetch(`/api/purchases/${pid}/shortages`).then(J),
  shortageOptions: () => fetch('/api/purchases/shortage-options').then(J),
  // accept a shortage rather than claim it (supplier is re-sending, or it's too small)
  waiveShortage: (sid, reason, by) => fetch(`/api/purchases/shortages/${sid}/waive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, by }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('waive'), { detail: j.detail }); return j }),
  unwaiveShortage: (sid) => fetch(`/api/purchases/shortages/${sid}/unwaive`, { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('waive'), { detail: j.detail }); return j }),

  // set a line's category master mapping ('' clears it, back to auto)
  editLine: (lineId, fields) => fetch(`/api/purchases/lines/${lineId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('line'), { detail: j.detail }); return j }),
  // pin a line (or one size of it) to a product by scanned QR / barcode / SKU
  scanLineCode: (lineId, code, split_id) => fetch(`/api/purchases/lines/${lineId}/scan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, split_id }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('scan'), { detail: j.detail }); return j }),

  // inventory
  inventorySummary: () => fetch('/api/inventory/summary').then(J),
  // `held: 1` = only what this warehouse holds now; `q` searches every SKU on the
  // server; `limit` caps the answer. A catalogue of hundreds of thousands of SKUs
  // cannot be sent whole, so the screens list what is held and search the rest.
  listProducts: (params) => fetch('/api/inventory/products'
    + (params ? '?' + new URLSearchParams(params).toString() : '')).then(J),
  getProduct: (id) => fetch(`/api/inventory/products/${id}`).then(J),
  // no editProduct: a product is what its GRN made it — correct it by unposting
  // the GRN, fixing the line and posting again (stock is corrected via adjustStock)
  adjustStock: (id, new_qty, note) => fetch(`/api/inventory/products/${id}/adjust-stock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_qty, note }) }).then(J),
  generateBarcode: (id) => fetch(`/api/inventory/products/${id}/generate-barcode`, { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('bc'), { detail: j.detail }); return j }),
  lookupByCode: (code) => fetch('/api/inventory/lookup?code=' + encodeURIComponent(code))
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('lk'), { detail: j.detail }); return j }),
  labelUrl: (id) => `/api/inventory/products/${id}/label`,
  labelsUrl: (ids, status) => {
    const p = []
    if (ids && ids.length) p.push('ids=' + ids.join(','))
    if (status) p.push('status=' + status)
    return '/api/inventory/labels' + (p.length ? '?' + p.join('&') : '')
  },
  // per-piece codes: one inventory record of 8 has 8 child codes, each its own QR.
  // `status` is kept on the error because a 404 here means something specific and
  // fixable — a server still running from before this endpoint existed, serving the
  // new UI off disk — and the screen can say so instead of "could not load".
  productUnits: (id) => fetch(`/api/inventory/products/${id}/units`)
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('units'), { status: r.status, detail: j.detail }); return j }),
  generateUnits: (id) => fetch(`/api/inventory/products/${id}/units/generate`, { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('units'), { status: r.status, detail: j.detail }); return j }),
  unitQrSvgUrl: (uid, scale) => `/api/inventory/units/${uid}/qr.svg` + (scale ? `?scale=${scale}` : ''),
  unitLabelUrl: (uid) => `/api/inventory/units/${uid}/label`,
  unitLabelsUrl: (productId, ids) => (ids && ids.length)
    ? `/api/inventory/unit-labels?ids=${ids.join(',')}`
    : `/api/inventory/unit-labels?product_id=${productId}`,

  // ---- Label Designer + Label Printing ----------------------------------
  // A template stores field REFERENCES and never a product's values, so these
  // calls carry a layout in one direction and resolve data in the other. That
  // separation is the module: design once here, print anything with it below.
  // `status` is kept on the error, as askReport and productUnits do: the
  // frontend is read off disk and refreshes with the browser, but routes are
  // registered when Python starts. A backend left running from before these
  // endpoints existed serves the new screen and 404s its calls — a restart, not
  // a fault, and only a message that knows it was a 404 can say so. The shared
  // `J` helper throws a bare Error, so these two cannot use it.
  labelFields: () => fetch('/api/labels/fields')
    .then(r => { if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status }); return r.json() }),
  labelTemplates: () => fetch('/api/labels/templates')
    .then(r => { if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status }); return r.json() }),
  labelTemplate: (id) => fetch(`/api/labels/templates/${id}`).then(J),
  createLabelTemplate: (body) => fetch('/api/labels/templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('tpl'), { detail: j.detail }); return j }),
  saveLabelTemplate: (id, body) => fetch(`/api/labels/templates/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('tpl'), { detail: j.detail }); return j }),
  duplicateLabelTemplate: (id) => fetch(`/api/labels/templates/${id}/duplicate`, { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('tpl'), { detail: j.detail }); return j }),
  setDefaultLabelTemplate: (id) => fetch(`/api/labels/templates/${id}/default`, { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('tpl'), { detail: j.detail }); return j }),
  setLabelTemplateActive: (id, active) => fetch(`/api/labels/templates/${id}/active`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('tpl'), { detail: j.detail }); return j }),
  deleteLabelTemplate: (id) => fetch(`/api/labels/templates/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('tpl'), { detail: j.detail }); return j }),
  // what one label would say, with its symbols already rendered — the canvas
  // draws these itself, so a field being dragged carries its real string and an
  // overflowing description is seen while designing rather than on a sticker
  labelPreviewValues: (productId) => fetch('/api/labels/preview-values' + qs({ product_id: productId })).then(J),
  // is a QR drawn this big still scannable? The one property whose mistake is
  // invisible until the labels are on garments
  labelQrCheck: (boxMm, productId) => fetch('/api/labels/qr-check' + qs({ box_mm: boxMm, product_id: productId })).then(J),
  labelPreviewUrl: (id, productId, copies) => `/api/labels/templates/${id}/preview` + qs({ product_id: productId, copies }),
  // items: [{id, qty}] for SKU labels; unitProducts / units for per-piece ones
  labelPrintUrl: (templateId, items, opts) => {
    const o = opts || {}
    return '/api/labels/print' + qs({
      template_id: templateId,
      items: (items || []).map((i) => `${i.id}:${i.qty || 1}`).join(','),
      units: (o.units || []).join(','),
      unit_products: (o.unitProducts || []).join(','),
    })
  },

  // inventory integrity: a record is stock only if a posted GRN put it there.
  // Scan is read-only and is what the Repair screen shows before anything is
  // deleted; repair removes only debris (never a product kept after an unpost).
  integrityScan: () => fetch('/api/inventory/integrity').then(J),
  integrityRepair: (dryRun) => fetch('/api/inventory/repair' + (dryRun ? '?dry_run=true' : ''),
    { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('repair'), { detail: j.detail }); return j }),

  // Dropdown option sets (same lists the phone app uses, incl. sizes), for one
  // business line. Pass the warehouse a screen is working at and the answer is
  // that warehouse's vocabulary — which attributes apply and what each offers.
  // Passing nothing answers for the default line, as it always did.
  productOptions: (warehouseId, catalogueId) => {
    const q = new URLSearchParams()
    if (warehouseId) q.set('warehouse_id', warehouseId)
    if (catalogueId) q.set('catalogue_id', catalogueId)
    const s = q.toString()
    return fetch('/api/inventory/product-options' + (s ? '?' + s : '')).then(J)
  },
  barcodeSvgUrl: (id) => `/api/inventory/products/${id}/barcode.svg`,
  // scale drives the QR's module size — 2 is right for a list thumbnail, the
  // default 4 for the detail panel and print
  qrSvgUrl: (id, scale) => `/api/inventory/products/${id}/qr.svg` + (scale ? `?scale=${scale}` : ''),
  // map a free-text description onto one business line's Product Category master
  categorize: (description, warehouseId) =>
    fetch('/api/inventory/categorize?description=' + encodeURIComponent(description || '')
      + (warehouseId ? '&warehouse_id=' + warehouseId : '')).then(J),

  // --- catalogues: what each warehouse trades in ---
  // The categories, attributes and option lists are per business line, so Essa
  // (garments) and Taqua (silks) never see each other's.
  listCatalogues: () => fetch('/api/catalogues').then(J),
  getCatalogue: (id) => fetch(`/api/catalogues/${id}`).then(J),
  createCatalogue: (body) => fetch('/api/catalogues', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('cat'), { detail: j.detail }); return j }),
  updateCatalogue: (id, body) => fetch(`/api/catalogues/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('cat'), { detail: j.detail }); return j }),
  deleteCatalogue: (id) => fetch(`/api/catalogues/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('cat'), { detail: j.detail }); return j }),
  addCatalogueAttr: (id, body) => fetch(`/api/catalogues/${id}/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('attr'), { detail: j.detail }); return j }),
  removeCatalogueAttr: (id, key) => fetch(`/api/catalogues/${id}/attributes/${encodeURIComponent(key)}`,
    { method: 'DELETE' }).then(J),
  setAttrOptions: (id, key, values) => fetch(
    `/api/catalogues/${id}/attributes/${encodeURIComponent(key)}/options`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }) }).then(J),
  removeAttrOption: (id, key, value) => fetch(
    `/api/catalogues/${id}/attributes/${encodeURIComponent(key)}/options?value=`
    + encodeURIComponent(value), { method: 'DELETE' }).then(J),
  // --- download a master as a spreadsheet ---
  // Plain URLs, opened as links: a download carries the login cookie on its own,
  // and routing the bytes through fetch() only to rebuild a Blob would lose the
  // filename the server already set. What comes down is a file the importer
  // above reads back, so download → edit in Excel → upload is a round trip.
  attributesFileUrl: (id, format) =>
    `/api/catalogues/${id}/attributes/export?format=${format || 'xlsx'}`,
  attrOptionsFileUrl: (id, key, format) =>
    `/api/catalogues/${id}/attributes/${encodeURIComponent(key)}/options/export?format=${format || 'xlsx'}`,
  categoriesFileUrl: (id, format) =>
    `/api/catalogues/${id}/categories/export?format=${format || 'xlsx'}`,

  // --- bulk import from a spreadsheet or PDF ---
  // `commit` false (the default) previews: the server answers with exactly what
  // it WOULD write and writes nothing, so a misread layout is caught before it
  // reaches a live master.
  importAttributes: (id, file, commit) =>
    _upload(`/api/catalogues/${id}/attributes/import?commit=${!!commit}`, file),
  importAttrOptions: (id, key, file, commit) =>
    _upload(`/api/catalogues/${id}/attributes/${encodeURIComponent(key)}/options/import?commit=${!!commit}`, file),
  importCategories: (id, file, commit) =>
    _upload(`/api/catalogues/${id}/categories/import?commit=${!!commit}`, file),

  catalogueCategories: (id) => fetch(`/api/catalogues/${id}/categories`).then(J),
  addCatalogueCategory: (id, body) => fetch(`/api/catalogues/${id}/categories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('cat'), { detail: j.detail }); return j }),
  removeCatalogueCategory: (id, catId) => fetch(`/api/catalogues/${id}/categories/${catId}`,
    { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('cat'), { detail: j.detail }); return j }),
  // the full product record as the stock screens show it — QR, name, size,
  // colour, batch. Takes anything scannable: a product QR, a piece label, a SKU.
  // Item Locator: one scanned code, everything known about that item —
  // where it came from, where it is, where it went.
  locateItem: (code) => fetch('/api/inventory/locate?code=' + encodeURIComponent(code)).then(J),
  productCard: (code) => fetch('/api/inventory/product-card?code=' + encodeURIComponent(code || ''))
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('card'), { detail: j.detail }); return j }),

  // stock outward (dispatch) + stock inward (the destination accepting it)
  // `kind` narrows to transfer (warehouse → warehouse) / store / dispatch;
  // `warehouseId` returns the notes a building is either end of.
  listOutwards: (status, kind, warehouseId) => {
    const q = new URLSearchParams()
    if (status) q.set('status', status)
    if (kind && kind !== 'all') q.set('kind', kind)
    if (warehouseId) q.set('warehouse_id', warehouseId)
    const s = q.toString()
    return fetch('/api/outward' + (s ? '?' + s : '')).then(J)
  },
  // one page — { rows, total, counts }; counts are per status for the chips
  outwardsPage: ({ status, kind, warehouseId, limit, offset, q }) =>
    fetch('/api/outward' + qs({ status: status === 'all' ? '' : status,
      kind: kind === 'all' ? '' : kind, warehouse_id: warehouseId, limit, offset, q })).then(J),
  getOutward: (id) => fetch(`/api/outward/${id}`).then(J),
  // body may carry from_warehouse_id and one of to_warehouse_id / to_store_id;
  // a bad pair (same warehouse both ends, unknown place) comes back as a 400
  // with the reason, so it is surfaced rather than swallowed by J
  createOutward: (body) => fetch('/api/outward', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('create'), { detail: j.detail }); return j }),
  postOutward: (id, allowNeg) => fetch(`/api/outward/${id}/post?allow_negative=${!!allowNeg}`, { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('post'), { detail: j.detail }); return j }),
  // stock inward: accept a dispatched transfer, line by line
  receiveOutward: (id, body) => fetch(`/api/outward/${id}/receive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('recv'), { detail: j.detail }); return j }),
  // is this scanned garment on this transfer, and which line?
  verifyOutward: (id, code) => fetch(`/api/outward/${id}/verify?code=` + encodeURIComponent(code || ''))
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('verify'), { detail: j.detail }); return j }),

  // payments
  pendingBills: (supplierId) => fetch(`/api/payments/pending${supplierId ? '?supplier_id=' + supplierId : ''}`).then(J),
  listPayments: () => fetch('/api/payments').then(J),
  createPayment: (body) => fetch('/api/payments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(J),
  supplierLedger: (id) => fetch(`/api/payments/supplier/${id}/ledger`).then(J),

  // purchase returns
  listReturns: () => fetch('/api/returns').then(J),
  getReturn: (id) => fetch(`/api/returns/${id}`).then(J),
  // `shortagesOnly` claims the goods that never arrived on their own — the usual
  // case, since a short delivery is chased long before anyone knows whether what
  // did arrive is any good. Shortage lines come back pre-filled: the count was
  // done at the dock, so nobody counts again.
  buildReturn: (purchaseId, shortagesOnly) => fetch(
    `/api/returns/from-purchase/${purchaseId}` + (shortagesOnly ? '?shortages_only=true' : ''),
    { method: 'POST' }).then(J),
  postReturn: (id, body) => fetch(`/api/returns/${id}/post`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('post'), { detail: j.detail }); return j }),

  // masters
  categories: (q) => fetch('/api/masters/categories' + (q ? '?q=' + encodeURIComponent(q) : '')).then(J),
  agents: () => fetch('/api/masters/agents').then(J),
  transports: () => fetch('/api/masters/transports').then(J),
  // the small keyed dropdown lists (company, city, rack, section, modes, …)
  masterOptions: () => fetch('/api/masters/options').then(J),
  addMasterOption: (kind, value) => fetch('/api/masters/options', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, value }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('opt'), { detail: j.detail }); return j }),
  deleteMasterOption: (kind, value) => fetch(
    `/api/masters/options?kind=${encodeURIComponent(kind)}&value=${encodeURIComponent(value)}`,
    { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('opt'), { detail: j.detail }); return j }),

  // unit types: how many individual items are in one of a unit (a pair is 2, a
  // dozen is 12), plus the rules that say which unit a product is. Together they
  // are what turns a billed dozen into 12 handkerchiefs or 6 pairs of pillow
  // covers — and into that many QR labels.
  unitTypes: () => fetch('/api/masters/unit-types').then(J),
  addUnitType: (body) => fetch('/api/masters/unit-types', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('ut'), { detail: j.detail }); return j }),
  editUnitType: (code, fields) => fetch(`/api/masters/unit-types/${encodeURIComponent(code)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('ut'), { detail: j.detail }); return j }),
  deleteUnitType: (code) => fetch(`/api/masters/unit-types/${encodeURIComponent(code)}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('ut'), { detail: j.detail }); return j }),
  addUnitRule: (body) => fetch('/api/masters/unit-rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('ur'), { detail: j.detail }); return j }),
  deleteUnitRule: (id) => fetch(`/api/masters/unit-rules/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('ur'), { detail: j.detail }); return j }),
  // "1 DOZ → 12 pcs → 6 PAIR · 6 QR label(s)" for a quantity, before it is posted
  unitPreview: (params) => fetch('/api/masters/unit-preview' + qs(params)).then(J),

  // The 17 ERP masters. One set of endpoints for all of them: the shape of each
  // comes from its definition (services/master_defs.py), so a field added there
  // is typed, validated and saved without anything changing here.
  masterList: () => fetch('/api/master-data').then(J),
  masterDefinition: (key) => fetch(`/api/master-data/${key}/definition`).then(J),
  masterRecords: (key, q) => fetch(`/api/master-data/${key}/records` + qs({ q })).then(J),
  masterRecord: (key, id) => fetch(`/api/master-data/${key}/records/${id}`).then(J),
  masterCreate: (key, body) => fetch(`/api/master-data/${key}/records`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('m'), { detail: j.detail }); return j }),
  masterUpdate: (key, id, body) => fetch(`/api/master-data/${key}/records/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('m'), { detail: j.detail }); return j }),
  masterDelete: (key, id) => fetch(`/api/master-data/${key}/records/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('m'), { detail: j.detail }); return j }),

  // ---- Locations: warehouse → store → POS terminal ----------------------
  // The tree read runs the backfill server-side, so a database that predates
  // these tables answers with its existing branches already turned into stores
  // rather than looking empty. `status` is kept on the error the way
  // labelFields does it: a 404 here is a backend started before this module
  // existed, which is a restart rather than a fault.
  // the central dashboard: company totals plus a row per warehouse, in one call
  locationOverview: (days, warehouseId) => {
    const q = new URLSearchParams()
    if (days) q.set('days', days)
    if (warehouseId) q.set('warehouse_id', warehouseId)
    const s = q.toString()
    return fetch('/api/locations/overview' + (s ? '?' + s : '')).then(J)
  },
  // What the shops sold, per branch. A SEPARATE call from the overview on
  // purpose: it reads the till's own database, which can be absent or switched
  // off, and folding it in would let that take the whole dashboard down.
  storeSales: (days, warehouseId) => {
    const q = new URLSearchParams()
    if (days) q.set('days', days)
    if (warehouseId) q.set('warehouse_id', warehouseId)
    const s = q.toString()
    return fetch('/api/locations/sales' + (s ? '?' + s : '')).then(J)
  },
  warehouseStock: (id, limit) => fetch(`/api/locations/warehouses/${id}/stock`
    + (limit ? '?limit=' + limit : '')).then(J),
  rebuildStock: () => fetch('/api/locations/rebuild-stock', { method: 'POST' }).then(J),

  locationTree: () => fetch('/api/locations')
    .then(r => { if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status }); return r.json() }),
  // The stores one warehouse supplies. Used by the chrome to call the selling
  // side by the name somebody gave it rather than "POS", so the menu names a
  // place instead of a piece of equipment.
  stores: (warehouse_id) => fetch('/api/locations/stores'
    + qs(warehouse_id ? { warehouse_id } : {})).then(J),
  // The type vocabulary and the company list the location form picks from, read
  // from the server rather than repeated here — see the endpoint's own note.
  locationFormOptions: () => fetch('/api/locations/form-options').then(J),
  createWarehouse: (body) => fetch('/api/locations/warehouses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('wh'), { detail: j.detail }); return j }),
  updateWarehouse: (id, body) => fetch(`/api/locations/warehouses/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('wh'), { detail: j.detail }); return j }),
  deleteWarehouse: (id) => fetch(`/api/locations/warehouses/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('wh'), { detail: j.detail }); return j }),
  createStore: (body) => fetch('/api/locations/stores', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('st'), { detail: j.detail }); return j }),
  updateStore: (id, body) => fetch(`/api/locations/stores/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('st'), { detail: j.detail }); return j }),
  deleteStore: (id) => fetch(`/api/locations/stores/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('st'), { detail: j.detail }); return j }),
  // Price changer — what things sell for, one item or in bulk.
  pricingOptions: () => fetch('/api/pricing/options')
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pr'), { detail: j.detail }); return j }),
  pricingProducts: (params) => fetch('/api/pricing/products?' + new URLSearchParams(
      Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== '' && v != null))))
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pr'), { detail: j.detail }); return j }),
  pricingPreview: (body) => fetch('/api/pricing/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pr'), { detail: j.detail }); return j }),
  pricingApply: (body) => fetch('/api/pricing/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pr'), { detail: j.detail }); return j }),
  pricingRevisions: () => fetch('/api/pricing/revisions')
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pr'), { detail: j.detail }); return j }),
  pricingRevision: (id) => fetch(`/api/pricing/revisions/${id}`)
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pr'), { detail: j.detail }); return j }),
  pricingRevert: (id) => fetch(`/api/pricing/revisions/${id}/revert`, { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pr'), { detail: j.detail }); return j }),
  pricingHistory: (pid) => fetch(`/api/pricing/products/${pid}/history`)
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pr'), { detail: j.detail }); return j }),

  // Floors — the storey a till stands on, and the bill prefix its sales carry.
  createFloor: (body) => fetch('/api/locations/floors', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('fl'), { detail: j.detail }); return j }),
  updateFloor: (id, body) => fetch(`/api/locations/floors/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('fl'), { detail: j.detail }); return j }),
  deleteFloor: (id) => fetch(`/api/locations/floors/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('fl'), { detail: j.detail }); return j }),

  createTerminal: (body) => fetch('/api/locations/terminals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pos'), { detail: j.detail }); return j }),
  updateTerminal: (id, body) => fetch(`/api/locations/terminals/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pos'), { detail: j.detail }); return j }),
  deleteTerminal: (id) => fetch(`/api/locations/terminals/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('pos'), { detail: j.detail }); return j }),

  // LR entry
  // ------------------------------------------------------------------------
  //  Purchase orders — the first document in the chain
  //  ----------------------------------------------------------------------
  //  `poOpen` is deliberately its own call rather than poList({status:'confirmed'}):
  //  "which orders may goods be booked in against" has one right answer, and the
  //  LR form must not be able to get a different one by changing a filter.
  // ------------------------------------------------------------------------
  poList: (filters) => fetch('/api/purchase-orders' + qs(filters)).then(J),
  poOpen: (supplier_name) => fetch('/api/purchase-orders/open'
    + qs(supplier_name ? { supplier_name } : {})).then(J),
  poGet: (id) => fetch(`/api/purchase-orders/${id}`).then(J),
  poStatuses: () => fetch('/api/purchase-orders/statuses').then(J),
  poCreate: (body) => fetch('/api/purchase-orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('po'), { detail: j.detail }); return j }),
  poUpdate: (id, fields) => fetch(`/api/purchase-orders/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('po'), { detail: j.detail }); return j }),
  poStatus: (id, status, extra) => fetch(`/api/purchase-orders/${id}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, ...(extra || {}) }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('po'), { detail: j.detail }); return j }),
  poDelete: (id) => fetch(`/api/purchase-orders/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('po'), { detail: j.detail }); return j }),
  // Photograph or upload an order and have it read. Returns a DRAFT and saves
  // nothing — the form fills itself from it, the person corrects it, and the
  // ordinary poCreate above is what writes the order. Asked about first, so the
  // button can say why it is not there rather than failing on a press.
  // ------------------------------------------------------------------------
  //  Stock audit — counting the shelf against the books
  //  ----------------------------------------------------------------------
  //  `auditScan` is one round trip on purpose: it returns the finding AND the
  //  new tally, because the phone this is shared with runs on warehouse wifi
  //  and a screen needing three calls per scan would feel broken long before it
  //  actually was.
  // ------------------------------------------------------------------------
  auditCurrent: () => fetch('/api/stock-audit/current').then(J),
  auditList: () => fetch('/api/stock-audit').then(J),
  auditGet: (id) => fetch(`/api/stock-audit/${id}`).then(J),
  auditOpen: (note) => fetch('/api/stock-audit/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note || null }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('audit'), { detail: j.detail }); return j }),
  auditScan: (id, code) => fetch(`/api/stock-audit/${id}/scan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('audit'), { detail: j.detail }); return j }),
  auditClose: (id) => fetch(`/api/stock-audit/${id}/close`, { method: 'POST' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('audit'), { detail: j.detail }); return j }),
  auditDropScan: (id, scanId) => fetch(`/api/stock-audit/${id}/scans/${scanId}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('audit'), { detail: j.detail }); return j }),

  // ------------------------------------------------------------------------
  //  Physical Stock Audit — counting the warehouse by QUANTITY
  //  ----------------------------------------------------------------------
  //  The other audit, and not a bigger version of the one above. That one asks
  //  "is this on the shelf" and answers per tag; this asks "how many are there"
  //  over a filtered set of stock and ends in a variance somebody approves.
  //
  //  Every call here carries the server's own sentence on refusal rather than a
  //  status code, because most of them CAN refuse for a reason a person needs to
  //  read — the count is closed, the item is outside the filters, no change
  //  reason was given. `PJ` is that: J, plus the detail.
  // ------------------------------------------------------------------------
  psaOptions: () => fetch('/api/physical-audit/options').then(J),
  psaSearchOption: (key, q) => fetch(`/api/physical-audit/options/${key}?q=${encodeURIComponent(q)}`).then(J),
  psaPreview: (filters) => PJ('/api/physical-audit/preview', { filters }),
  psaCurrent: () => fetch('/api/physical-audit/current').then(J),
  psaList: () => fetch('/api/physical-audit').then(J),
  psaGet: (id) => fetch(`/api/physical-audit/${id}`).then(J),
  psaOpen: (filters, note) => PJ('/api/physical-audit/open', { filters, note: note || null }),
  // A blank qty CLEARS the row — "nobody has counted this" is a real state and
  // is not the same as zero. See services/physical_audit.clear.
  psaCount: (id, lineId, qty, note) =>
    PJ(`/api/physical-audit/${id}/lines/${lineId}/count`,
      { qty: qty === '' || qty == null ? null : Number(qty), note }),
  psaScan: (id, code, qty) => PJ(`/api/physical-audit/${id}/scan`, { code, qty: qty || 1 }),
  psaAdd: (id, productId) => PJ(`/api/physical-audit/${id}/add/${productId}`, {}),
  psaDropLine: (id, lineId) => fetch(`/api/physical-audit/${id}/lines/${lineId}`,
    { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('psa'), { detail: j.detail }); return j }),
  psaUpload: (id, rows) => PJ(`/api/physical-audit/${id}/upload`, { rows }),
  psaSync: (id) => PJ(`/api/physical-audit/${id}/synchronize`, {}),
  psaStatus: (id, status) => PJ(`/api/physical-audit/${id}/status`, { status }),
  psaApply: (id, reason) => PJ(`/api/physical-audit/${id}/apply`, { reason }),
  psaReason: (id, change_reason) => fetch(`/api/physical-audit/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ change_reason }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('psa'), { detail: j.detail }); return j }),

  poExtractStatus: () => fetch('/api/purchase-orders/extract/status').then(J),
  poExtract: (file) => { const fd = new FormData(); fd.append('file', file)
    return fetch('/api/purchase-orders/extract', { method: 'POST', body: fd })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('po'), { detail: j.detail }); return j }) },

  lrExtract: (file) => { const fd = new FormData(); fd.append('file', file);
    return fetch('/api/lr/extract', { method: 'POST', body: fd }).then(J) },
  lrSave: (document_id, rows) => fetch('/api/lr/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document_id, rows }) }).then(J),
  lrList: () => fetch('/api/lr').then(J),
  // one page of the WHOLE register — { rows, total }; limit 0 = every entry
  lrPage: ({ limit, offset }) => fetch('/api/lr' + qs({ paged: 'true', limit, offset })).then(J),
  // the dashboard's LR figures over the whole register: { total, pending, unlinked }
  lrSummary: () => fetch('/api/lr/summary').then(J),
  lrGet: (id) => fetch(`/api/lr/${id}`).then(J),
  // key in ONE consignment (the LR Entry form's Save / Save&Next)
  lrCreate: (body) => fetch('/api/lr', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('lr'), { detail: j.detail }); return j }),
  // partial edit — freight settlement on delivery, the rack once put away, or
  // any other field on the entry. Only what you send is touched.
  lrUpdate: (id, fields) => fetch(`/api/lr/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('lr'), { detail: j.detail }); return j }),
  lrDelete: (id) => fetch(`/api/lr/${id}`, { method: 'DELETE' })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('lr'), { detail: j.detail }); return j }),
  lrSearch: (filters) => {
    const p = new URLSearchParams()
    Object.entries(filters || {}).forEach(([k, v]) => { if (v) p.append(k, v) })
    return fetch('/api/lr/search' + (p.toString() ? '?' + p : '')).then(J)
  },
  lrAddAttachment: (id, file, doc_type) => {
    const fd = new FormData(); fd.append('file', file); fd.append('doc_type', doc_type || '')
    return fetch(`/api/lr/${id}/attachments`, { method: 'POST', body: fd })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('att'), { detail: j.detail }); return j })
  },
  lrDeleteAttachment: (attId) => fetch(`/api/lr/attachments/${attId}`, { method: 'DELETE' }).then(J),

  // Dead stock & clearance. The register, the dashboard, the alerts and the
  // summary are all the same server-side read, grouped differently — which is
  // why they are four calls and not one screen holding four copies of the data.
  //
  // `status` is kept on the error the way dashboardCharts does it: a 404 here is
  // a backend started before this module existed, which is a restart rather than
  // a fault, and the screen can say so instead of showing "failed".
  deadStock: (filters) => fetch('/api/dead-stock/register' + qs(filters))
    .then(r => { if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status }); return r.json() }),
  deadStockSummary: () => fetch('/api/dead-stock/summary')
    .then(r => { if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status }); return r.json() }),
  deadStockAlerts: () => fetch('/api/dead-stock/alerts')
    .then(r => { if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status }); return r.json() }),
  deadStockRules: () => fetch('/api/dead-stock/rules').then(J),
  saveDeadStockRules: (body) => fetch('/api/dead-stock/rules', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('rules'), { detail: j.detail }); return j }),
  clearanceList: (status) => fetch('/api/dead-stock/campaigns' + qs({ status })).then(J),
  clearanceGet: (id) => fetch(`/api/dead-stock/campaigns/${id}`).then(J),
  clearanceCreate: (body) => fetch('/api/dead-stock/campaigns', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('c'), { detail: j.detail }); return j }),
  clearanceUpdate: (id, body) => fetch(`/api/dead-stock/campaigns/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('c'), { detail: j.detail }); return j }),
  clearanceDelete: (id) => fetch(`/api/dead-stock/campaigns/${id}`, { method: 'DELETE' }).then(J),
  clearanceAddLines: (id, product_ids, actions) => fetch(`/api/dead-stock/campaigns/${id}/lines`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_ids, actions: actions || {} }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('c'), { detail: j.detail }); return j }),
  clearanceUpdateLine: (id, lineId, body) => fetch(`/api/dead-stock/campaigns/${id}/lines/${lineId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('c'), { detail: j.detail }); return j }),
  clearanceDeleteLine: (id, lineId) => fetch(`/api/dead-stock/campaigns/${id}/lines/${lineId}`, { method: 'DELETE' }).then(J),

  // Notifications. The bell polls `notificationCount` (four numbers); the panel
  // and the dashboard read the whole feed. Both are the same server-side pass
  // over the queues, so they can never disagree about what is open.
  notifications: () => fetch('/api/notifications')
    .then(r => { if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status }); return r.json() }),
  notificationCount: () => fetch('/api/notifications/count')
    .then(r => { if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status }); return r.json() }),
  notificationsRead: (keys, by) => fetch('/api/notifications/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys, by }) }).then(J),
  notificationsReadAll: (by) => fetch('/api/notifications/read-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by }) }).then(J),
  notificationMute: (key, muted, by) => fetch('/api/notifications/mute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, muted, by }) }).then(J),
  notificationsMuted: () => fetch('/api/notifications/muted').then(J),
  notificationRecipients: () => fetch('/api/notifications/recipients').then(J),
  addRecipient: (body) => fetch('/api/notifications/recipients', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('r'), { detail: j.detail }); return j }),
  updateRecipient: (id, body) => fetch(`/api/notifications/recipients/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('r'), { detail: j.detail }); return j }),
  deleteRecipient: (id) => fetch(`/api/notifications/recipients/${id}`, { method: 'DELETE' }).then(J),

  // Voice into a master form. Only non-English speech comes here (or English the
  // local matcher could not place): Tamil is transcribed as Tamil, and a master
  // record has to come out in English — the labels, the dropdown vocabularies and
  // every later search are English. See services/voice_form.py.
  voiceStatus: () => fetch('/api/voice/status').then(J),
  voiceFill: (master, transcript, fields, language) => fetch('/api/voice/fill', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ master, transcript, fields, language }) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('v'), { detail: j.detail }); return j }),
  // The same understanding, for a form that is not a master record — the
  // purchase order. The form sends its OWN fields, which is what keeps the
  // labels in one place: it renders from them and dictates against them, with no
  // second copy on the server to drift the first time one is renamed.
  voiceFillForm: (form_fields, transcript, { label, only, language } = {}) =>
    fetch('/api/voice/fill-form', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form_fields, transcript, label, only, language }) })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('v'), { detail: j.detail }); return j }),

  // reports. Each catalogue entry declares the filters it accepts (`params`);
  // the server drops anything a given report doesn't take, so both calls can
  // pass the same bag without a per-report branch.
  reportCatalogue: () => fetch('/api/reports').then(J),
  // The Store's own Sales / Retail Reports menu. null = the Store is not signed
  // in (the shop answers with its login page); [] = the POS is not mounted here.
  storeReportCatalogue: () => fetch('/pos/reports/retail-catalogue').then((r) => {
    if (r.status === 404) return []
    return r.ok && (r.headers.get('content-type') || '').includes('json') ? r.json() : null
  }),
  reportGroups: () => fetch('/api/reports/groups').then(J),
  runReport: (key, params) => fetch(`/api/reports/${key}${qs(params)}`).then(J),
  reportCsvUrl: (key, params) => `/api/reports/${key}/csv${qs(params)}`,
  // Ask a question instead of picking a report and setting filters. POST because
  // the question is free text in any script — Tamil in a query string is a
  // percent-encoding problem nobody needs.
  askReport: (q) => fetch('/api/reports/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q }) })
    .then(async r => { const j = await r.json().catch(() => ({}))
      // `status` is kept because 404/405 here means something specific and
      // fixable — a server still running from before this endpoint existed,
      // serving the new UI off disk — and the screen can say so.
      if (!r.ok) throw Object.assign(new Error('ask'), { status: r.status, detail: j.detail })
      return j }),
  reportAskExamples: () => fetch('/api/reports/ask-examples').then(J),

  // ---- the Command Center ----
  // Every tile, chart, list and alert in one call; `day` looks at another
  // business day. `status` is kept on the errors for the same reason askReport
  // does it: a 404 here is a server started before this module existed.
  commandOverview: (day, warehouseId) => fetch('/api/command/overview' + qs({ day, warehouse_id: warehouseId }))
    .then(async r => { const j = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error('command'), { status: r.status, detail: j.detail })
      return j }),
  // One question, one line back. Also how a code is tracked: a GRN, bill or QR
  // typed into the same box is traced rather than read.
  commandAsk: (q) => fetch('/api/command/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q }) })
    .then(async r => { const j = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error('ask'), { status: r.status, detail: j.detail })
      return j }),
  commandTrace: (code, kind, ref) => fetch('/api/command/trace' + qs({ code, kind, ref }))
    .then(async r => { const j = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error('trace'), { status: r.status, detail: j.detail })
      return j }),
  commandExamples: () => fetch('/api/command/examples').then(J),
  // Who did what, when and where. The filters the screen offers ride along with
  // the rows, so it cannot offer a module nothing was ever recorded under.
  auditEvents: (filters) => fetch('/api/audit' + qs(filters))
    .then(async r => { const j = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error('audit'), { status: r.status, detail: j.detail })
      return j }),

  // settings / vision
  getSettings: () => fetch('/api/settings').then(J),
  setVisionKey: (api_key, model) => fetch('/api/settings/vision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key, model }) }).then(J),
  listModels: () => fetch('/api/settings/models').then(J),
  setModel: (model) => fetch('/api/settings/model', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }) }).then(J),
  turnOffVision: () => fetch('/api/settings/vision/off', { method: 'POST' }).then(J),
}
