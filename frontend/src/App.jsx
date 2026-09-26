import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { api, session, warehouse, setUnauthorizedHandler, asWarehouse } from './api.js'
import { useCached, load as cacheLoad, reset as resetCache, remember, recall, trim as cacheTrim } from './dashcache.js'
import { parseDictation, coerceSpoken, dictationTargets } from './voicefill.js'

// ---------- helpers ----------
const num = (v) => (v === '' || v == null ? null : isNaN(+v) ? v : +v)
const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
// A count, grouped the Indian way. `nf` further down is a number PARSER — a
// figure passed through it prints 252000 where the rest of the app says 2,52,000.
const n0 = (v) => Number(v || 0).toLocaleString('en-IN')
const confClass = (c) => (c == null ? '' : c >= 0.9 ? 'hi' : c >= 0.6 ? 'mid' : 'lo')
// Steps a headline figure down one size once it stops fitting on a single line.
// A rupee total is three times the width of a count, and at the headline size
// "₹ 1,03,389.00" broke across two lines mid-number — which reads as a mistake
// and, worse, made that one tile taller than every other tile in its row.
// Counted in characters because no CSS length unit knows how many digits a
// number has.
const longValue = (v) => String(v ?? '').length >= 12

// text filter helpers
const matches = (obj, q, fields) => {
  if (!q) return true
  const s = q.toLowerCase()
  return fields.some((f) => String(obj?.[f] ?? '').toLowerCase().includes(s))
}
// ==========================================================================
//  Search · Filter · Minimize
//  ------------------------------------------------------------------------
//  Three controls, one behaviour, on every list screen — GRN, Inventory,
//  Purchase Return, Stock Outward, Stock Inward, Documents, Suppliers, LR and
//  Reports. Someone who learns them on one screen already knows them on the
//  rest, which is the whole point: this is a warehouse tool used by people who
//  were trained on the screen next to them, not on a manual.
//
//  The rules they all keep:
//    * ⌕ SEARCH filters what is already on screen. Esc clears it.
//    * ⛭ FILTER decides what is on screen at all, and always says how many
//      filters are active — a filtered list that looks unfiltered is how someone
//      concludes stock has gone missing.
//    * − MINIMIZE collapses a panel and remembers it, per screen, across
//      navigation and reloads. A collapsed panel still shows what it holds.
//  Every icon carries a title= too. An icon on its own teaches nobody.
// ==========================================================================

// ==========================================================================
//  Pagination
//  ------------------------------------------------------------------------
//  Every list in this app grows without limit — a register gains rows every
//  day, inventory gains a product per variant received, the category master
//  already holds 686. Rendering all of them put thousands of DOM nodes on a
//  screen nobody can read, and "how many are there" could only be answered by
//  scrolling to the bottom.
//
//  One hook and one control, used everywhere, so paging behaves identically
//  whichever list you are on: the same page sizes, the same "1–50 of 686", the
//  same keys. A component that each screen implemented its own way would drift
//  into six subtly different behaviours.
// ==========================================================================
const PAGE_SIZES = [25, 50, 100, 200]

function usePaged(rows, initial = 50) {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(initial)
  const list = rows || []
  const total = list.length
  const pages = size === 0 ? 1 : Math.max(1, Math.ceil(total / size))
  // A filter that shortens the list must not strand you on page 9 of 3 looking
  // at an empty screen — which reads as "the search found nothing".
  useEffect(() => { if (page > pages) setPage(1) }, [pages, page])
  const start = size === 0 ? 0 : (page - 1) * size
  return {
    page, setPage, size, setSize, total, pages,
    from: total === 0 ? 0 : start + 1,
    to: size === 0 ? total : Math.min(total, start + size),
    slice: size === 0 ? list : list.slice(start, start + size),
  }
}

// A value that follows `value` once it has stopped changing for `ms` — so a
// search box asks the server once per pause, not once per keystroke.
function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

// usePaged, with the SERVER holding the list. For the lists that grew too big
// to send whole — tens of thousands of GRNs and dispatches, 10–17 MB each.
// `fetchPage({ limit, offset })` must resolve to { rows, total, counts? };
// `key` is everything else the page depends on (search, filter chip), and a
// change to it goes back to page 1. Same shape as usePaged, so <Pager> is
// unchanged, plus `rows` (this page), `counts` and `reload`.
function useServerPaged(fetchPage, key, initial = 50) {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(initial)
  const [res, setRes] = useState({ rows: [], total: 0, counts: {} })
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)                 // only the newest request may land
  useEffect(() => { setPage(1) }, [key])
  const reload = useCallback(() => {
    const mine = ++seq.current
    setLoading(true)
    return fetchPage({ limit: size, offset: size === 0 ? 0 : (page - 1) * size })
      .then((r) => { if (mine === seq.current) setRes({ rows: r.rows || [], total: r.total || 0, counts: r.counts || {} }) })
      .catch(() => {})
      .finally(() => { if (mine === seq.current) setLoading(false) })
  }, [page, size, key])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reload() }, [reload])
  const total = res.total
  const pages = size === 0 ? 1 : Math.max(1, Math.ceil(total / size))
  useEffect(() => { if (page > pages) setPage(1) }, [pages, page])
  const start = size === 0 ? 0 : (page - 1) * size
  return {
    page, setPage, size, setSize, total, pages,
    from: total === 0 ? 0 : start + 1,
    to: size === 0 ? total : Math.min(total, start + size),
    slice: res.rows, rows: res.rows, counts: res.counts, loading, reload,
  }
}

function Pager({ page, setPage, size, setSize, total, pages, from, to,
                 noun = 'row', nouns, style }) {
  // Nothing to page through, and no page-size choice worth offering: a bar under
  // a list of four is noise. The screens carry their own counts already.
  if (total <= PAGE_SIZES[0]) return null
  const go = (p) => setPage(Math.min(pages, Math.max(1, p)))
  return (
    <div className="pager" style={style}>
      <span className="pager-count">
        <b>{from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')}</b>
        {' of '}<b>{total.toLocaleString('en-IN')}</b>{' '}
        {total === 1 ? noun : (nouns || noun + 's')}
      </span>
      <label className="pager-size">
        Show
        <select value={size} onChange={(e) => { setSize(+e.target.value); setPage(1) }}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          <option value={0}>All</option>
        </select>
      </label>
      <div className="pager-nav">
        <button className="btn" disabled={page <= 1} onClick={() => go(1)} title="First page">«</button>
        <button className="btn" disabled={page <= 1} onClick={() => go(page - 1)}>‹ Previous</button>
        <span className="pager-page">Page {page} of {pages}</span>
        <button className="btn" disabled={page >= pages} onClick={() => go(page + 1)}>Next ›</button>
        <button className="btn" disabled={page >= pages} onClick={() => go(pages)} title="Last page">»</button>
      </div>
    </div>
  )
}

function SearchBox({ value, onChange, placeholder, style, title }) {
  return (
    <div className="searchbox" style={style}
      title={title || 'Search within what is shown. Esc clears it.'}>
      <span className="searchicon">⌕</span>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || 'Search…'}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.preventDefault(); onChange('') } }} />
      {value && <button className="searchclear" title="Clear the search (Esc)"
        onClick={() => onChange('')}>×</button>}
    </div>
  )
}

// Mutually exclusive scopes — the common filter, and the one worth showing
// open rather than behind a button. `options`: [value, label, count?, tooltip?]
function FilterChips({ value, onChange, options, title }) {
  return (
    <div className="chiprow" title={title || 'Filter which records are listed'}>
      {options.map(([v, label, count, tip]) => (
        <button key={v} className={'fchip' + (value === v ? ' on' : '')}
          title={tip || `Show ${String(label).toLowerCase()}`}
          onClick={() => onChange(v)}>
          {label}{count != null && <span className="n">{count}</span>}
        </button>
      ))}
    </div>
  )
}

// Anything richer than a chip row lives behind this: a labelled disclosure that
// states how many filters are on, and can always be cleared in one click.
function FilterButton({ open, onToggle, active, title }) {
  return (
    <button className={'filterbtn' + (open || active ? ' on' : '')} onClick={onToggle}
      title={title || (active
        ? `${active} filter${active === 1 ? '' : 's'} active — click to change or clear`
        : 'Filter which records are listed')}>
      <span aria-hidden="true">⛭</span> Filters
      {active > 0 && <span className="count">{active}</span>}
      <span style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
    </button>
  )
}

function FilterPanel({ open, active, onClear, onApply, children, hint }) {
  if (!open) return null
  return (
    <div className="filterpanel">
      <div className="row">{children}</div>
      <div className="filterfoot">
        <span className="small" style={{ color: 'var(--muted)' }}>
          {hint || (active ? `${active} filter${active === 1 ? '' : 's'} active` : 'No filters set — everything is listed')}
        </span>
        <div style={{ flex: 1 }} />
        {onApply && <button className="btn primary" onClick={onApply} title="Run with these filters">Apply</button>}
        <button className="btn" onClick={onClear} disabled={!active}
          title={active ? 'Remove every filter' : 'Nothing to clear'}>Clear all</button>
      </div>
    </div>
  )
}

// Collapsed panels are remembered per screen and survive a reload, because a
// warehouse screen is set up once for how someone works and then left alone.
const MINI_KEY = 'essa_minimized'
const readMinimized = () => {
  try { return JSON.parse(localStorage.getItem(MINI_KEY) || '{}') } catch { return {} }
}
function useMinimized(id, defaultOpen = true) {
  const [open, setOpen] = useState(() => {
    const saved = readMinimized()[id]
    return saved === undefined ? defaultOpen : !saved
  })
  const toggle = () => setOpen((o) => {
    const next = !o
    try {
      const all = readMinimized()
      if (next === defaultOpen) delete all[id]; else all[id] = !next
      localStorage.setItem(MINI_KEY, JSON.stringify(all))
    } catch { /* private mode — the panel still toggles, it just won't persist */ }
    return next
  })
  return [open, toggle]
}

// The list down the left of most screens, with a collapse.
//
// Same three rules the panels keep: it slides away, it is remembered per screen
// across navigation and reloads, and collapsed it still says what it holds — the
// title and the count stay legible down the rail. A list that vanishes with no
// trace of itself is a missing feature, not a hidden one, and the way back has to
// be visible from where it went.
//
// The content stays mounted and is clipped rather than unmounted, so the width
// genuinely animates instead of the panel popping between two states. It is
// `visibility: hidden` while collapsed, which also takes it out of the tab order —
// a keyboard user should not travel through a list they cannot see.
function Sidebar({ id, label, children, width }) {
  const [open, toggle] = useMinimized('side.' + id, true)
  return (
    <div className={'sidebar' + (open ? '' : ' collapsed')}
      style={width && open ? { width, minWidth: width } : undefined}>
      {open ? (
        <button className="sidehide" onClick={toggle}
          title={`Hide the ${label.toLowerCase()} list — the screen keeps this setting`}>«</button>
      ) : (
        <button className="siderail" onClick={toggle} title={`Show the ${label.toLowerCase()} list`}>
          <span className="chev" aria-hidden="true">»</span>
          <span className="raillabel">{label}</span>
        </button>
      )}
      <div className="sidebody" style={width ? { width, minWidth: width } : undefined}>{children}</div>
    </div>
  )
}

// A section with a minimize control. `summary` is what it says while collapsed —
// a minimized panel that doesn't say what it holds is just a missing panel.
function Section({ id, title, summary, actions, children, defaultOpen = true, style }) {
  const [open, toggle] = useMinimized(id, defaultOpen)
  return (
    <div className="section" style={style}>
      <div className="panelhead" onClick={toggle}
        title={open ? 'Minimize this panel' : 'Expand this panel'}>
        <button className="mini" aria-expanded={open}
          title={open ? 'Minimize' : 'Expand'} onClick={(e) => { e.stopPropagation(); toggle() }}>
          {open ? '−' : '+'}
        </button>
        <h4>{title}</h4>
        {!open && summary ? <span className="panelsum">{summary}</span> : null}
        {actions && open ? <span onClick={(e) => e.stopPropagation()}>{actions}</span> : null}
      </div>
      {open && children}
    </div>
  )
}

// The ESSA-AI logo mark — the letters "AI" (rotating during the login intro)
function AiLogo({ size = 120 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="120" y2="120">
          <stop offset="0" stopColor="#2F8F68" /><stop offset="1" stopColor="#0B3D2E" />
        </linearGradient>
      </defs>
      {/* gradient ring + a rotating orbit dot for flair */}
      <circle cx="60" cy="60" r="54" stroke="url(#lg)" strokeWidth="2.5" opacity="0.3" />
      <circle cx="60" cy="60" r="54" stroke="url(#lg)" strokeWidth="2.5" strokeDasharray="70 250" strokeLinecap="round" />
      <circle cx="114" cy="60" r="3.5" fill="url(#lg)" />
      {/* the letters A I */}
      <text x="60" y="63" textAnchor="middle" dominantBaseline="central"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        fontSize="52" fontWeight="800" letterSpacing="2" fill="url(#lg)">AI</text>
    </svg>
  )
}

function LoginScreen({ onLogin }) {
  const [phase, setPhase] = useState('intro')   // intro (logo spins) -> form (smoke reveal)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { const t = setTimeout(() => setPhase('form'), 2200); return () => clearTimeout(t) }, [])

  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const r = await api.login(username.trim(), password)
      onLogin(r.token, r.user, r.role, r.permissions)
    } catch (e) { setErr(e.detail || 'Login failed'); setBusy(false) }
  }

  return (
    <div className="login-wrap">
      <div className="login-bg" />
      <div className={'login-logo ' + phase}><AiLogo size={130} /></div>
      {phase === 'form' && <>
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className={'smoke smoke-' + i} />)}
        <form className="login-card" onSubmit={submit}>
          <div className="login-brand"><span className="th-logo" aria-hidden="true">E</span>
            Essa <span>· ERP</span></div>
          <div className="login-sub">Enterprise ERP · sign in to continue</div>
          <div className="field"><label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></div>
          <div className="field"><label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••" /></div>
          {err && <div className="login-err">{err}</div>}
          <button className="btn primary" style={{ width: '100%', marginTop: 6 }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </>}
    </div>
  )
}

// ---------- dates ----------
// Every date in this app is a calendar picker, and every date it stores is ISO
// `YYYY-MM-DD`. The picker is the easy half; the hard half is that dates already
// in the database came off supplier invoices and register pages in whatever form
// those used — 31/07/2026, 31-7-26, "31 Jul 2026". A native <input type="date">
// shows a non-ISO value as BLANK, so pointing one at that data would look exactly
// like the date had been lost, and the first save would make it true.
//
// So a value is normalised on the way in, and one that cannot be read is not
// silently swallowed: the field stays empty (it has nothing valid to show) but the
// original text is displayed beneath it, and it is left in the record untouched
// until someone actually picks a replacement.
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
const D_FIRST = [/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4})$/, /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2})$/]
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad2 = (n) => String(n).padStart(2, '0')

// A year no purchase ledger will carry. A two-digit year and a mis-OCR'd digit
// both produce dates that parse perfectly and are nonsense; the same guard is in
// services/dates.py, and the two must agree or the screen and the server disagree
// about whether a value is a date at all.
// Round-tripped through Date, not merely range-checked: 2026-02-30 passes every
// bounds test and is not a day. JS rolls it forward to March 2, so a value that
// does not come back as itself was never a date — the same answer strptime gives
// on the server, which is what keeps the two in step.
const saneDate = (y, m, d) => {
  if (+y < 1990 || +y > 2099) return ''
  const iso = `${y}-${pad2(m)}-${pad2(d)}`
  const t = new Date(iso + 'T00:00:00Z')
  return !isNaN(t) && t.toISOString().slice(0, 10) === iso ? iso : ''
}

// Mirrors services/dates.py — day-first, because every supplier and register in
// this business writes 03/04/2026 for the 3rd of April.
function toISODate(value) {
  if (!value) return ''
  const s = String(value).trim()
  const ymd = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/)
  if (ISO_RE.test(s) || ymd) {
    const [, y, m, d] = ymd || s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    return saneDate(y, m, d)
  }
  for (const re of D_FIRST) {
    const m = s.match(re)
    if (!m) continue
    let [, d, mo, y] = m
    if (y.length === 2) y = String(2000 + +y)
    const iso = saneDate(y, mo, d)
    if (iso) return iso
    // day-first didn't hold, so this can only be month-first — 04/13/2026 off a
    // supplier running US-defaulted software. Same fallback as services/dates.py.
    const swapped = saneDate(y, d, mo)
    if (swapped) return swapped
  }
  // "31 Jul 2026" / "31-Jul-2026", off e-invoices
  const named = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]{3,})[\s\-/](\d{2,4})$/)
  if (named) {
    const mi = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase())
    const y = named[3].length === 2 ? String(2000 + +named[3]) : named[3]
    if (mi >= 0) return saneDate(y, mi + 1, named[1])
  }
  return ''
}

// ---------- how a date is READ ----------
// Stored ISO, shown DD-MM-YYYY, and those are two separate decisions rather than
// one inconsistency. ISO is what a date COLUMN must hold: `date_from`/`date_to`
// compare as plain text in SQL, and only ISO sorts the way a calendar does.
// DD-MM-YYYY is what this business WRITES — on every register page, supplier
// invoice, cheque and delivery note in the building — so it is what every screen
// shows. Nothing renders a raw `2026-07-31` any more: one house format means
// nobody has to work out which of two numbers is the month.
const DISPLAY_SEP = '-'

const readableDate = (value) => {
  const s = toISODate(value)
  if (!s) return ''
  const [y, m, d] = s.split('-')
  return [d, m, y].join(DISPLAY_SEP)
}

//: `2026-07-31T09:14:22` — a stored timestamp is a date with a time bolted on
const ISO_STAMP_RE = /^(\d{4}-\d{2}-\d{2})[T ]/

// The form used at every display site. Hands back DD-MM-YYYY for anything that
// is a date, `blank` for nothing at all, and the value UNTOUCHED for anything
// else — a register cell may hold text vision could not read, and blanking it
// on screen would look exactly like the date had been lost.
const fmtDate = (value, blank = '—') => {
  if (value == null || value === '') return blank
  const s = String(value)
  return readableDate(s) || readableDate((s.match(ISO_STAMP_RE) || [])[1]) || s
}

// A date hiding inside a value that could be anything — a report cell, a CSV
// field, a filter chip. Deliberately narrower than fmtDate, which is only ever
// pointed at a column already known to hold dates: here nothing is known about
// the value, so ONLY a full ISO date is rewritten. `10-12-24` off a size run or
// a bin code parses perfectly as a date and is not one, and silently reprinting
// it as `10-12-2024` in a report is a wrong figure nobody would think to check.
// The server's dates.display_cell draws the same line, so a CSV downloaded from
// the browser and one downloaded from the API agree.
const ISO_CELL_RE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/
const fmtLoose = (v) => (typeof v === 'string' && ISO_CELL_RE.test(v.trim())
  ? (readableDate(v.trim().slice(0, 10)) || v) : v)

// ---------- picking one ----------
// The box reads DD-MM-YYYY and the calendar behind it is one click away. A bare
// <input type="date"> is deliberately not used for the reading half: what it
// PRINTS is chosen by the browser's locale, so the same record shows 31/07/2026
// on one machine, 07/31/2026 on the next and 2026-07-31 on a third — none of
// them this app's format, and none of them under its control. So the value is
// shown in a text box the app does own, anything typed into it goes through the
// same day-first parser the rest of the system uses, and the native picker is
// kept for anyone who would rather point at a calendar than type.
function DateField({ label, value, onChange, style, width, required, title, inline }) {
  const iso = toISODate(value)
  const unreadable = value && !iso
  const picker = useRef(null)
  const [text, setText] = useState(() => readableDate(iso))
  // Follow the value when something OUTSIDE the box changes it — a form reset, a
  // row filling itself in from a matched invoice. Keyed on the ISO value, so it
  // cannot fire mid-typing and snatch back half a date.
  useEffect(() => { setText(readableDate(iso)) }, [iso])
  const commit = () => {
    const s = text.trim()
    if (!s) { setText(''); if (iso) onChange(''); return }
    const next = toISODate(s)
    // Unreadable: put back what the field actually holds. Leaving half-typed
    // text sitting there would look saved, and isn't.
    if (!next) { setText(readableDate(iso)); return }
    setText(readableDate(next))
    if (next !== iso) onChange(next)
  }
  const input = (
    <>
      <span className="datebox">
        <input className="datetext" value={text} placeholder="dd-mm-yyyy" inputMode="numeric"
          title={title || 'Type dd-mm-yyyy, or pick from the calendar'}
          onChange={(e) => setText(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }} />
        {/* Kept rendered rather than display:none — a hidden input cannot open
            its own picker — but covered by the button and out of the tab order,
            so it is never the thing anyone types into. */}
        <input ref={picker} type="date" className="datepick" tabIndex={-1} aria-hidden="true"
          value={iso} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="datebtn" tabIndex={-1} title="Pick from a calendar"
          onClick={() => {
            const el = picker.current
            if (!el) return
            try { el.showPicker() } catch { el.focus() }
          }}>📅</button>
      </span>
      {unreadable && (
        <div className="flagnote" title="Kept exactly as it was read — pick a date to replace it">
          ⚠ can’t read “{String(value)}” — kept as-is
        </div>
      )}
    </>
  )
  if (inline) return input
  return (
    <div className="field" style={{ ...(width ? { width } : null), ...style }}>
      <label>{label}{required ? ' *' : ''}</label>
      {input}
    </div>
  )
}

// `calc` marks a field the arithmetic keeps in step — tinted, with an ƒ and a
// tooltip saying what it comes from. It stays editable: typing into it makes it
// the input and its counterpart moves instead.
function Field({ label, value, onChange, flagged, note, wide, source, date, calc }) {
  return (
    <div className={'field' + (flagged ? ' flag' : '') + (source && !flagged ? ' fromlr' : '')
      + (calc ? ' calc' : '')}
      style={wide ? { gridColumn: '1 / -1' } : null}>
      <label title={calc || undefined}>{label}{calc ? ' ƒ' : ''}</label>
      {date
        ? <DateField inline value={value} onChange={onChange} />
        : <input value={value ?? ''} title={calc || undefined}
            onChange={(e) => onChange(e.target.value)} />}
      {flagged && <div className="flagnote">⚠ needs review{note ? ' · ' + note : ''}</div>}
      {!flagged && note && <div className="srcnote">{note}</div>}
      {source && !flagged && <div className="srcnote">🔗 from {source}</div>}
    </div>
  )
}

// ==========================================================================
//  Auto-calculation — the arithmetic an invoice already contains
//  ------------------------------------------------------------------------
//  An invoice's figures are not independent. MRP less a discount IS the rate;
//  qty times rate IS the amount; a tax rate over the taxable value IS the tax
//  amount. Typing all of them and hoping they agree is how a review screen
//  produces a document that reconciles against nothing.
//
//  ONE RULE decides everything below: **the field you just edited is the input,
//  and only its dependents move.** Type 5 into IGST % and the amount appears;
//  type 933 into IGST Amount and the % appears. Neither overwrites the other,
//  because at any moment exactly one of them is the thing a human just asserted.
//
//  And nothing recalculates on LOAD. This screen exists to review what was read
//  off a photograph; recomputing on arrival would overwrite the extraction with
//  its own idea of itself and hide precisely the disagreements the warnings
//  panel is there to show. Everything here fires on an edit, or on the explicit
//  Recalculate button.
// ==========================================================================
const nf = (v) => {
  if (v === '' || v == null) return null
  const x = parseFloat(String(v).replace(/,/g, ''))
  return Number.isFinite(x) ? x : null
}
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100)
// quantities are floats — rounded, and compared, the way the server posts them
const round3 = (n) => Math.round((+n || 0) * 1000) / 1000

// Fields a human can type on a line, and what each one drives. `amount` and
// `taxable_value` are outputs of the row above them but inputs when typed
// directly — a supplier who bills a flat line amount is stating the amount, and
// the rate is then whatever divides into it.
// `prev` is the row as it stood BEFORE this edit. It is needed for exactly one
// judgement — whether Taxable was tracking Amount or had been set apart by hand —
// and that can only be told from the values that were there a moment ago.
// MRP less a percentage is a price. ONE relationship, and this business runs it
// twice — on opposite sides of itself:
//
//   MRP − discount % = RATE          what we pay the supplier (the invoice)
//   MRP − discount % = SALE PRICE    what the shop charges  (the price tag)
//
// The two are never the same number and must never be confused (see
// models.Product.sale_discount_pct, which exists precisely because the purchase
// discount had already taken the plain name). The arithmetic behind them IS the
// same though, so it is solved once, here, for whichever of the three corners
// was not just typed. `edited` is 'pct' | 'price' | 'mrp'.
function fromMrp(mrp, pct, price, edited) {
  if (!mrp) return [pct, price]
  if (edited === 'pct') return pct == null ? [pct, price] : [pct, r2(mrp * (1 - pct / 100))]
  if (edited === 'price') return price == null ? [pct, price] : [r2((1 - price / mrp) * 100), price]
  if (edited === 'mrp') {
    // a corrected MRP keeps the percentage that was agreed and re-prices; with no
    // percentage recorded it is the percentage that is unknown, not the price
    if (pct != null) return [pct, r2(mrp * (1 - pct / 100))]
    if (price != null) return [r2((1 - price / mrp) * 100), price]
  }
  return [pct, price]
}

//: the fields that describe what ONE piece costs. Only an edit to one of these
//: can move the discount — correcting a description or an HSN must not make a
//: discount appear on a line that never had one.
const PRICE_KEYS = new Set(['mrp', 'discount_pct', 'discount_amount', 'rate',
                            'buffer_pct', 'mrp_buffer_pct', 'amount'])

//: the edits that re-run the upward chain (cost → sell → MRP). `sale_price` is
//: in it so typing a shelf price back-solves the buffer above the cost, and
//: `mrp` is NOT: correcting a printed tag must not re-price the goods.
const CHAIN_KEYS = new Set(['rate', 'buffer_pct', 'mrp_buffer_pct', 'sale_price', 'amount'])

// ---- the gap between cost and MRP, named from both ends ----
//
// MRP and Rate are two numbers with one gap between them, and the trade states
// that gap two different ways depending on which end it is standing at:
//
//   * **Discount %** — off the printed price. (MRP − Rate) ÷ MRP. This is what a
//     supplier's bill says, because the bill starts from the tag.
//   * **Buffer %** — on top of cost. (MRP − Rate) ÷ Rate. This is what you say
//     when there is no tag yet: the goods cost 650, put 53% on it and print 995.
//
// They are never the same number for the same gap (345 off 995 is 34.7%; 345 on
// 650 is 53.1%), which is exactly why both are offered rather than one being
// made to serve as the other. Either can be typed; the other follows, and so
// does the price at the far end.
//
// Buffer is DERIVED, never stored: it is recomputed from Rate and MRP whenever
// either moves, so a line reloaded from a saved invoice shows the same buffer it
// was entered at without a column existing to go stale.
function bufferFrom(top, base) {
  if (top == null || !base) return null
  return r2((top / base - 1) * 100)
}
function markup(base, pct) {
  if (base == null || pct == null) return null
  // A WHOLE rupee, not two decimals. These are printed prices — 448 and 560,
  // never 447.99 — and the percentage behind them is a round figure somebody
  // chose, so the product always carries paise no tag would show. Rounding here
  // is what makes the chain produce prices that can go on a label, and it
  // closes the round trip: 320 + 40% → 448, and 448 against 320 reads back as
  // 40%.
  return Math.round(base * (1 + pct / 100))
}
function unmarkup(top, pct) {
  if (top == null || pct == null || pct <= -100) return null
  return r2(top / (1 + pct / 100))
}

// The SELLING side of the triangle above: MRP − Discount % = Sale price, in
// whichever direction was typed. Used on the GRN breakdown, where retail pricing
// is set per variant — a shop's price belongs to "L / Red", not to the bundle
// the supplier billed.
//
// Values in and out are the strings a form holds, blanks included: clearing the
// discount empties that box and leaves the price alone, rather than resolving to
// zero and marking the goods down to nothing.
const SALE_KEYS = { mrp: 'mrp', sale_discount_pct: 'pct', sale_price: 'price' }

// `blank` is what an emptied box becomes: '' for the form-shaped rows of the GRN
// breakdown, null for the invoice's line items, which hold numbers.
function recalcSale(row, edited, blank = '') {
  const corner = SALE_KEYS[edited]
  if (!corner) return row
  const [pct, price] = fromMrp(nf(row.mrp), nf(row.sale_discount_pct),
                               nf(row.sale_price), corner)
  return { ...row, sale_discount_pct: pct ?? blank, sale_price: price ?? blank }
}

function recalcLine(row, edited, prev = row) {
  const L = { ...row }
  const qty = nf(L.qty)
  let mrp = nf(L.mrp)
  let rate = nf(L.rate), disc = nf(L.discount_pct), amount = nf(L.amount)
  const discAmt = nf(L.discount_amount)
  const buffer = nf(L.buffer_pct)

  // --- MRP ─ discount ─ rate, in whichever direction was just typed ---
  //
  // All of it PER PIECE, because MRP and Rate are per piece and a discount
  // between them that quietly switched to a line total could not be checked
  // against either. 995 − 650 = 345 is a sum anyone can do against the invoice;
  // 4140 is one nobody can.
  if (edited === 'buffer_pct' || edited === 'mrp_buffer_pct') {
    // Handled by the markup chain below — both percentages build prices
    // upwards from the cost, so neither belongs in this MRP-down block.
  } else if (edited === 'discount_amount' && mrp != null && discAmt != null) {
    // the one corner fromMrp does not carry: rupees off rather than percent off
    rate = r2(mrp - discAmt)
    if (mrp) disc = r2((discAmt / mrp) * 100)
  } else if (edited === 'discount_pct' || edited === 'rate' || edited === 'mrp') {
    [disc, rate] = fromMrp(mrp, disc, rate,
      edited === 'discount_pct' ? 'pct' : edited === 'rate' ? 'price' : 'mrp')
  }

  // --- qty × rate = amount, or amount ÷ qty = rate when the amount was typed ---
  if (edited === 'amount' && qty) {
    rate = r2(amount / qty)
    if (mrp) disc = r2((1 - rate / mrp) * 100)
  } else if (qty != null && rate != null) {
    amount = r2(qty * rate)
  }

  // --- the markup chain: cost → sell price → MRP ------------------------
  //
  //     rate 320  ─ +40% ─►  sell 448  ─ +25% ─►  MRP 560
  //
  // Prices are built UPWARDS from what the goods cost, which is the direction
  // the shop actually prices in: the cost is the known number and both the
  // shelf price and the printed tag are decisions taken on top of it. The two
  // percentages are different questions — what to charge, and how much room to
  // leave above it for a visible discount — so they are two columns.
  //
  // The MRP-down block above is untouched and still runs for a bill that STATES
  // its retail price and a discount off it; this is the other half, for goods
  // that arrive with no tag.
  const mrpBuffer = nf(L.mrp_buffer_pct)
  let sell = nf(L.sale_price)

  if (CHAIN_KEYS.has(edited)) {
    // A sell price that was TYPED stands — it is the decision, and the buffer
    // above the cost is what follows from it (restated at the foot of this
    // function). Recomputing it from the cost here would overwrite the number
    // somebody just entered with the one it used to be.
    if (edited === 'sale_price') {
      if (rate == null && buffer != null) rate = unmarkup(sell, buffer)
    } else if (buffer != null && rate != null) sell = markup(rate, buffer)
    // …and its mirror, for a line priced from the shelf back down: the same
    // buffer says what the cost behind that price must have been.
    else if (buffer != null && sell != null && rate == null) rate = unmarkup(sell, buffer)

    // An MRP the invoice PRINTED is what the supplier billed and what the tag
    // says, so it stands. The chain fills it only where there is none — except
    // when the MRP buffer is what was just typed, which is somebody saying
    // plainly what the tag should be.
    if (mrpBuffer != null && sell != null && (mrp == null || edited === 'mrp_buffer_pct')) {
      mrp = markup(sell, mrpBuffer)
    }
    // Both discounts restated from wherever the prices landed. They are the
    // same gaps read from the top: what the supplier gave off the tag, and what
    // the shop shows off it.
    if (mrp) {
      if (rate != null) disc = r2((1 - rate / mrp) * 100)
      if (sell != null) L.sale_discount_pct = r2((1 - sell / mrp) * 100)
    }
    L.sale_price = sell
  }

  L.rate = rate
  L.discount_pct = disc
  L.amount = amount
  L.mrp = mrp                     // moved only by the markup chain; see above
  // The discount in rupees, PER PIECE — the same base as the % beside it and as
  // the MRP and Rate it sits between. Touched only when one of those actually
  // moved: an edit to the description or the HSN has nothing to say about
  // pricing, and a discount that materialises out of one is a figure the invoice
  // never stated.
  if (PRICE_KEYS.has(edited) && mrp != null && rate != null) {
    L.discount_amount = r2(mrp - rate)
  }
  // The buffer, restated from wherever the two prices ended up. Skipped when the
  // buffer is what was typed — recomputing it from the MRP it just produced is a
  // round trip that only introduces rounding, and it would fight the cursor.
  // Each markup restated from the two prices it spans — buffer over the cost,
  // MRP buffer over the shelf price. Skipped for whichever was just typed:
  // recomputing it from the price it produced is a round trip that only adds
  // rounding, and it would fight the cursor.
  // CHAIN_KEYS as well as PRICE_KEYS: typing a SELL price moves the buffer above
  // the cost, and sale_price is deliberately not a PRICE_KEY — it says nothing
  // about what the supplier charged, so it must not stir the purchase discount.
  const movedPrices = PRICE_KEYS.has(edited) || CHAIN_KEYS.has(edited)
  if (movedPrices && edited !== 'buffer_pct') {
    L.buffer_pct = bufferFrom(L.sale_price, rate)
  }
  if (movedPrices && edited !== 'mrp_buffer_pct') {
    L.mrp_buffer_pct = bufferFrom(mrp, L.sale_price)
  }
  // The taxable value is the line amount unless the invoice states its own. It
  // keeps up while it merely echoes the amount; the moment someone types a
  // different figure into it, that is an assertion about the invoice and nothing
  // here overwrites it again.
  const wasTracking = nf(prev.taxable_value) == null
    || nf(prev.taxable_value) === nf(prev.amount)
  if (edited !== 'taxable_value' && wasTracking) L.taxable_value = amount
  // The SELLING triangle, hanging off the same MRP: MRP − Sale disc % = Sell
  // price. A correction to the MRP moves both sides of the line at once, which
  // is right — one printed retail price feeds what we pay AND what we charge —
  // while the two discounts stay strictly apart.
  return recalcSale(L, edited, null)
}

//: the taxable figure a rate is charged on — the invoice's own when it has one,
//: otherwise what the lines add up to
function taxBase(data) {
  const stated = nf(data.totals?.taxable_total)
  if (stated) return stated
  return r2((data.line_items || []).reduce(
    (s, it) => s + (nf(it.taxable_value) ?? nf(it.amount) ?? 0), 0))
}

//: every % ─ amount pair in the tax block. Both directions, always.
const TAX_PAIRS = [
  ['cgst_rate', 'cgst_amount'], ['sgst_rate', 'sgst_amount'],
  ['igst_rate', 'igst_amount'],
  // not a tax, but the same arithmetic and the same complaint: a special
  // discount typed as 979.25 should say what percentage it is, and one typed as
  // 5% should say what it costs
  ['special_discount_pct', 'special_discount'],
]

function recalcTaxes(tax, base, edited) {
  const t = { ...tax }
  for (const [rk, ak] of TAX_PAIRS) {
    if (edited === rk && base) t[ak] = r2(base * (nf(t[rk]) || 0) / 100)
    else if (edited === ak && base) t[rk] = r2((nf(t[ak]) || 0) / base * 100)
  }
  // CGST and SGST are one tax split in half — a state levy is never 9% one side
  // and 2% the other. Mirrored only when the other half is blank or was tracking
  // this one, so a deliberately odd pair is never quietly straightened.
  const mirror = (from, to) => {
    const was = nf(tax[from]), other = nf(tax[to])
    if (other == null || other === 0 || other === was) {
      t[to] = nf(t[from])
      if (base) t[to.replace('_rate', '_amount')] = r2(base * (nf(t[to]) || 0) / 100)
    }
  }
  if (edited === 'cgst_rate') mirror('cgst_rate', 'sgst_rate')
  if (edited === 'sgst_rate') mirror('sgst_rate', 'cgst_rate')
  return t
}

// The foot of the invoice, derived from everything above it. Deliberately the
// same shape the server reconciles against (extraction/validate.py), so the
// figure this screen computes is the one that will NOT raise a warning on save.
function recalcTotals(data) {
  const items = data.line_items || []
  const tax = data.taxes || {}
  const tot = { ...(data.totals || {}) }
  const sub = r2(items.reduce((s, it) => s + (nf(it.amount) || 0), 0))
  const taxable = r2(items.reduce((s, it) => s + (nf(it.taxable_value) ?? nf(it.amount) ?? 0), 0))
  tot.total_qty = r2(items.reduce((s, it) => s + (nf(it.qty) || 0), 0))
  tot.sub_total = sub
  tot.taxable_total = taxable || sub
  tot.tax_total = r2((nf(tax.cgst_amount) || 0) + (nf(tax.sgst_amount) || 0)
                     + (nf(tax.igst_amount) || 0))
  tot.grand_total = r2((tot.taxable_total || 0) + tot.tax_total
                       + (nf(tax.other_charges) || 0) + (nf(tax.freight) || 0)
                       - (nf(tax.special_discount) || 0) + (nf(tax.round_off) || 0))
  return tot
}

// --- size runs: "28-2-38" is six rows of three ---
// A garment bundle is bought as a RUN, not as a list. 28 to 38 in twos is six
// sizes with the eighteen pieces spread evenly over them, and written out by hand
// that is six rows, six sizes and six identical quantities — six chances to key
// one of them wrong, for something the packing slip already says in six
// characters. So it is typed the way it is written, once, and the rows are worked
// out from it. What it makes is ordinary afterwards: change a quantity, delete a
// size, add one the run didn't cover.
//
// Two screens read one. On the INVOICE, a billed bundle becomes the six lines it
// is really made of, so the sizes are on the document from the start and the GRN,
// the products and the QR labels all follow from them. On the GRN BREAKDOWN, the
// same run becomes the six stock items that came out of the carton. Same
// arithmetic either way — which screen it is typed on is only a question of when
// somebody knows the mix.
//
// Mind the separator. In a size COLUMN "30-2" means two of size 30 — that is what
// services/size_split.py reads off the supplier's own bill, and it is careful
// about it because guessing wrong invents stock. Here it cannot mean that: this
// box is only ever start-step-end, which is the one thing it is for. Two numbers
// ("28-38") step by one.
// A step keyed as .2 instead of 2 turns a six-size run into fifty-one rows, and
// nothing in this trade is a run of forty sizes — so that is a typo, not a run.
const SIZE_RUN_MAX = 40
const parseSizeRun = (spec) => {
  const text = String(spec || '').trim()
  if (!text) return { sizes: [], why: '' }
  // "16*22" written with an x or a * is two numbers and NO step. On one supplier's
  // bills it is a size range — sixteen to twenty-two, in twos — and on another
  // "127 X 200" is a bedsheet. Nothing in the text itself separates them, and
  // reading either as a run off a dash would turn one line into seven sizes that
  // were never on the bill.
  //
  // So this form is never a run on its own say-so. It becomes one only where the
  // quantity proves the step (runFromSize, on the invoice grid: four pieces over
  // 16-2-22 is one of each, and the bedsheet's 73 divides by nothing) — and what
  // that produces is a SUGGESTION in this box, written out in full, for a human
  // to look at. Typed in by hand it is refused, and the message asks for the step
  // rather than pretending the run cannot be read.
  //
  // The server guards the same ambiguity from the other end, on what the supplier
  // printed: services/size_split.py, where "30x2" is refused unless the
  // arithmetic proves it.
  if (/[x×*]/i.test(text)) {
    return { sizes: [], why: `“${text}” does not say its step — write it start-step-end, like 16-2-22.` }
  }
  const nums = text.split(/[^0-9.]+/).filter(Boolean).map(Number)
  if (nums.length < 2 || nums.length > 3 || nums.some((n) => Number.isNaN(n))) {
    return { sizes: [], why: 'Write the run as start-step-end — 28-2-38.' }
  }
  const [start, step, end] = nums.length === 3 ? nums : [nums[0], 1, nums[1]]
  if (!(step > 0)) return { sizes: [], why: 'The step has to be more than zero — 28-2-38.' }
  const count = Math.floor(round3(Math.abs(end - start) / step)) + 1
  if (count > SIZE_RUN_MAX) {
    return { sizes: [], why: `That is ${count} sizes — check the step.` }
  }
  // 38-2-28 is the same six sizes counted down, which is how some slips write it
  const stride = end < start ? -step : step
  return { sizes: Array.from({ length: count }, (_, i) => String(round3(start + i * stride))), why: '' }
}
// 18 over 6 sizes is 3 each. 20 over 6 is 4, 4, 3, 3, 3, 3 — what will not divide
// goes to the first rows rather than being dropped, because the thing that has to
// be true before this GRN can post is that every piece is placed somewhere.
const spreadQty = (total, n) => {
  const t = Math.max(0, +total || 0)
  if (n <= 0) return []
  if (Number.isInteger(t)) {
    const base = Math.floor(t / n)
    return Array.from({ length: n }, (_, i) => base + (i < t - base * n ? 1 : 0))
  }
  // metres and kilos divide unevenly; the rounding drift lands on the last row so
  // the rows still add up to exactly what arrived
  const each = round3(t / n)
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? round3(t - each * (n - 1)) : each))
}

// The attribute vocabularies — the masters in data/product_attributes.json, merged
// with whatever is already recorded against a product. The same lists the GRN
// breakdown and the phone's detail form offer, and that is the point of them
// being one call: a brand typed three ways is three brands, and the way to stop
// that is to show the operator the nine that already exist before they type a
// tenth. Free text still goes through — the list guides, it does not gate.
function useProductOptions() {
  const [opts, setOpts] = useState({})
  useEffect(() => { api.productOptions().then(setOpts).catch(() => {}) }, [])
  return opts
}

// ---------- line items ----------
// Full per-line field set; the table scrolls horizontally so nothing is dropped.
//
// `barcode` is deliberately NOT a column. It still comes off the invoice and is
// still stored on the line — `inventory.match_product` keys a re-buy on it, which
// is what keeps one item's cost history in one product — but it is the supplier's
// number, not ours, and nobody reviewing an invoice checks it by eye. The
// trade-off: a misread supplier barcode can no longer be corrected here.
// `calc` marks a column the arithmetic maintains — it is tinted, and its tooltip
// says what it is derived from, so nobody wonders why a figure they did not type
// appeared. Every one of them is still editable: typing into a derived cell makes
// it the input and moves the others instead (see recalcLine).
const ITEM_COLS = [
  ['description', 'Description', false, 200],
  ['brand', 'Brand', false, 90], ['design', 'Design', false, 90], ['size', 'Size', false, 116],
  ['hsn', 'HSN', false, 80], ['qty', 'Qty', true, 60], ['uom', 'UOM', false, 60],
  // MRP → less the discount → Rate, read left to right, every one of them PER
  // PIECE so the row can be checked against the invoice by eye: 995 − 345 = 650.
  // Only Taxable and Amount are line totals, and they sit apart at the end.
  ['mrp', 'MRP', true, 70, 'Printed retail price, per piece. Worked out for you if you type a Rate and a Buffer %.'],
  ['discount_pct', 'Discount %', true, 92, 'Off MRP, per piece: (MRP − Rate) ÷ MRP. Type a Rate instead and this fills itself.'],
  ['rate', 'Rate', true, 74, 'The COST, per piece — what you pay. Type it and both percentages fill themselves.'],
  // The same gap as Discount %, named from the other end — so the two flank the
  // Rate they describe: MRP −discount→ Rate, and Rate +buffer→ MRP. Which one
  // somebody types depends on which price they already know, and that is the
  // whole point of carrying both.
  ['buffer_pct', 'Buffer %', true, 124, 'On top of COST: Sell price = Rate × (1 + buffer) — e.g. 320 + 40% = 448. Type it and the sell price is worked out.'],
  // The retail end of the same MRP. Not on the supplier's bill — nobody prints
  // your shelf price for you — but set here the product is born priced instead
  // of landing in Inventory with nothing on it. Kept well clear of the purchase
  // discount above: same MRP, two different percentages, never the same number.
  // The second half of the chain. Two markups because they answer two
  // questions: what to charge, and how much room to leave above that for a
  // discount the customer can see on the tag.
  ['mrp_buffer_pct', 'MRP Buffer %', true, 128, 'On top of the SELL price: MRP = Sell × (1 + this) — e.g. 448 + 25% = 560. The room above your price that the printed tag shows.'],
  ['sale_discount_pct', 'Sale Disc %', true, 96, 'Off MRP for the SHOP — what the tag shows the customer saving. Follows from the two buffers; type a sell price instead and this fills itself.'],
  ['sale_price', 'Sell Price', true, 92, 'What you CHARGE: MRP less the sale discount — e.g. 995 − 20% = 796. Type it and its % follows.'],
  ['taxable_value', 'Taxable', true, 90, 'Line total. The Amount, unless the invoice states its own.'],
  ['amount', 'Amount', true, 90, 'Line total: Qty × Rate. Type an amount and the rate is worked back out of it.'],
]
//: The invoice columns that have a master vocabulary behind them, as
//: column -> the key it is listed under. Brand is the one that matters here: it
//: is identity — an ESSA t-shirt and a YUVA t-shirt in the same size are two
//: stock items — so it is the field where a spelling invents a product, and the
//: cure is showing the three hundred that exist before somebody types the three
//: hundred and first. `uom` and `size` have lists too and take one line each,
//: but a size cell on this screen is as often a run as a size.
const ITEM_LISTED = { brand: 'brand' }

//: Columns where ONE value for the whole invoice is a sensible thing to say, and
//: what kind of box says it. A supplier's bill is very often all one brand, all
//: one HSN, all one unit and all one markup — and typing 620520 into twenty-six
//: lines is the kind of work that gets abandoned halfway, which leaves an invoice
//: where some lines carry an HSN and some do not.
//:
//: Three columns are deliberately absent:
//:
//:   qty              the one figure that is genuinely per line. It is what the
//:                    invoice is counting; setting every line to the same number
//:                    is not a thing anybody means. (Same reason the GRN
//:                    breakdown grid leaves it out.)
//:   taxable_value    both are line TOTALS, derived from qty × rate. Filling them
//:   amount           with one number back-solves a different rate onto every
//:                    line, which is arithmetic nobody asked for.
const ITEM_FILL = {
  brand: 'text', design: 'text', size: 'text', hsn: 'text', uom: 'text',
  mrp: 'num', discount_pct: 'pct', rate: 'num',
  buffer_pct: 'pct', mrp_buffer_pct: 'pct',
  sale_discount_pct: 'pct', sale_price: 'num',
}

// --- size groups: the lines one bundle was split into ---
// Four lines that agree on everything except the size and the count are one
// garment seen four ways — same description, same design, same HSN, same price.
// That is what makes them a group, and NOTHING is stamped on the rows to say so:
// it is read off the values themselves, so it survives a save and a reload, it
// costs the invoice no field it did not have, and a line edited until it no
// longer matches simply leaves the group. Folding is a view of the lines. It
// changes none of them.
//
// Consecutive only. Two identical runs at opposite ends of a fifty-nine-line
// bill are two entries on the paper and stay two here; collapsing across the
// rows between them would fold a part of the invoice that is not there.
const ITEM_GROUP_BY = ['description', 'brand', 'design', 'hsn', 'uom',
                       'rate', 'mrp', 'discount_pct', 'sale_price']
const itemGroupKey = (it) =>
  ITEM_GROUP_BY.map((k) => String(it?.[k] ?? '').trim().toLowerCase()).join('|')
//: only a line that says something can be grouped. Two untouched blank rows agree
//: on everything, and folding them would be folding nothing into nothing.
const itemGroupable = (it) =>
  !!String(it?.description ?? '').trim() && !!String(it?.size ?? '').trim()
//: the invoice as it is READ: every line, with the runs gathered. `to` is
//: exclusive, so `to - from > 1` is what makes an entry a group.
const groupItems = (items) => {
  const out = []
  for (let i = 0; i < items.length;) {
    let j = i + 1
    if (itemGroupable(items[i])) {
      const k = itemGroupKey(items[i])
      while (j < items.length && itemGroupable(items[j]) && itemGroupKey(items[j]) === k) j++
    }
    out.push({ sig: itemGroupKey(items[i]), from: i, to: j })
    i = j
  }
  return out
}
const ITEM_CALC = new Set(['rate', 'discount_pct', 'buffer_pct', 'mrp_buffer_pct',
  'mrp', 'amount', 'taxable_value', 'sale_discount_pct', 'sale_price'])

function LineItems({ items, setItems }) {
  // A two-page invoice runs to sixty lines and more, and the whole set in one
  // table means scrolling past forty rows to reach the totals under it. Paged at
  // 25 — the same control the document list uses, so it is not a second idea
  // about what paging looks like.
  //
  // The row's index in the WHOLE list is what upd and delRow take: page 2 row 1
  // is item 25, and passing the position on the page would silently edit the
  // first row of the invoice instead. `from` is 1-based, hence the −1.
  // Paged over the VIEW, not the lines: a folded group is one thing to page past,
  // and "1–25 of 24" would otherwise count rows nobody can see.
  const view = useMemo(() => groupItems(items), [items])
  const [folded, setFolded] = useState({})       // group signature -> folded away
  const page = usePaged(view, 25)
  const opts = useProductOptions()
  // Which line has its size run open, and what has been typed into it. One box
  // serves the whole table because only one line is ever being split.
  const [runFor, setRunFor] = useState(null)
  const [runSpec, setRunSpec] = useState('')
  const [runNote, setRunNote] = useState('')     // where a suggested run came from
  const [runRows, setRunRows] = useState([])     // the size/qty list, before it is applied
  // the edited field is the input; recalcLine moves only what depends on it
  const upd = (i, k, v) => setItems(items.map((x, j) =>
    (j === i ? recalcLine({ ...x, [k]: num(v) }, k, x) : { ...x })))
  // The new row goes on the end, which on a paged table is not the page being
  // looked at — pressing "add line" on page 1 of 3 otherwise appears to do
  // nothing at all. Follow it.
  const addRow = () => {
    const next = [...items, { description: '', qty: null, rate: null, amount: null, uom: 'PCS' }]
    setItems(next)
    if (page.size) page.setPage(Math.ceil((view.length + 1) / page.size))
  }
  // A line read off an invoice arrives with an MRP and a Rate and no buffer —
  // the bill states a discount, never a markup. The buffer is that same gap
  // read the other way, so it is shown from the two prices rather than left
  // blank until somebody types in the column to find out what is already true.
  const cell = (it, k) => {
    if (k === 'buffer_pct' && (it.buffer_pct == null || it.buffer_pct === '')) {
      const b = bufferFrom(nf(it.sale_price), nf(it.rate))
      return b == null ? '' : b
    }
    if (k === 'mrp_buffer_pct' && (it.mrp_buffer_pct == null || it.mrp_buffer_pct === '')) {
      const b = bufferFrom(nf(it.mrp), nf(it.sale_price))
      return b == null ? '' : b
    }
    return it[k] ?? ''
  }
  const delRow = (i) => setItems(items.filter((_, j) => j !== i))
  const delGroup = (g) => {
    if (!window.confirm(`Delete all ${g.to - g.from} lines of “${items[g.from].description}”?`)) return
    setItems(items.filter((_, j) => j < g.from || j >= g.to))
  }
  // One cell of a folded group. The sizes are listed, the three line totals are
  // summed, and anything the lines disagree on is shown as a dash rather than as
  // whichever of them happened to be first.
  const groupCell = (g, k) => {
    const rows = items.slice(g.from, g.to)
    if (k === 'size') {
      const sizes = rows.map((r) => String(r.size ?? '').trim()).filter(Boolean)
      return sizes.length > 6
        ? `${sizes.slice(0, 5).join(', ')}, … ${sizes[sizes.length - 1]}`
        : sizes.join(', ')
    }
    if (k === 'qty' || k === 'amount' || k === 'taxable_value') {
      return round3(rows.reduce((n2, r) => n2 + (+r[k] || 0), 0))
    }
    const vals = new Set(rows.map((r) => String(cell(r, k) ?? '')))
    return vals.size === 1 ? [...vals][0] : '—'
  }
  // One billed bundle becomes the lines it is really made of: same description,
  // same design, same HSN, same pricing, one size each and the quantity shared
  // out. Done HERE, while the invoice is being keyed, the sizes are on the
  // document from the start — the GRN, the products and the QR labels all follow
  // from them, and nobody breaks the same bundle down a second time at the dock.
  //
  // The invoice still has to reconcile against the paper it was read off, so the
  // line TOTALS are shared out rather than copied: six lines each carrying the
  // whole amount would multiply the bill by six. Σ qty and Σ value come out of
  // this exactly as they went in, which is what makes it safe to do on a
  // document that has already been checked against its image.
  // One line, spread across a list of {size, qty} — the list the operator has in
  // front of them, not one recomputed behind their back, so a count they changed
  // is the count that lands on the invoice. A size with nothing against it is
  // dropped: zero of a size means that size did not come, and a line of no
  // pieces is not a line.
  const expandRows = (it, rows) => {
    const kept = rows.filter((r) => String(r.size ?? '').trim() !== '' && +r.qty > 0)
    if (!kept.length) return [it]
    const qtys = kept.map((r) => +r.qty)
    // a line total, shared in the same proportion as the quantity, with the
    // rounding drift on the last line so the column still adds up to what it did
    const share = (total) => {
      if (total == null) return kept.map(() => null)
      const sum = qtys.reduce((a, b) => a + b, 0)
      const out = qtys.map((q) => r2(sum ? total * q / sum : total / kept.length))
      out[out.length - 1] = r2(total - out.slice(0, -1).reduce((a, b) => a + b, 0))
      return out
    }
    const amounts = share(nf(it.amount))
    const taxables = share(nf(it.taxable_value))
    // through recalcLine with the ORIGINAL as `prev`: qty × rate re-derives the
    // amount where the line has a rate, and a taxable value that was merely
    // echoing the amount keeps echoing it, while one the invoice STATED in its
    // own right keeps the share worked out above
    return kept.map((r, n) => recalcLine(
      { ...it, size: String(r.size).trim(), qty: qtys[n],
        amount: amounts[n], taxable_value: taxables[n] }, 'qty', it))
  }
  //: what a freshly generated run is, before anybody touches it: the sizes, and
  //: the line's pieces spread evenly over them
  const evenRows = (it, sizes) => {
    const qtys = spreadQty(nf(it.qty) ?? 0, sizes.length)
    return sizes.map((size, n) => ({ size, qty: String(qtys[n]) }))
  }
  const closeRun = () => { setRunFor(null); setRunSpec(''); setRunNote(''); setRunRows([]) }
  // Generate makes a LIST, not lines. Nothing on the invoice moves until Split is
  // pressed, and that gap is the whole point of the list: an even spread is only
  // ever a guess about what is in the carton, and the person holding the packing
  // slip is the one who knows that 22 came four short and 18 came four over. So
  // the arithmetic offers its answer and they correct it — change a count, drop a
  // size that was not sent, add one the run did not cover.
  const genRows = (i) => {
    const { sizes } = parseSizeRun(runSpec)
    if (sizes.length) setRunRows(evenRows(items[i], sizes))
  }
  const updRunRow = (n, k, v) => setRunRows(runRows.map((r, j) => (j === n ? { ...r, [k]: v } : r)))
  const dropRunRow = (n) => setRunRows(runRows.filter((_, j) => j !== n))
  const addRunRow = () => setRunRows([...runRows, { size: '', qty: '' }])
  const splitRun = (i) => {
    if (!runRows.length) return
    setItems([...items.slice(0, i), ...expandRows(items[i], runRows), ...items.slice(i + 1)])
    closeRun()
  }
  // …and the same sizes against every line that reads the same way.
  //
  // A bill written as a size run writes it on EVERY line: six Frocks, six design
  // numbers, "16*22" in all six size cells. Splitting them one at a time is the
  // same decision taken six times, and on a fifty-nine-line bill it is the kind
  // of work that gets abandoned halfway — which leaves an invoice where some
  // lines carry sizes and some do not, and that is worse than none of them doing.
  //
  // It takes the SIZES off the list, so a size dropped there is dropped
  // everywhere — but each line's own quantity is spread evenly over them, because
  // a count hand-set for a line of four means nothing to a line of eight. The
  // confirm says so: this button is blunt by nature and must not be quiet about
  // it.
  //
  // "Reads the same way" is the size cell, matched as text. Deliberately not the
  // run a line would suggest: two lines can suggest the same run from different
  // quantities and different size cells, and rewriting a line somebody never
  // looked at is exactly what this must not do. A blank size matches nothing —
  // there is nothing there to have read.
  const sameSizeAs = (i) => {
    const key = String(items[i]?.size ?? '').trim().toLowerCase()
    if (!key) return []
    return items.reduce((out, x, j) =>
      (String(x.size ?? '').trim().toLowerCase() === key ? [...out, j] : out), [])
  }
  const splitRunAll = (i) => {
    const sizes = runRows.map((r) => String(r.size ?? '').trim()).filter(Boolean)
    const targets = new Set(sameSizeAs(i))
    if (!sizes.length || !targets.size) return
    if (!window.confirm(
      `Split all ${targets.size} line(s) whose Size reads “${items[i].size}” into these sizes?\n\n`
      + `${sizes.join(', ')}\n\n`
      + `Each line's OWN quantity is spread evenly across them, so a count you set `
      + `by hand above applies to line ${i + 1} only.\n`
      + `${targets.size} line(s) become ${targets.size * sizes.length}. `
      + 'Σ qty and Σ value do not move.')) return
    setItems(items.flatMap((x, j) => (targets.has(j) ? expandRows(x, evenRows(x, sizes)) : [x])))
    closeRun()
  }
  const SIZE_STEPS = [2, 1, 3, 4, 5]     // garment runs go up in twos far more often than ones
  const runFromSize = (v, qty) => {
    const nums = String(v || '').trim().split(/[^0-9.]+/).filter(Boolean).map(Number)
    if (nums.some((n) => Number.isNaN(n))) return ''
    if (nums.length === 3) {              // the run in full: it states its own step
      const spec = nums.join('-')
      return parseSizeRun(spec).sizes.length ? spec : ''
    }
    if (nums.length !== 2 || !(qty > 0)) return ''
    const [start, end] = nums
    const span = Math.abs(end - start)
    for (const step of SIZE_STEPS) {
      if (!span || span % step) continue
      const n = span / step + 1
      if (n > 1 && n <= SIZE_RUN_MAX && qty % n === 0) return `${start}-${step}-${end}`
    }
    return ''
  }
  const openRun = (i) => {
    if (runFor === i) { closeRun(); return }
    const it = items[i]
    const spec = runFromSize(it.size, nf(it.qty))
    setRunFor(i); setRunSpec(spec)
    // a run that was READ rather than typed has already been proved against the
    // quantity, so its list is shown straight away — the answer belongs on screen,
    // not one press away
    setRunRows(spec ? evenRows(it, parseSizeRun(spec).sizes) : [])
    setRunNote(spec ? `read off the size column — “${it.size}”, and ${nf(it.qty)} divides across it exactly` : '')
  }
  // Fill a whole column with one percentage.
  //
  // Both buffers are usually one decision for the whole delivery — everything on
  // this bill is marked up the same — and typing 40 into fifty-nine rows is the
  // kind of work that gets abandoned halfway, leaving half the lines priced and
  // half not, which is worse than none.
  //
  // On a button rather than as you type: a column that rewrote itself on every
  // keystroke would overwrite the rows somebody had already set by hand, and
  // "4" is a value on the way to "40". Applied, each row still edits normally.
  const [fill, setFill] = useState({})
  //: whether there is anything to apply. A number column needs a NUMBER, which
  //: is why this asks nf and not num: num hands back "abc" unchanged — it only
  //: converts what converts — so a guard written on it lets unreadable text
  //: through and writes it to every line on the invoice. nf answers null for
  //: anything that is not a figure, and 0 for "0", which is a number somebody
  //: may well mean.
  //:
  //: Blank does NOTHING rather than clearing the column. Emptying twenty-six
  //: lines is not something to put behind the same button as filling them.
  const fillReady = (key) => (ITEM_FILL[key] === 'text'
    ? !!(fill[key] || '').trim()
    : nf(fill[key]) != null)
  const applyFill = (key) => {
    if (!fillReady(key)) return
    const text = ITEM_FILL[key] === 'text'
    const v = text ? fill[key].trim() : nf(fill[key])
    // A price goes through recalcLine, because setting the number without
    // re-pricing would show a 40% buffer over prices that never moved. A brand
    // or an HSN is not part of that arithmetic and is set as typed.
    setItems(items.map((it) => (text
      ? { ...it, [key]: v }
      : recalcLine({ ...it, [key]: v }, key, it))))
  }
  const fillCell = (key, label) => {
    const kind = ITEM_FILL[key]
    return (
      <div className={'fillbox' + (kind === 'text' ? ' text' : '')}>
        {/* size=1 on every box in this grid, and it is load-bearing. An input
            with no size reports a ~177px INTRINSIC width, and in an auto-layout
            table that becomes the column's floor — so `HSN`, declared 80px wide
            in ITEM_COLS, came out at 265 and a six-digit code sat in a bar four
            times its own length. CSS width:100% cannot undo that: a percentage
            is treated as auto while the column is being measured. The attribute
            is what the measurement reads, and the CSS width still fills whatever
            column the table settles on. */}
        <input size={1} value={fill[key] || ''} list={ITEM_LISTED[key] ? 'essa-item-' + key : undefined}
          inputMode={kind === 'text' ? undefined : 'decimal'}
          placeholder={kind === 'pct' ? '%' : 'all'}
          title={`Set ${label} on every line of this invoice`}
          onChange={(e) => setFill({ ...fill, [key]: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') applyFill(key) }} />
        {/* ↓ rather than "Apply all", and the reason is the column width above:
            the words were 60px of button in a header cell that governs an 80px
            column, so every fillable column was widened to hold a label. The
            arrow is the spreadsheet's own fill-down, it sits beside a box whose
            placeholder already reads "all", and the title says it in full. */}
        <button className="btn fill-go" disabled={!fillReady(key)}
          onClick={() => applyFill(key)}
          aria-label={`Apply ${label} to every line of this invoice`}
          title={`Apply ${fill[key] || '…'}${kind === 'pct' ? '%' : ''} to all ${items.length} line(s)`}>
          ↓</button>
      </div>
    )
  }


  //: the groups there are to fold, and whether they already are
  const runGroups = view.filter((g) => g.to - g.from > 1)
  const allFolded = runGroups.length > 0 && runGroups.every((g) => folded[g.sig])
  const qtySum = items.reduce((s, x) => s + (+x.qty || 0), 0)
  const amtSum = items.reduce((s, x) => s + (+(x.taxable_value ?? x.amount) || 0), 0)
  // The per-piece gap between MRP and cost, taken out to the line — the one
  // place the whole-invoice figure is wanted. Derived from the two prices rather
  // than from a stored difference, so it agrees with the columns on screen even
  // on a line where nothing was typed into the pricing at all.
  const discSum = items.reduce((s, x) => {
    const gap = (+x.mrp || 0) - (+x.rate || 0)
    return s + (gap > 0 ? gap * (+x.qty || 0) : 0)
  }, 0)
  return (
    <div>
      <div className="tablewrap">
      <table className="items" style={{ minWidth: 1310 }}>
        {/* The line number is the column that makes a paged table usable: it is
            how a row on screen is matched to the numbered row on the paper,
            which is the whole job when checking a 59-line bill against it. */}
        <thead><tr><th style={{ minWidth: 34 }} title="Line number on the invoice">#</th>
          {ITEM_COLS.map(([k, l, , w, tip]) =>
          <th key={k} style={{ minWidth: w }} title={tip}
            className={ITEM_CALC.has(k) ? 'calc' : undefined}>{l}{tip ? ' ƒ' : ''}</th>)}<th></th></tr>
          {/* Under the headings, not in a toolbar above the table: the control
              belongs to the column it fills, and aligned under it there is
              nothing to explain about which is which. */}
          <tr className="fillrow"><th></th>
            {ITEM_COLS.map(([k, l]) => (
              <th key={k}>{ITEM_FILL[k] ? fillCell(k, l) : null}</th>
            ))}<th></th></tr>
        </thead>
        <tbody>
          {page.slice.map((g) => {
            const grouped = g.to - g.from > 1
            // FOLDED — the whole group as one row. It is a VIEW of the lines, not
            // another line: every figure on it is theirs, summed or shared, so
            // none of it is an input. Open it to change anything.
            if (grouped && folded[g.sig]) {
              const kids = items.slice(g.from, g.to)
              return (
                <tr key={g.sig + g.from} className="foldrow">
                  <td className="rowno" title={`Lines ${g.from + 1} to ${g.to} of the invoice`}>
                    {g.from + 1}–{g.to}</td>
                  {ITEM_COLS.map(([k, , isNum, , tip]) => (
                    <td key={k} className={(isNum ? 'num' : '') + (ITEM_CALC.has(k) ? ' calc' : '')}
                      title={tip}>
                      {k === 'size' ? (
                        <div className="sizecell">
                          <span className="foldsizes"
                            title={kids.map((r) => `${r.size} → ${r.qty}`).join('\n')}>
                            {groupCell(g, k)}</span>
                          <button className="runbtn on wide"
                            title={`Show all ${kids.length} size lines again`}
                            onClick={() => setFolded({ ...folded, [g.sig]: false })}>
                            ≡ {kids.length}</button>
                        </div>
                      ) : groupCell(g, k)}
                    </td>
                  ))}
                  <td><button className="btn" style={{ padding: '2px 7px' }}
                    title={`Delete all ${kids.length} lines`}
                    onClick={() => delGroup(g)}>×</button></td>
                </tr>
              )
            }
            // OPEN — the lines themselves, each editable as before
            return items.slice(g.from, g.to).map((it, n) => {
            const i = g.from + n                 // its index in the whole invoice
            const run = runFor === i ? parseSizeRun(runSpec) : null
            const qtys = run?.sizes.length ? spreadQty(nf(it.qty) ?? 0, run.sizes.length) : []
            const even = qtys.length > 0 && qtys.every((q) => q === qtys[0])
            const alike = run ? sameSizeAs(i) : []
            const listed = !run ? '' : run.sizes.length > 10
              ? `${run.sizes.slice(0, 9).join(', ')}, … ${run.sizes[run.sizes.length - 1]}`
              : run.sizes.join(', ')
            // the running check, and what it is checked against. The line's
            // quantity is what the supplier BILLED, and the sizes are how that
            // quantity breaks down — so they have to come to the same number or
            // the invoice stops agreeing with the paper it was read off.
            const billed = nf(it.qty) ?? 0
            const assigned = round3(runRows.reduce((n2, r) => n2 + (+r.qty || 0), 0))
            const balanced = billed ? sameQty(assigned, billed) : assigned > 0
            const keeping = runRows.filter((r) => String(r.size ?? '').trim() && +r.qty > 0).length
            // per piece: the rate where the bill states one, otherwise whatever
            // the line amount works out to across the pieces
            const unit = nf(it.rate) ?? (billed ? (nf(it.amount) || 0) / billed : 0)
            return (
              <React.Fragment key={i}>
              <tr>
                <td className="rowno" title="Line number on the invoice">{i + 1}</td>
                {ITEM_COLS.map(([k, , isNum, , tip]) => (
                  <td key={k} className={(isNum ? 'num' : '') + (ITEM_CALC.has(k) ? ' calc' : '')}
                    title={tip}>
                    {/* A bundle billed as one line is several stock items, and the
                        control that says so belongs IN the size column — beside the
                        "16*22" somebody is already looking at, not at the far end
                        of fifteen columns of pricing where nobody scrolls to find
                        it. It lights up when the size and the quantity between them
                        prove a run, which on a bill written this way is every
                        line. */}
                    {k === 'size' ? (
                      <div className="sizecell">
                        <input value={cell(it, k)} onChange={(e) => upd(i, k, e.target.value)} />
                        {/* Two jobs, and which one it has is settled by whether
                            this line is already one size OF a run. A line that is
                            has nothing left to split, so ≡ folds its group away
                            instead — which is the only thing anybody wants from a
                            row that says FROCK · 4313 · 16 · 1. */}
                        <button className={'runbtn' + (grouped ? ' fold wide'
                          : runFromSize(it.size, nf(it.qty)) ? ' on' : '')}
                          title={grouped
                            ? `Fold these ${g.to - g.from} sizes into one row`
                            : runFor === i ? 'Close the size detail'
                              : runFromSize(it.size, nf(it.qty))
                                ? `Split this line into ${parseSizeRun(runFromSize(it.size, nf(it.qty))).sizes.join(', ')}`
                                : 'Split this line into a size run — 28-2-38 becomes six lines, one per size'}
                          onClick={() => (grouped
                            ? setFolded({ ...folded, [g.sig]: true })
                            : openRun(i))}>
                          {grouped ? `≡ ${g.to - g.from}` : runFor === i ? '×' : '≡'}</button>
                      </div>
                    ) : (
                      <input size={1} value={cell(it, k)} list={ITEM_LISTED[k] ? 'essa-item-' + k : undefined}
                        onChange={(e) => upd(i, k, e.target.value)} />
                    )}
                  </td>
                ))}
                <td><button className="btn" style={{ padding: '2px 7px' }} onClick={() => delRow(i)}>×</button></td>
              </tr>
              {run && (
                <tr>
                  <td colSpan={ITEM_COLS.length + 2} className="runcell">
                    {/* the run, and what it would make */}
                    <div className="rowedit-bar sizerun">
                      <span className="runlabel">Line {i + 1} · size detail</span>
                      <input value={runSpec} placeholder="Start-Increment-End" autoFocus
                        onChange={(e) => { setRunSpec(e.target.value); setRunNote('') }}
                        onKeyDown={(e) => { if (e.key === 'Enter') genRows(i) }}
                        title={'Start – step – end, the way the packing slip writes it.\n'
                          + '28-2-38 is 28, 30, 32, 34, 36, 38 — and 28-38 steps by one.'} />
                      <button className="btn" disabled={!run.sizes.length} onClick={() => genRows(i)}
                        title={run.sizes.length
                          ? `List ${run.sizes.join(', ')} with the ${billed} pieces spread over them`
                          : 'Write the run as start-step-end first'}>⊕ Generate</button>
                      {runNote && <span className="runfrom">↳ {runNote}</span>}
                      <span className={'why' + (run.why ? ' bad' : '')}>
                        {run.why || (run.sizes.length
                          ? <><b>{listed}</b>
                              {` — ${run.sizes.length} sizes, `}
                              {even ? `${qtys[0]} each` : `${Math.min(...qtys)}–${Math.max(...qtys)} each`}</>
                          : 'Start–step–end. Generates the sizes below with the quantity spread over '
                            + 'them — change any of it before splitting.')}
                      </span>
                    </div>

                    {/* …and the list it makes, which is the part that gets
                        corrected. Nothing on the invoice has moved yet. */}
                    {runRows.length > 0 && (
                      <div className="runrows">
                        <table>
                          <thead><tr>
                            <th style={{ width: 24 }} />
                            <th>Size</th><th className="num">Qty</th>
                            <th className="num">Value</th><th style={{ width: 30 }} />
                          </tr></thead>
                          <tbody>
                            {runRows.map((r, n2) => (
                              <tr key={n2}>
                                <td className="rowno">{n2 + 1})</td>
                                <td><input value={r.size}
                                  onChange={(e) => updRunRow(n2, 'size', e.target.value)} /></td>
                                <td className="num"><input value={r.qty} inputMode="decimal"
                                  onChange={(e) => updRunRow(n2, 'qty', e.target.value)} /></td>
                                <td className="num money">{money((+r.qty || 0) * unit)}</td>
                                <td><button className="btn" style={{ padding: '1px 6px' }}
                                  title="Drop this size — it was not in the carton"
                                  onClick={() => dropRunRow(n2)}>×</button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="runfoot">
                          <button className="btn" onClick={addRunRow}
                            title="A size the run did not cover">+ add size</button>
                          <span className={'tally ' + (balanced ? 'ok' : 'bad')}>
                            {billed
                              ? <>{assigned} of {round3(billed)} assigned{balanced ? ' ✓'
                                  : assigned < billed
                                    ? ` · ${round3(billed - assigned)} still to place`
                                    : ` · ${round3(assigned - billed)} more than the line was billed`}</>
                              : <>{assigned} assigned · this line was billed no quantity</>}
                          </span>
                          <span className="tally">{money(assigned * unit)}</span>
                        </div>
                      </div>
                    )}

                    {/* what to do with it */}
                    <div className="rowedit-bar sizerun">
                      <button className="btn primary" disabled={!keeping || !balanced}
                        title={!keeping ? 'Generate the sizes first'
                          : balanced ? `Line ${i + 1} becomes ${keeping} lines`
                            : 'The sizes have to account for every piece the line was billed'}
                        onClick={() => splitRun(i)}>
                        {keeping ? `Split into ${keeping} lines` : 'Split into lines'}</button>
                      {alike.length > 1 && (
                        <button className="btn" disabled={!keeping}
                          title={`Apply these sizes to all ${alike.length} lines whose Size reads “${it.size}” `
                            + '— each line\'s own quantity is spread evenly over them'}
                          onClick={() => splitRunAll(i)}>Split all {alike.length} lines</button>
                      )}
                      <button className="btn" disabled={!runRows.length}
                        title="Empty the list and start again"
                        onClick={() => setRunRows([])}>Clear</button>
                      <button className="btn" onClick={closeRun}>Close</button>
                    </div>
                  </td>
                </tr>
              )}
              </React.Fragment>
            )
            })
          })}
        </tbody>
      </table>
      </div>
      <Pager {...page} noun="line" />
      {/* one datalist for the whole table, not one per row */}
      {Object.entries(ITEM_LISTED).map(([k, src]) => (
        <datalist key={k} id={'essa-item-' + k}>
          {(opts[src] || []).map((v) => <option key={v} value={v} />)}
        </datalist>
      ))}
      <div className="items-foot">
        <span>{items.length} lines</span>
        <span>Σ qty <b>{qtySum.toLocaleString('en-IN')}</b></span>
        {discSum > 0 && <span title="Σ ((MRP − Rate) × Qty) — the whole invoice's gap between printed price and cost">
          Σ MRP − cost <b>{money(discSum)}</b></span>}
        <span>Σ value <b>{money(amtSum)}</b></span>
        {/* A twenty-four-line invoice that is really six garments in four sizes
            each is six things to check, not twenty-four — but only if they can be
            put away all at once. One line at a time is not an offer anybody
            takes on a bill this shape. */}
        {runGroups.length > 0 && (
          <button className="btn" style={{ padding: '3px 10px', marginLeft: 'auto' }}
            title={allFolded ? 'Show every size line again'
              : `Fold each run of sizes into one row — ${runGroups.length} of them on this invoice`}
            onClick={() => setFolded(allFolded ? {}
              : Object.fromEntries(runGroups.map((g) => [g.sig, true])))}>
            {allFolded ? '⊞ show every size'
              : `⊟ fold ${runGroups.length} size group${runGroups.length === 1 ? '' : 's'}`}
          </button>
        )}
        <button className="btn" style={{ padding: '3px 10px', marginLeft: runGroups.length ? 0 : 'auto' }}
          onClick={addRow}>+ add line</button>
      </div>
    </div>
  )
}

// ---------- LR register candidate picker ----------
// Shown when no invoice/LR number lines up. These rows agree on supplier only,
// which is never enough to fill automatically — a supplier ships repeatedly — so
// the quantity column carries the tell and the operator makes the call.
const QTY_MARK = { ok: ['✓', 'qty matches the invoice'], mismatch: ['⚠', 'qty differs from the invoice'] }

function LrCandidates({ info, busy, onLink, onClose }) {
  const rows = info.rows || []
  // The transport block sits mid-page, so a panel appended under it lands
  // off-screen — telling the user rows are "listed below" and showing them
  // nothing. Bring it to them instead.
  const box = useRef(null)
  useEffect(() => { box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [info])
  return (
    <div className="lrcands" ref={box}>
      <div className="lrcands-head">
        <b>{rows.length ? `Pick this invoice's consignment — ${rows.length} likely row(s) in the register` : 'Nothing in the register to link'}</b>
        <button className="lrcands-x" title="Dismiss" onClick={onClose}>×</button>
      </div>
      <div className="lrcands-why">{info.detail}</div>
      {rows.length ? (
        <div className="lrcands-scroll">
          <table className="lrcands-tbl">
            <thead>
              <tr><th>LR No</th><th>LR Date</th><th>Transport</th>
                <th>Register invoice</th><th>Qty</th><th>Item</th><th>Fills</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const [mark, tip] = QTY_MARK[c.qty_agrees] || ['', 'qty unknown on one side']
                return (
                  <tr key={c.id}>
                    <td><b>{c.lr_no || '—'}</b></td>
                    <td>{fmtDate(c.lr_date)}</td>
                    <td>{c.transport || '—'}</td>
                    <td>{c.inv_no || '—'}{c.inv_date ? ` · ${fmtDate(c.inv_date)}` : ''}</td>
                    <td title={tip} className={'qty-' + c.qty_agrees}>{c.qty ?? '—'} {mark}</td>
                    <td>{c.item || '—'}</td>
                    <td className="small">{c.would_fill?.length ? c.would_fill.join(', ') : 'nothing blank'}</td>
                    <td>
                      <button className="btn" style={{ padding: '2px 9px' }} disabled={busy}
                        title={c.already_linked ? 'This row is already linked to another invoice' : 'Link this consignment to this invoice'}
                        onClick={() => onLink(c.id)}>{c.already_linked ? 'relink' : 'link'}</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

// ---------- review panel ----------
//
// Four tabs, one open at a time, laid out horizontally above the fields. The
// screen used to be seven stacked panels: reviewing a bill meant scrolling past
// six of them to reach the seventh, and the invoice image beside it scrolled out
// of reach on the way — which is the one thing a review screen cannot afford,
// since every field on it is being checked against that image.
//
// `paths` is what each tab OWNS, and it earns its keep twice: it counts the
// fields inside a closed tab that are flagged for review (a hidden warning is a
// warning that does not exist), and it is the single place that says where a
// field lives, so a field added to a panel cannot go uncounted.
const REVIEW_TABS = [
  { key: 'party', label: 'Supplier & Buyer', paths: ['supplier.', 'buyer.'],
    hint: 'Who sold it and who is billed — including the supplier’s bank' },
  { key: 'invoice', label: 'Invoice & Transport', paths: ['invoice.'],
    hint: 'Invoice numbers and dates, e-invoice, e-way bill and the consignment' },
  { key: 'money', label: 'Line Items, Taxes & Totals', paths: ['line_items', 'taxes.', 'totals.'],
    hint: 'The goods and the arithmetic — one calculation, one panel' },
  { key: 'grn', label: 'GRN & Notes', paths: ['meta.'],
    hint: 'The handwritten GRN number, who received it, and anything else' },
]

function Review({ docId, onSaved, onCreateGrn, toast }) {
  const [doc, setDoc] = useState(null)
  const [data, setData] = useState(null)
  const [flags, setFlags] = useState({})
  const [warnings, setWarnings] = useState([])
  const [train, setTrain] = useState(true)
  const [saving, setSaving] = useState(false)
  const [lrCands, setLrCands] = useState(null)   // register rows offered to link
  // which panel is open. Reset per document below: opening the next invoice on
  // the tab you happened to leave the last one on is how a field gets skipped.
  const [tab, setTab] = useState('party')
  // the invoice photograph, foldable. Remembered across documents and sessions
  // (useMinimized persists it) — how much room someone wants for the image is a
  // standing preference about how they work, not a per-invoice decision.
  const [imgOpen, toggleImg] = useMinimized('rev.image', true)
  // Which pages the browser could not fetch, by index. Tracked rather than left
  // to <img>'s broken-file icon: the icon says nothing, the cause is nearly
  // always one nameable server condition, and it matters WHICH page it was —
  // the last one carries the totals.
  const [lostPages, setLostPages] = useState({})

  // A document with no extraction is not a document still loading. Reading a
  // dense two-page invoice can outlast the request that started it, and what is
  // left behind is a stored, readable document with nothing attached — which
  // showed "Loading…" for ever, because the screen had no way to tell the two
  // apart.
  const [unread, setUnread] = useState(false)
  const [reading, setReading] = useState(false)

  useEffect(() => {
    if (!docId) return
    setTab('party'); setUnread(false); setLostPages({})
    api.getDocument(docId).then((d) => {
      setDoc(d.document)
      setUnread(!d.extraction)
      setData(structuredClone(d.extraction?.data || {}))
      setFlags(d.extraction?.field_flags || {})
      setWarnings(d.extraction?.warnings || [])
    })
  }, [docId])

  // Two documents with the same invoice number are one bill uploaded a page at
  // a time — the ordinary result of not knowing the upload takes both at once.
  // Neither half reconciles, because the totals are printed on the last page
  // and belong to lines the other document holds. Worth spotting for them
  // rather than leaving two plausible-looking invoices in the list.
  const [twin, setTwin] = useState(null)
  const [merging, setMerging] = useState(false)
  const invNo = data?.invoice?.number
  useEffect(() => {
    if (!docId || !invNo) { setTwin(null); return }
    let live = true
    api.listDocuments().then((all) => {
      if (!live) return
      const norm = (v) => String(v || '').replace(/\s+/g, '').toUpperCase()
      setTwin(all.find((d) => d.id !== docId && d.status !== 'posted'
        && norm(d.invoice_number) === norm(invNo)) || null)
    }).catch(() => {})
    return () => { live = false }
  }, [docId, invNo])

  const mergeTwin = async () => {
    if (!twin) return
    if (!window.confirm(
      `Fold "${twin.filename}" into this document?

`
      + 'Its pages are added here in page order and the whole invoice is read '
      + 'again. That document is then deleted, along with any draft GRN built '
      + 'from it.')) return
    setMerging(true)
    try {
      const d = await api.mergeDocuments(docId, twin.id)
      setDoc(d.document); setTwin(null)
      // Earlier load failures forgotten: this is a longer document now, and the
      // indexes they were recorded against no longer mean the same pages.
      setLostPages({})
      // The pages are joined whether or not the re-read finished. When it did
      // not, this drops into the same "uploaded but never read" screen, which
      // already offers to read it — rather than reporting a failure for work
      // that actually succeeded.
      setUnread(!d.extraction)
      setData(structuredClone(d.extraction?.data || {}))
      setFlags(d.extraction?.field_flags || {})
      setWarnings(d.extraction?.warnings || [])
      onSaved && onSaved()
      // Keyed on read_failed rather than on the presence of an extraction: the
      // server now KEEPS the half-reading when the re-read fails, so a document
      // can come back with data attached and still not have been read as a
      // whole. Reporting that as success would claim the second page's lines
      // and totals are in there when they are not.
      toast(d.read_failed
        ? `Pages joined (${d.merged?.pages}) but the invoice could not be read: ${d.read_failed}`
        : `Merged — ${d.merged?.pages} pages, ${d.extraction?.data?.line_items?.length || 0} lines`,
        d.read_failed ? 'err' : 'ok')
    } catch (e) {
      toast(e.detail || 'Could not merge them', 'err')
    }
    setMerging(false)
  }

  const readAgain = async () => {
    setReading(true)
    try {
      const d = await api.reExtract(docId)
      setDoc(d.document); setUnread(false)
      setData(structuredClone(d.extraction?.data || {}))
      setFlags(d.extraction?.field_flags || {})
      setWarnings(d.extraction?.warnings || [])
      onSaved && onSaved()
      toast(`Read ${d.extraction?.data?.line_items?.length || 0} lines`, 'ok')
    } catch (e) {
      toast(e.detail || 'Could not read it — try again', 'err')
    }
    setReading(false)
  }

  if (!docId) return <div className="empty">Select a document from the left, or upload a new invoice to extract it.</div>
  if (unread) return (
    <div className="empty" style={{ margin: 'auto', maxWidth: 460, lineHeight: 1.7 }}>
      <div style={{ fontSize: 26, marginBottom: 6 }}>📄</div>
      <b>{doc?.filename || 'This document'}</b> was uploaded but never read.<br />
      Reading a long invoice can take longer than the upload was given.
      The pages are stored, so it can be read now without uploading them again.
      <div style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={reading} onClick={readAgain}>
          {reading ? 'Reading — this can take a minute…' : 'Read it now'}</button>
      </div>
    </div>
  )
  if (!data) return <div className="empty">Loading…</div>

  const setPath = (obj, path, val) => {
    const c = structuredClone(obj); const ks = path.split('.'); let o = c
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] = o[ks[i]] || {}
    o[ks[ks.length - 1]] = val; return c
  }
  const get = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), data)
  // fields the LR register supplied (not read off the page) — badged, so nobody
  // trusts a docket number to be printed on the invoice when it wasn't. The badge
  // drops as soon as the value is edited: it vouches for a value, not a field.
  const lrFilled = data.meta?.lr_source?.filled || {}
  const fromLr = (path) => {
    if (!path.startsWith('invoice.')) return null
    const k = path.slice('invoice.'.length)
    return k in lrFilled && String(get(path) ?? '') === String(lrFilled[k] ?? '')
      ? 'LR register' : null
  }
  const f = (path, label, opts = {}) => (
    <Field label={label} value={get(path)} flagged={!!flags[path]} wide={opts.wide}
      source={fromLr(path)} date={opts.date} calc={opts.calc} note={opts.note}
      onChange={(v) => setData(setPath(data, path, opts.raw ? v : num(v)))} />
  )
  // A tax field, with its opposite number kept in step: type a rate and the
  // amount appears, type an amount and the rate appears. The totals follow both,
  // so the foot of the invoice is never left disagreeing with the block above it.
  const ft = (key, label, opts = {}) => (
    <Field label={label} value={tax[key]} flagged={!!flags['taxes.' + key]}
      calc={opts.calc} note={opts.note}
      onChange={(v) => {
        const taxes = recalcTaxes({ ...tax, [key]: num(v) }, taxBase(data), key)
        const next = { ...data, taxes }
        setData({ ...next, totals: recalcTotals(next) })
      }} />
  )
  // Recompute the whole foot from the lines up. Explicit, and never automatic on
  // load: this screen reviews what was read off a photograph, and an arrival that
  // quietly restated its own figures would hide the very disagreement the checks
  // above are reporting.
  const recalcAll = () => {
    const items = (data.line_items || []).map((it) => recalcLine(it, 'qty'))
    let next = { ...data, line_items: items }
    const base = taxBase(next)
    let taxes = { ...(next.taxes || {}) }
    for (const [rk, ak] of TAX_PAIRS) {
      if (nf(taxes[rk])) taxes = recalcTaxes(taxes, base, rk)
      else if (nf(taxes[ak])) taxes = recalcTaxes(taxes, base, ak)
    }
    next = { ...next, taxes }
    setData({ ...next, totals: recalcTotals(next) })
    toast('⟲ Recalculated from the lines up — check it against the image before saving', 'ok')
  }
  // a date read off the page: same review flags and LR-source badge as any other
  // field, but picked from a calendar instead of retyped
  const fd = (path, label) => f(path, label, { raw: true, date: true })

  // The register is often photographed after the invoices it covers, so the
  // automatic pass on upload can find nothing. This re-runs it on demand, and
  // when no invoice/LR number lines up it offers this supplier's register rows
  // to pick from rather than dead-ending on "no match".
  const applyLrResult = (r) => {
    if (r.data) setData(structuredClone(r.data))
    if (r.notes?.length) setWarnings((w) => [...w, ...r.notes])
  }
  const fetchFromLr = async () => {
    setSaving(true)
    try {
      const r = await api.fetchTransport(docId)
      const n = Object.keys(r.filled || {}).length
      if (n) {
        applyLrResult(r); setLrCands(null)
        toast(`🔗 Filled ${n} transport field(s) from the LR register`, 'ok')
      } else {
        if (r.candidates) setLrCands({ detail: r.detail, rows: r.candidates })
        toast(r.detail || 'Nothing to fill from the LR register', 'warn')
      }
    } catch (e) { toast('LR fetch failed: ' + (e.detail || e.message), 'err') }
    setSaving(false)
  }
  const linkLrRow = async (lrEntryId) => {
    setSaving(true)
    try {
      const r = await api.fetchTransport(docId, lrEntryId)
      applyLrResult(r); setLrCands(null)
      const n = Object.keys(r.filled || {}).length
      toast(n ? `🔗 Linked · filled ${n} field(s)` : 'Linked — nothing blank left to fill',
        n ? 'ok' : 'warn')
    } catch (e) { toast('Link failed: ' + (e.detail || e.message), 'err') }
    setSaving(false)
  }

  const sup = data.supplier || {}, inv = data.invoice || {}, tax = data.taxes || {}, tot = data.totals || {}

  const save = async () => {
    setSaving(true)
    try {
      const res = await api.confirm(docId, data, train)
      toast(res.trained_profile ? '✓ Saved & supplier format trained' : '✓ Saved', 'ok')
      onSaved()
      const d = await api.getDocument(docId); setDoc(d.document)
    } catch (e) { toast('Save failed: ' + (e.detail || e.message), 'err') }
    setSaving(false)
  }

  const createGrn = async () => {
    setSaving(true)
    try {
      // If not confirmed yet, persist the current edits first (train per checkbox),
      // so one click on Create GRN always works from a freshly-extracted document.
      if (!doc || (doc.status !== 'confirmed' && doc.status !== 'posted')) {
        await api.confirm(docId, data, train)
        onSaved()
      }
      const grn = await api.buildGrn(docId)
      toast(`GRN draft created · ${grn.new_products} new product(s)`, 'ok')
      onCreateGrn(grn.id)
    } catch (e) { toast('Could not create GRN: ' + (e.detail || e.message), 'err') }
    setSaving(false)
  }

  return (
    <div className="main">
      {/* The image and the fields compete for one screen, and which one needs the
          room changes with the job: checking a GSTIN against a photograph wants
          the image, keying a twelve-size breakdown wants the table. So it folds
          away — to the same 36mm rail the lists use, carrying its own label,
          because the way back has to be visible from where the image went. */}
      <div className={'viewer' + (imgOpen ? '' : ' collapsed')}>
        {imgOpen ? (
          <>
            <button className="sidehide" onClick={toggleImg}
              title="Hide the invoice image — the screen keeps this setting">«</button>
            <div className="viewerscroll">
              {/* A hand-keyed invoice has no photograph, and pointing an <img>
                  at the image route would draw a broken-image icon where the
                  bill should be — which reads as "the scan failed to load",
                  something far more alarming than "this one was typed".
                  `has_image` is false only on a manual entry; a document that
                  predates the flag has no such key, so an undefined is treated
                  as "yes, there is one" and nothing already uploaded changes. */}
              {doc && doc.has_image === false ? (
                <div className="noimage">
                  <div className="noimage-ico" aria-hidden="true">📄</div>
                  <b>Keyed in by hand</b>
                  <span>There is no scan behind this one — the fields on the
                    right are the record. Confirm it the same way.</span>
                </div>
              ) : (
                /* EVERY page, stacked, rather than one with controls to reach
                   the others. Two photographs of one bill is a document to be
                   scrolled, the way the paper is turned over — and a merge that
                   worked has to LOOK like it worked, which a viewer showing one
                   page and a "2 of 2" counter does not. Checking that the lines
                   on the right cover both pages means seeing both pages.

                   page_count is absent on a payload from a server that predates
                   it; `|| 1` keeps that showing its single page rather than
                   nothing at all. */
                <div className="pagestack">
                  {Array.from({ length: doc?.page_count || 1 }, (_, i) => (
                    <figure className="pagefig" key={`${docId}:${i}:${doc?.content_hash || ''}`}>
                      {(doc?.page_count || 1) > 1 && (
                        <figcaption>Page {i + 1} of {doc.page_count}
                          {i === doc.page_count - 1 && <> · the totals are on this one</>}
                        </figcaption>
                      )}
                      {lostPages[i] ? (
                        /* Per page, because one missing page does not make the
                           others unviewable — and because WHICH page is gone is
                           the useful part: the last one carries the totals, and
                           its absence explains a reading that will not add up.
                           This is also the case the broken-file icon was hiding:
                           the row is in the database and the file is not, which
                           is exactly why the extractor read nothing off it. */
                        <div className="noimage lost">
                          <div className="noimage-ico" aria-hidden="true">🚫</div>
                          <b>Page {i + 1} is not in storage</b>
                          <span>This row is in the database but its image file is
                            not, so there was nothing for the extractor to read
                            either. Upload the invoice again — all its pages at
                            once. If this keeps happening the server's upload
                            folder is not surviving restarts;{' '}
                            <code>/api/status</code> → <b>storage</b> says where
                            files are being put.</span>
                        </div>
                      ) : (
                        <img src={api.imageUrl(docId, doc?.content_hash, i)}
                          alt={`invoice page ${i + 1}`} loading="lazy"
                          onError={() => setLostPages((p) => ({ ...p, [i]: true }))} />
                      )}
                    </figure>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <button className="siderail" onClick={toggleImg} title="Show the invoice image">
            <span className="chev" aria-hidden="true">»</span>
            <span className="raillabel">Invoice image</span>
          </button>
        )}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="editor">
          {twin && (
            <div className="warnbox" style={{ marginBottom: 20 }}>
              <h4>Another document carries this invoice number</h4>
              <div className="small" style={{ lineHeight: 1.7 }}>
                <b>{twin.filename}</b> is also <b>#{twin.invoice_number}</b>
                {twin.grand_total != null && <> at ₹ {money(twin.grand_total)}</>}.
                A bill printed on more than one page uploaded a page at a time
                gives two documents like this, and neither adds up on its own —
                the totals are on the last page.
                <div style={{ marginTop: 10 }}>
                  <button className="btn primary" disabled={merging} onClick={mergeTwin}>
                    {merging ? 'Merging and re-reading…' : 'Merge them into one invoice'}</button>
                </div>
              </div>
            </div>
          )}
          <div className={'warnbox ' + (warnings.filter((w)=>!w.includes('OCR')&&!w.includes('vision')&&!w.includes('sample')).length ? '' : 'clean')} style={{ marginBottom: 20 }}>
            <h4>{warnings.length ? `${warnings.length} check(s)` : 'All internal checks passed'}
              {/* Confidence answers "how sure is the READING", so on an invoice
                  nobody read it is not a low score — it is not a question. The
                  manual entry is stored at 0, and printing "confidence 0%" in
                  red would accuse a bill of being badly extracted when it was
                  never extracted at all. */}
              {doc && (doc.has_image === false
                ? <span className="small" style={{ float: 'right' }}>keyed in by hand · not extracted</span>
                : <span className="small" style={{ float: 'right' }}>via {doc && data.template_key ? '' : ''}extraction · confidence <b className={'conf ' + confClass(doc?.confidence)}>{doc ? Math.round(doc.confidence * 100) + '%' : '—'}</b></span>)}
            </h4>
            {warnings.length ? <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
            {/* Reading it again was reachable ONLY from the "uploaded but never
                read" screen — which is shown when a document has NO extraction.
                A document with a BAD one therefore had no way back: a reading
                that failed and left every field blank is exactly the case where
                someone wants to try again, and it was the one case with no
                button. That is also what a merge leaves behind when the re-read
                did not work, so the operator was stuck holding a merged invoice
                and no way to re-read it.

                Offered on any document that has a photograph and is not yet
                posted; the server refuses a posted one anyway, because its GRN
                was built from the reading being replaced. */}
            {doc && doc.has_image !== false && doc.status !== 'posted' && (
              <div style={{ marginTop: 10 }}>
                <button className="btn" disabled={reading} onClick={readAgain}>
                  {reading ? 'Reading — this can take a minute…' : 'Read it again'}</button>
                <span className="small" style={{ marginLeft: 10 }}>
                  Replaces this reading with a fresh one from the
                  {(doc.page_count || 1) > 1 ? ` ${doc.page_count} stored pages` : ' stored page'}.
                  Anything typed here by hand and not yet confirmed is lost.
                </span>
              </div>
            )}
          </div>

          {/* Four tabs, one open at a time. Seven stacked panels made the screen a
              long vertical scroll in which the fields being checked and the
              invoice image were rarely on screen together — and a review done by
              scrolling is a review done from memory.
              The risk this trades for is real and handled: a flagged field inside
              a closed tab is invisible, so each tab carries the count of its own
              fields needing review, and the checks box above stays put. */}
          <div className="revtabs" role="tablist">
            {REVIEW_TABS.map((t) => {
              const n = Object.keys(flags).filter(
                (k) => t.paths.some((p) => k.startsWith(p))).length
              return (
                <button key={t.key} role="tab" aria-selected={tab === t.key}
                  className={'revtab' + (tab === t.key ? ' on' : '') + (n ? ' flagged' : '')}
                  onClick={() => setTab(t.key)}
                  title={n ? `${n} field(s) here need review` : t.hint}>
                  {t.label}
                  {n ? <span className="revtab-n" title={`${n} field(s) need review`}>⚠ {n}</span> : null}
                </button>
              )
            })}
          </div>

          {tab === 'party' && (
          <div className="section">
            <h4>Supplier &amp; Buyer</h4>
            <h5>Supplier</h5>
            <div className="grid">
              {f('supplier.name', 'Name', { raw: true })}
              {f('supplier.legal_name', 'Legal / Trading Name', { raw: true })}
              {f('supplier.gstin', 'GSTIN', { raw: true })}
              {f('supplier.pan', 'PAN', { raw: true })}
              {f('supplier.state', 'State', { raw: true })}
              {f('supplier.state_code', 'State Code', { raw: true })}
              {f('supplier.cin', 'CIN', { raw: true })}
              {f('supplier.phone', 'Phone', { raw: true })}
              {f('supplier.email', 'Email', { raw: true })}
              {f('supplier.manufacturer', 'Manufacturer / MFG by', { raw: true })}
              {f('supplier.address', 'Address', { raw: true, wide: true })}
            </div>
            {/* the bank and the buyer are short blocks — side by side they cost
                one screen between them instead of two */}
            <div className="moneysplit">
              <div>
                <h5>Supplier Bank</h5>
                <div className="grid">
                  {f('supplier.bank.name', 'Bank Name', { raw: true })}
                  {f('supplier.bank.account_no', 'Account No', { raw: true })}
                  {f('supplier.bank.ifsc', 'IFSC', { raw: true })}
                  {f('supplier.bank.branch', 'Branch', { raw: true })}
                </div>
              </div>
              <div>
                <h5>Buyer (bill to)</h5>
                <div className="grid">
                  {f('buyer.name', 'Name', { raw: true })}
                  {f('buyer.gstin', 'GSTIN', { raw: true })}
                  {f('buyer.state', 'State', { raw: true })}
                  {f('buyer.address', 'Address', { raw: true, wide: true })}
                </div>
              </div>
            </div>
          </div>
          )}

          {tab === 'invoice' && (
          <div className="section">
            <h4>Invoice &amp; Transport
              <button className="h4btn" disabled={saving} onClick={fetchFromLr}
                title="Fill LR No, LR Date, Transporter and Book City from the matching LR register row">
                ⟲ fetch from LR register</button>
            </h4>
            <h5>Invoice</h5>
            <div className="grid">
              {f('invoice.number', 'Invoice No', { raw: true })}
              {fd('invoice.date', 'Date')}
              {fd('invoice.due_date', 'Due Date')}
              {f('invoice.challan_no', 'Challan / DC No', { raw: true })}
              {f('invoice.order_no', 'Order No', { raw: true })}
              {fd('invoice.order_date', 'Order Date')}
              {f('invoice.reference_no', 'Reference No', { raw: true })}
              {f('invoice.terms', 'Payment Terms', { raw: true })}
              {f('invoice.agent', 'Agent', { raw: true })}
              {f('invoice.broker', 'Broker', { raw: true })}
            </div>
            <h5>E-invoice &amp; Transport</h5>
            <div className="grid">
              {f('invoice.irn', 'IRN', { raw: true, wide: true })}
              {f('invoice.ack_no', 'ACK No', { raw: true })}
              {fd('invoice.irn_date', 'IRN Date')}
              {f('invoice.eway_bill', 'E-way Bill', { raw: true })}
              {f('invoice.tran_id', 'Transport / EWB Tran ID', { raw: true })}
              {f('invoice.lr_no', 'LR No', { raw: true })}
              {fd('invoice.lr_date', 'LR Date')}
              {f('invoice.transporter', 'Transporter', { raw: true })}
              {f('invoice.destination', 'Destination', { raw: true })}
              {f('invoice.book_city', 'Book City', { raw: true })}
              {f('invoice.delivery_note', 'Delivery Note', { raw: true })}
            </div>
            {lrCands && <LrCandidates info={lrCands} busy={saving}
              onLink={linkLrRow} onClose={() => setLrCands(null)} />}
          </div>
          )}

          {/* Lines, taxes and totals are ONE calculation, so they are one panel.
              Split across three collapsed accordions, the arithmetic that ties
              them together was invisible: you could not see a rate change reach
              the grand total without opening two more sections, and a tax typed
              against the wrong taxable value looked perfectly fine. */}
          {tab === 'money' && (
          <div className="section money">
            <h4>Line Items, Taxes &amp; Totals
              <span className="calcbase" title="The figure every tax rate below is charged on">
                taxable base ₹ {money(taxBase(data))}</span>
              <button className="h4btn" onClick={recalcAll}
                title="Recompute rates, taxes and totals from the line items up. Never runs on its own — check the result against the image.">
                ⟲ recalculate</button>
            </h4>
            <LineItems items={data.line_items || []}
              setItems={(it) => {
                const next = { ...data, line_items: it }
                setData({ ...next, totals: recalcTotals(next) })
              }} />

            <div className="moneysplit">
              <div>
                <h5>Taxes</h5>
                <div className="grid">
                  {ft('cgst_rate', 'CGST %', { calc: 'Half of an intra-state levy — SGST follows it.' })}
                  {ft('cgst_amount', 'CGST Amount', { calc: 'CGST % × taxable base. Type an amount to set the %.' })}
                  {ft('sgst_rate', 'SGST %', { calc: 'The other half — mirrors CGST unless you set it apart.' })}
                  {ft('sgst_amount', 'SGST Amount', { calc: 'SGST % × taxable base. Type an amount to set the %.' })}
                  {ft('igst_rate', 'IGST %', { calc: 'Inter-state levy, charged instead of CGST + SGST.' })}
                  {ft('igst_amount', 'IGST Amount', { calc: 'IGST % × taxable base. Type an amount to set the %.' })}
                  {ft('special_discount_pct', 'Special Discount %', { calc: 'What the discount below comes to as a percentage.' })}
                  {ft('special_discount', 'Special Discount', { calc: '% × taxable base. Type an amount to see its %. Deducted from the grand total.' })}
                  {ft('other_charges', 'Other Charges')}
                  {ft('freight', 'Freight')}
                  {ft('round_off', 'Round Off')}
                  {ft('tds_amount', 'TDS', { note: 'Deducted when the bill is paid, not from the invoice total.' })}
                </div>
              </div>
              <div>
                <h5>Totals</h5>
                <div className="grid">
                  {f('totals.total_qty', 'Total Qty', { calc: 'Σ of the Qty column.' })}
                  {f('totals.sub_total', 'Sub Total', { calc: 'Σ of the Amount column.' })}
                  {f('totals.taxable_total', 'Taxable Total', { calc: 'Σ of the Taxable column — what the tax rates are charged on.' })}
                  {f('totals.tax_total', 'Tax Total', { calc: 'CGST + SGST + IGST.' })}
                  {f('totals.grand_total', 'Grand Total', { calc: 'Taxable + tax + charges + freight − special discount + round off.' })}
                  {f('totals.amount_in_words', 'Amount in Words', { raw: true, wide: true })}
                </div>
              </div>
            </div>
          </div>
          )}

          {tab === 'grn' && (
          <div className="section">
            <h4>GRN &amp; Notes</h4>
            <div className="grid">
              {f('meta.grn_no', 'GRN No', { raw: true })}
              {fd('meta.grn_date', 'GRN Date')}
              {f('meta.received_by', 'Received By', { raw: true })}
              {f('meta.notes', 'Notes', { raw: true, wide: true })}
            </div>
          </div>
          )}
        </div>

        <div className="actionbar">
          <label className="chk"><input type="checkbox" checked={train} onChange={(e) => setTrain(e.target.checked)} />
            Train this supplier's format on save</label>
          <div className="spacer" />
          <a className="btn" href={api.exportUrl(docId, 'csv')} target="_blank" rel="noreferrer">Export CSV</a>
          <button className="btn primary" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : train ? 'Confirm & Train' : 'Confirm'}</button>
          <button className="btn" style={{ borderColor: 'var(--accent-2)', color: 'var(--accent-2)' }}
            disabled={saving}
            title="Confirms the extraction (and trains the supplier if ticked), then builds a GRN"
            onClick={createGrn}>Create GRN →</button>
        </div>
      </div>
    </div>
  )
}

// ---------- suppliers ----------
function Suppliers({ toast }) {
  const [list, setList] = useState([])
  const [sel, setSel] = useState(null)
  const [detail, setDetail] = useState(null)
  const [q, setQ] = useState('')
  useEffect(() => { api.listSuppliers().then(setList) }, [])
  useEffect(() => { if (sel) api.getSupplier(sel).then(setDetail) }, [sel])
  const supShown = list.filter((s) => matches(s, q, ['name', 'gstin', 'state']))
  const supPage = usePaged(supShown, 50)
  return (
    <div className="body">
      <Sidebar id="suppliers" label="Suppliers">
        <div className="head"><h3>Suppliers · {list.length}</h3></div>
        <SearchBox value={q} onChange={setQ} placeholder="Search name, GSTIN, state…" />
        <div className="list">
          {supPage.slice.map((s) => (
            <div key={s.id} className={'sup-row' + (sel === s.id ? ' sel' : '')} onClick={() => setSel(s.id)}>
              <div className="t">{s.name}</div>
              <div className="m">
                <span className={'trainflag ' + (s.has_profile ? 'yes' : 'no')}>{s.has_profile ? `trained v· ${s.profile_samples} sample(s)` : 'not trained'}</span>
                <span>{s.document_count} doc(s)</span>
              </div>
            </div>
          ))}
        </div>
        <Pager {...supPage} noun="supplier" />
      </Sidebar>
      {detail ? (
        <div className="sup-detail">
          <h2 style={{ marginTop: 0 }}>{detail.name}</h2>
          <div className="kv">
            <div className="k">GSTIN</div><div className="mono">{detail.gstin || '—'}</div>
            <div className="k">State</div><div>{detail.state || '—'} ({detail.state_code || '—'})</div>
            <div className="k">Address</div><div>{detail.address || '—'}</div>
            <div className="k">Bank</div><div>{detail.bank?.name ? `${detail.bank.name} · A/C ${detail.bank.account_no} · ${detail.bank.ifsc}` : '—'}</div>
          </div>
          <h4 style={{ marginTop: 24 }}>Learned format {detail.profile ? `(v${detail.profile.version})` : ''}</h4>
          {detail.profile ? (
            <div className="kv">
              <div className="k">Tax mode</div><div>{detail.profile.tax_mode}</div>
              <div className="k">Default rates</div><div className="mono">{JSON.stringify(detail.profile.default_tax_rates)}</div>
              <div className="k">Has TDS</div><div>{detail.profile.has_tds ? 'yes' : 'no'}</div>
              <div className="k">Default UOM</div><div>{detail.profile.uom_default}</div>
              <div className="k">Detect by GSTIN</div><div className="mono">{detail.profile.detect_gstin || '—'}</div>
              <div className="k">Confirmed samples</div><div>{detail.profile.sample_count}</div>
            </div>
          ) : <p className="small">No profile yet.</p>}
        </div>
      ) : <div className="empty">Select a supplier to see its learned format.</div>}
    </div>
  )
}

// ---------- purchases / GRN ----------
// The attributes that make a breakdown row its own stock item — same set the phone
// detail form and the QR payload carry. [key, label, column width]
// The stock master's attribute columns (Attributes Reference.xlsx) less PRODUCT,
// which is the category and has its own cell. Brand leads: it is what the eye
// reaches for on a rack, and it is identity — an ESSA t-shirt and a YUVA t-shirt
// in the same size are two stock items. Every one of these becomes part of the
// variant's identity, its label and its QR.
const SPLIT_ATTRS = [
  ['brand', 'Brand', 105], ['size', 'Size', 90], ['color', 'Colour', 100],
  ['material', 'Material', 100], ['pattern', 'Pattern', 100], ['fit', 'Fit', 95],
  ['style', 'Style', 105], ['sleeve', 'Sleeve', 90], ['product_type', 'Type', 100],
  ['design_no', 'Design No', 95],
]
//: The one figure that is genuinely PER ROW: how many of that variant arrived.
//: It is the whole point of the breakdown, so it stays in the grid.
const SPLIT_QTY = [['qty', 'Qty', 70]]
// Money is NOT here. It used to be four more columns per row — rate, MRP,
// discount %, sale price — which made a grid of ten attributes into a 1,700px
// scroll, and every row of it carried the same four figures anyway: a bundle
// broken into sizes is one product at one price in several sizes. It lives on
// the LINE now, beside the rate and amount it is worked out against, and a
// variant with none of its own takes the line's when the product is created.
const blankVariant = (rate, category) => ({ ...Object.fromEntries(SPLIT_ATTRS.map(([k]) => [k, ''])),
  category: category || '', qty: '', rate: rate ?? '', mrp: '', sale_price: '', sale_discount_pct: '' })
// quantities are floats — compare with the same tolerance the server posts with
const sameQty = (a, b) => Math.abs((+a || 0) - (+b || 0)) < 0.001
const variantLabel = (r) => SPLIT_ATTRS.map(([k]) => r[k]).filter(Boolean).join(' · ')

// --- shortage entry: what was billed and wasn't in the box ---
// Recorded on the GRN before it posts, because that is the last moment anyone can
// know it. Afterwards stock says 40, the invoice says 50, and nothing on the
// system remembers that the two ever disagreed. The phone app is where this is
// normally keyed — the person opening the cartons is the only one who can — and
// this is the desk-side mirror of the same endpoints.
const SHORT_KINDS = [
  ['short', 'Short', 'billed but not in the box'],
  ['damaged', 'Damaged', 'arrived unusable, rejected at the dock'],
  ['excess', 'Excess', 'more arrived than was billed'],
]
const blankShortage = (qty) => ({ kind: 'short', qty: qty != null ? String(qty) : '', variant: '', reason: '', note: '' })
// what the breakdown still has to reach: what ARRIVED, not what was billed
const receivedQty = (l) => +(l.received_qty != null ? l.received_qty : l.qty) || 0

function Purchases({ selId, setSelId, toast }) {
  const [grn, setGrn] = useState(null)
  const [q, setQ] = useState('')
  const opts = useProductOptions()                 // attribute option lists
  const [cats, setCats] = useState([])             // category master names
  const [splitFor, setSplitFor] = useState(null)   // line id whose breakdown is open
  const [srows, setSrows] = useState([])           // editable variant rows
  const [runSpec, setRunSpec] = useState('')       // "28-2-38" for the open breakdown
  const [sfill, setSfill] = useState({})           // in-progress "apply to every row" values
  const [shortFor, setShortFor] = useState(null)   // line id whose shortage is open
  const [shrows, setShrows] = useState([])         // editable shortage rows
  const [shortOpts, setShortOpts] = useState({ reasons: [] })
  const [units, setUnits] = useState({ types: [], rules: [] })   // unit master
  const [warehouses, setWarehouses] = useState([])  // where a delivery can land
  // the sidebar list is one server page (grnPage, below) — refreshing it is
  // re-reading that page, not the whole register
  const refresh = () => grnPage.reload()
  useEffect(() => {
    api.locationTree().then((t) => setWarehouses(
      (t.warehouses || []).filter((w) => w.id && w.active !== false))).catch(() => {})
  }, [])
  useEffect(() => { if (selId) api.getPurchase(selId).then(setGrn); else setGrn(null) }, [selId])
  useEffect(() => { api.unitTypes().then(setUnits).catch(() => {}) }, [])
  // The category master this GRN may classify into is the RECEIVING WAREHOUSE'S.
  // A silk receipt must never be offered ESSA KIDS-TRUNK, and a warehouse whose
  // catalogue is still empty correctly offers nothing at all — which is the
  // prompt to go and build it, not a reason to file silk as a garment.
  useEffect(() => {
    const wh = warehouses.find((w) => w.id === grn?.warehouse_id)
    const cid = wh?.catalogue_id
    const p = cid ? api.catalogueCategories(cid).then((r) => (r.categories || []).map((i) => i.name))
      : api.categories().then((c) => (c.items || []).map((i) => i.name))
    p.then(setCats).catch(() => setCats([]))
  }, [grn?.warehouse_id, warehouses])
  useEffect(() => { api.shortageOptions().then(setShortOpts).catch(() => {}) }, [])
  useEffect(() => { setSplitFor(null); setSrows([]); setShortFor(null); setShrows([]) }, [selId])

  const reload = async () => { const g = await api.getPurchase(selId); setGrn(g); refresh(); return g }

  const post = async () => {
    const sh = grn?.shortages || {}
    // stated at the moment it stops being editable: posting is what turns "40
    // arrived" into the stock figure and "10 short" into a claim
    if (sh.claimable_qty && !window.confirm(
      `Post this GRN?\n\n`
      + `⚠ ${sh.claimable_qty} unit(s) recorded short or damaged (₹ ${money(sh.claimable_value)}).\n\n`
      + `They stay OUT of stock and become a claim against the supplier — raise it as a debit note in Returns.\n`
      + `The invoice keeps its own quantity, so the payables side still reconciles against the supplier's document.`)) return
    try {
      const r = await api.postGrn(selId)
      const sizes = r.size_rows ? ` · ${r.size_rows} size row(s)` : ''
      const short = r.short_qty ? ` · ${r.short_qty} short (₹ ${money(r.short_value)} to claim)` : ''
      // a receipt that turned dozens into pairs has to say so — otherwise the
      // stock figure looks like it lost half of what was billed
      const conv = r.converted?.length ? `\n${r.converted.join('\n')}` : ''
      const labels = r.pieces ? ` · ${r.pieces} QR label(s)` : ''
      // WHERE it landed, said on the receipt confirmation. With more than one
      // warehouse the answer is no longer obvious, and the moment to catch a
      // delivery booked into the wrong building is now — while unposting it is
      // still just an unpost.
      const at = r.warehouse ? ` into ${r.warehouse}` : ''
      toast(`✓ Posted to inventory${at} · ${r.products_created} new, ${r.products_updated} updated${sizes}${labels}${short}${conv}`, 'ok')
      reload()
    } catch (e) { toast('Post failed: ' + (e.detail || e.message), 'err') }
  }

  const setWarehouse = async (warehouse_id) => {
    try {
      setGrn(await api.setGrnWarehouse(selId, warehouse_id ? +warehouse_id : null))
      refresh()
    } catch (e) { toast(e.detail || 'Could not set the warehouse', 'err') }
  }

  // --- shortage entry ---
  const openShortage = (l, preset) => {
    setSplitFor(null)
    setShortFor(l.id)
    setShrows(l.shortages?.length
      ? l.shortages.map((s) => ({ kind: s.kind, qty: String(s.qty), variant: s.variant || '',
        reason: s.reason || '', note: s.note || '' }))
      : [blankShortage(preset)])
  }
  const updShrow = (i, k, v) => setShrows(shrows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  const saveShortage = async (l, rows) => {
    try {
      await api.setLineShortages(l.id, rows)
      setShortFor(null); setShrows([])
      await reload()
      const missing = round3(rows.filter((r) => r.kind !== 'excess').reduce((n, r) => n + (+r.qty || 0), 0))
      const extra = round3(rows.filter((r) => r.kind === 'excess').reduce((n, r) => n + (+r.qty || 0), 0))
      toast(rows.length
        ? `✓ Recorded — ${[missing && `${missing} short of ${l.qty} billed`, extra && `${extra} extra`]
            .filter(Boolean).join(', ')}`
        : '✓ Shortage cleared — the whole billed quantity is expected again', 'ok')
    } catch (e) { toast(e.detail || 'Could not record the shortage', 'err') }
  }
  const waive = async (s) => {
    const why = window.prompt('Accept this shortage instead of claiming it?\n\n'
      + 'It stays on the record — this only stops it being offered on the next debit note.\n\nWhy?', 'supplier sending balance')
    if (why === null) return
    try { await api.waiveShortage(s.id, why); await reload(); toast('✓ Shortage waived', 'ok') }
    catch (e) { toast(e.detail || 'Could not waive it', 'err') }
  }
  const unwaive = async (s) => {
    try { await api.unwaiveShortage(s.id); await reload(); toast('✓ Back in play — claimable again', 'ok') }
    catch (e) { toast(e.detail || 'Could not reopen it', 'err') }
  }

  // --- unpost: reverse a posted GRN so it can be corrected and posted again ---
  const unpost = async () => {
    let blockers = []
    try { blockers = (await api.unpostCheck(selId)).blockers || [] } catch { /* server will re-check */ }
    if (blockers.length) {
      toast('Can’t unpost — ' + blockers.join('; '), 'err')
      return
    }
    if (!window.confirm(
      'Unpost this GRN?\n\n'
      + '• the stock it added is reversed (the ledger keeps both rows)\n'
      + '• weighted-average cost is recomputed without it\n'
      + '• products it created, that nothing else has touched, are removed\n'
      + '• the GRN goes back to draft so you can correct it and post again')) return
    try {
      const r = await api.unpostGrn(selId)
      const gone = r.products_removed?.length ? ` · ${r.products_removed.length} product(s) removed` : ''
      const kept = r.products_kept?.length ? ` · ${r.products_kept.length} kept at zero stock` : ''
      toast(`✓ Unposted · ${r.movements_reversed} movement(s), ${r.qty_reversed} units reversed${gone}${kept}`, 'ok')
      reload()
    } catch (e) { toast(e.detail || 'Unpost failed', 'err') }
  }
  const removeGrn = async () => {
    if (!window.confirm('Delete this draft GRN?\n\nThe invoice document stays — you can build a fresh GRN from it.')) return
    try {
      await api.deletePurchase(selId)
      toast('✓ GRN deleted', 'ok')
      setSelId(null); setGrn(null); refresh()
    } catch (e) { toast(e.detail || 'Could not delete the GRN', 'err') }
  }

  // --- attribute breakdown: the supplier bills a bundle, the warehouse enters
  //     what actually arrived (size / colour / material / … per row) ---
  const openSplit = (l) => {
    setSplitFor(l.id)
    setRunSpec('')
    setSfill({})
    const from = (s) => {
      const r = blankVariant(l.rate)
      Object.keys(r).forEach((k) => { if (s[k] != null) r[k] = s[k] })
      return r
    }
    if (l.splits.length) { setSrows(l.splits.map(from)); return }
    // A new row starts from what the LINE already says about itself: its category
    // (or the mapping it would get), and the brand, design number and size that
    // came off the invoice. The common case — one garment, one brand, one design,
    // several sizes — should need none of that typed twice, and a brand re-keyed
    // per size is a brand that ends up spelled two ways.
    //
    // The size cell is carried across as it was written. When it holds a run the
    // parser could read, the branch below overwrites it with the size of each row
    // it found, so this only ever shows through on a line whose size is a single
    // value — or one written in a form the parser declined to guess at, which
    // arrives verbatim for the operator to correct rather than to retype.
    const blank = () => ({
      ...blankVariant(l.rate, l.category || l.category_suggestion?.best),
      ...(l.brand ? { brand: l.brand } : {}),
      ...(l.design_no ? { design_no: l.design_no } : {}),
      ...(l.size ? { size: l.size } : {}),
    })
    // The supplier printed the mix in the size column — "30:2, 32:4, 34:4, 36:2"
    // is the count already done by whoever packed the carton. Re-keying it here
    // is how it gets keyed wrong, so it arrives filled in and the operator checks
    // it rather than types it. Nothing is saved until they press Save.
    const run = l.size_breakdown
    if (run?.rows?.length) {
      setSrows(run.rows.map((r) => ({
        ...blank(), size: String(r.size), qty: String(r.qty),
        mrp: l.mrp ?? '', sale_price: l.sale_price ?? '',
        sale_discount_pct: l.sale_discount_pct ?? '',
      })))
      toast(run.matches
        ? `↳ ${run.rows.length} sizes read off the invoice — ${run.total} of ${receivedQty(l)}, adds up ✓`
        : `↳ ${run.rows.length} sizes read off the invoice — ${run.why || 'check the quantities'}`,
        run.matches ? 'ok' : 'warn')
      return
    }
    setSrows([blank()])
  }
  const setLineCat = async (l, name) => {
    try { await api.editLine(l.id, { category: name }); await reload() }
    catch (e) { toast(e.detail || 'Could not set the category', 'err') }
  }
  // Retail pricing, on the LINE beside the rate and the amount it belongs with.
  // It used to be four columns repeated down the breakdown grid, which is a
  // strange place for it: a bundle broken into sizes is one product at one price
  // in several sizes, and the server has always read a blank on a variant as
  // "the line's" anyway. One place to type it, one place to correct it.
  //
  // The three move each other exactly as they do on the invoice review screen —
  // MRP − Discount % = Sale price, in whichever direction was typed — so the
  // whole trio is worked out here and sent together.
  //: one figure typed on one line, turned into the whole trio that line should
  //: now carry. Pulled out because Apply all needs exactly the same answer for
  //: sixty lines at once, and two copies of this arithmetic would drift.
  const priceBody = (l, k, v) => {
    const row = recalcSale({ mrp: l.mrp ?? '', sale_price: l.sale_price ?? '',
                             sale_discount_pct: l.sale_discount_pct ?? '', [k]: v }, k)
    const n = (x) => (x === '' || x == null ? null : (Number.isNaN(+x) ? null : +x))
    return { mrp: n(row.mrp), sale_price: n(row.sale_price),
             sale_discount_pct: n(row.sale_discount_pct) }
  }
  const setLinePrice = async (l, k, v) => {
    try {
      await api.editLine(l.id, priceBody(l, k, v))
      await reload()
    } catch (e) { toast(e.detail || 'Could not set the price', 'err') }
  }
  // What one of these IS — piece, pair, dozen. It decides how the billed quantity
  // converts into stock and therefore how many QR labels the receipt produces, so
  // it is set here, on the line, before anything is posted. The choice is
  // remembered against the wording: say "pillow cover = PAIR" once and the next
  // invoice arrives already counted in pairs.
  const setLineUnit = async (l, code) => {
    try {
      const line = await api.editLine(l.id, { unit_type: code })
      await reload()
      toast(code
        ? `✓ Counted in ${code} — ${line.unit?.explain || ''}`
        : '✓ Back to automatic — the unit is read off the description', 'ok')
    } catch (e) { toast(e.detail || 'Could not set the unit', 'err') }
  }
  // MRP − Discount % = Sale price, in whichever direction was typed. Only the
  // three retail fields move each other; the purchase rate and the attributes
  // are left exactly as entered.
  const updSrow = (i, k, v) => setSrows(srows.map((r, j) =>
    (j === i ? recalcSale({ ...r, [k]: v }, k) : r)))
  // Fill a whole attribute column with one value.
  //
  // A bundle broken into six sizes is one garment six times: same brand, same
  // colour, same material, same everything except the size and the count. Typing
  // "Moss" into six rows is the kind of work that gets abandoned halfway, and
  // half-filled is worse than empty here — a variant carrying a colour and its
  // neighbour not carrying one are two different stock items to the server, which
  // compares the WHOLE attribute tuple.
  //
  // On a button rather than as you type, for the reason the invoice grid's buffer
  // columns are: a column that rewrote itself on every keystroke would overwrite
  // rows somebody had already set by hand, and "Mos" is a value on the way to
  // "Moss". Applied, each row still edits normally afterwards.
  //
  // Blank does nothing rather than clearing the column. Clearing nine rows is not
  // something to offer behind the same button as filling them.
  const applySfill = (k) => {
    const v = (sfill[k] || '').trim()
    if (!v) return
    setSrows(srows.map((r) => ({ ...r, [k]: v })))
  }
  const fillAttr = (k, label) => (
    <div className="fillbox text">
      <input size={1} list={k === 'category' ? 'essa-cats' : 'essa-opt-' + k}
        value={sfill[k] || ''} placeholder="all"
        title={`Set ${label} on every row of this breakdown`}
        onChange={(e) => setSfill({ ...sfill, [k]: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') applySfill(k) }} />
      <button className="btn fill-go" disabled={!(sfill[k] || '').trim()}
        onClick={() => applySfill(k)}
        aria-label={`Apply ${label} to every row of this breakdown`}
        title={`Apply ${sfill[k] || '…'} to all ${srows.length} row(s)`}>↓</button>
    </div>
  )
  const splitSum = srows.reduce((s, r) => s + (+r.qty || 0), 0)
  // Fill the grid from the run. Whatever the rows already share stays on them — a
  // bundle in six sizes is one garment six times, and only the size and the count
  // differ — so a colour and a category keyed once are not keyed again.
  const applySizeRun = (l) => {
    const { sizes, why } = parseSizeRun(runSpec)
    if (!sizes.length) { toast(why || 'Write the run as start-step-end — 28-2-38.', 'err'); return }
    const typed = srows.filter((r) => variantLabel(r) || r.qty)
    if (typed.length && !window.confirm(
      `Replace the ${typed.length} row(s) below with the ${sizes.length} sizes of ${runSpec}?\n\n`
      + sizes.join(', '))) return
    const shared = {}
    SPLIT_ATTRS.forEach(([k]) => {
      if (k === 'size') return
      const v = srows.map((r) => r[k]).find(Boolean)
      if (v) shared[k] = v
    })
    const cat = srows.map((r) => r.category).find(Boolean)
      || l.category || l.category_suggestion?.best
    const qtys = spreadQty(receivedQty(l), sizes.length)
    setSrows(sizes.map((size, i) => ({
      ...blankVariant(l.rate, cat), ...shared, size, qty: String(qtys[i]),
    })))
    // more sizes than pieces: the empty ones are left on the grid rather than
    // dropped, because which of them did not come is the operator's to say
    const empty = qtys.some((q) => !q)
    const even = qtys.every((q) => q === qtys[0])
    toast(empty
      ? `↳ ${sizes.length} sizes · only ${receivedQty(l)} received — set or remove the rows left at zero`
      : `✓ ${sizes.length} sizes · ${receivedQty(l)} spread ${even ? `${qtys[0]} each` : 'as evenly as it divides'}`,
      empty ? 'warn' : 'ok')
  }
  const saveSplit = async (l, rows) => {
    try {
      // Price is the LINE's, in one place, and the breakdown is a count of what
      // arrived. So the rows go up carrying no price at all: the server reads a
      // blank as "the line's" (see _create_product — the variant's own where it
      // has any, otherwise the line's). Stripping it rather than leaving what an
      // older breakdown saved is the point — a stale figure on a row would win
      // over the MRP someone has just corrected on the line, silently.
      const priced = rows.map((r) => {
        const { rate, mrp, sale_price: _sp, sale_discount_pct: _sd, ...rest } = r
        return rest
      })
      await api.setLineSplits(l.id, priced)
      setSplitFor(null); setSrows([])
      // open the line you have just broken down: the rows that appear are the
      // result of the edit, and folding them away would hide the answer
      setOpenSplits((m) => ({ ...m, [l.id]: rows.length > 0 }))
      await reload()
      toast(rows.length ? `✓ ${l.description || 'Line'} broken into ${rows.length} item(s)` : '✓ Breakdown cleared', 'ok')
    } catch (e) { toast(e.detail || 'Could not save the breakdown', 'err') }
  }
  const scanInto = async (l, splitId) => {
    const code = window.prompt('Scan or paste the QR code (or barcode / SKU) for this row:')
    if (!code) return
    try {
      await api.scanLineCode(l.id, code.trim(), splitId ?? null)
      await reload()
      toast('✓ Linked to that product', 'ok')
    } catch (e) { toast(e.detail || 'Code not recognised', 'err') }
  }
  // Set one column on EVERY line of this receipt.
  //
  // The same control the invoice grid carries, and wanted here for the same
  // reason: a bill of fifty-nine lines is very often one category, one unit and
  // one markup, and typing that fifty-nine times is the job that gets abandoned
  // in the middle. Half-set is worse than unset on this screen — an unmapped
  // category is a product that lands in Inventory for somebody to find later.
  //
  // Unlike the invoice grid, every edit here is a SERVER call: these lines are
  // saved rows, not a draft in the browser. So the whole column goes up as one
  // batch and the screen reloads once at the end, rather than fifty-nine times.
  // The button is dead while that is in flight, because a second press would
  // send the same batch again over rows the first is still changing.
  //
  // A price is not copied but RE-DERIVED per line: filling Discount % = 20 gives
  // each line its own sale price from its own MRP. Copying one line's sale price
  // onto a bill of different MRPs is the one thing this must not do.
  const [gfill, setGfill] = useState({})
  const [filling, setFilling] = useState('')
  const GFILL_PRICE = new Set(['mrp', 'sale_price', 'sale_discount_pct'])
  const gfillReady = (k) => (GFILL_PRICE.has(k)
    ? nf(gfill[k]) != null
    : !!String(gfill[k] ?? '').trim())
  const applyGfill = async (k) => {
    const lines = grn?.lines || []
    if (!gfillReady(k) || !lines.length || filling) return
    const v = GFILL_PRICE.has(k) ? nf(gfill[k]) : String(gfill[k]).trim()
    setFilling(k)
    try {
      await Promise.all(lines.map((l) => api.editLine(
        l.id, GFILL_PRICE.has(k) ? priceBody(l, k, v) : { [k]: v })))
      await reload()
      setGfill({ ...gfill, [k]: '' })
      toast(`✓ ${v} on all ${lines.length} line(s)`, 'ok')
    } catch (e) {
      await reload()          // some of them may have taken; show what is true
      toast(e.detail || 'Could not set that on every line', 'err')
    }
    setFilling('')
  }
  const gfillCell = (k, label) => {
    const busyHere = filling === k
    return (
      <div className="fillbox text">
        {k === 'unit_type' ? (
          <select value={gfill[k] ?? ''} title={`Set ${label} on every line`}
            onChange={(e) => setGfill({ ...gfill, [k]: e.target.value })}>
            <option value="">unit…</option>
            {(units.types || []).map((t) => (
              <option key={t.code} value={t.code}>
                {t.code}{t.pieces > 1 ? ` · ${t.pieces} pcs` : ''}</option>
            ))}
          </select>
        ) : (
          <input size={1} value={gfill[k] ?? ''} list={k === 'category' ? 'essa-cats' : undefined}
            inputMode={GFILL_PRICE.has(k) ? 'decimal' : undefined}
            placeholder={GFILL_PRICE.has(k) ? (k === 'sale_discount_pct' ? '%' : 'all') : 'all'}
            title={`Set ${label} on every line of this receipt`}
            onChange={(e) => setGfill({ ...gfill, [k]: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') applyGfill(k) }} />
        )}
        <button className="btn fill-go" disabled={!gfillReady(k) || !!filling}
          onClick={() => applyGfill(k)}
          aria-label={`Apply ${label} to every line of this receipt`}
          title={`Apply ${gfill[k] || '…'} to all ${(grn?.lines || []).length} line(s)`}>
          {busyHere ? '…' : '↓'}</button>
      </div>
    )
  }

  const unbalanced = (grn?.unbalanced_splits || []).length
  const shortage = grn?.shortages || { claimable_qty: 0, claimable_value: 0, open_qty: 0, open_value: 0 }
  const editable = !!grn && grn.status !== 'posted'
  // the sidebar's scope filter, with its counts — a chip that doesn't say how
  // many it holds makes someone click every one of them to find out
  const [scope, setScope] = useState('all')
  // Filtered, searched and paged by the server: a warehouse with years of
  // receipts is tens of thousands of GRNs, and sending them all to filter here
  // was 17 MB on every open of this screen.
  const qd = useDebounced(q)
  const grnPage = useServerPaged(({ limit, offset }) =>
    api.purchasesPage({ limit, offset, q: qd, status: scope }), `${scope}|${qd}`)
  const counts = {
    draft: grnPage.counts.draft || 0, posted: grnPage.counts.posted || 0,
    short: grnPage.counts.short || 0, all: grnPage.counts.all || 0,
  }
  const [pcat, setPcat] = useState({})             // in-progress category per line id
  // Which lines are showing their variant rows. A breakdown of a dozen sizes is
  // a dozen rows under one line, each as tall as its attribute list — enough to
  // push the next line off the screen. Folded away by default: the `split · N`
  // badge already says they are there, and this is what opens them for a look.
  const [openSplits, setOpenSplits] = useState({})
  const splitsShown = (l) => !!openSplits[l.id]
  const splitToggle = (l) => (l.splits.length ? (
    <button className="btn splittoggle" onClick={() => setOpenSplits((m) => ({ ...m, [l.id]: !m[l.id] }))}
      title={splitsShown(l) ? 'Fold the breakdown rows away'
        : `Show the ${l.splits.length} row(s) this line breaks into`}>
      {splitsShown(l) ? '▾' : '▸'} {l.splits.length}
    </button>
  ) : null)
  // in-progress price per line, keyed "lineId:field" — the same hold-then-save
  // the category cell uses, so a three-digit MRP is one PATCH and not three
  const [pprice, setPprice] = useState({})
  const priceCell = (l, k, tip) => {
    const key = `${l.id}:${k}`
    return (
      <td className={'num' + (tip ? ' calc' : '')} title={tip}>
        {editable ? (
          <input value={pprice[key] ?? (l[k] ?? '')} placeholder="—"
            onChange={(e) => setPprice((p) => ({ ...p, [key]: e.target.value }))}
            onBlur={() => {
              const v = pprice[key]
              setPprice((p) => { const c = { ...p }; delete c[key]; return c })
              if (v !== undefined && String(v) !== String(l[k] ?? '')) setLinePrice(l, k, v)
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }} />
        ) : (l[k] != null ? (k === 'sale_discount_pct' ? `${+l[k]}%` : money(l[k])) : '—')}
      </td>
    )
  }
  return (
    <div className="body">
      <Sidebar id="grn" label="GRNs">
        <div className="head"><h3>GRNs · {grnPage.total.toLocaleString('en-IN')}</h3></div>
        {counts.all > 0 && <>
          <SearchBox value={q} onChange={setQ} placeholder="Search supplier, invoice, GRN no, status…" />
          <div className="toolbar"><FilterChips value={scope} onChange={setScope} options={[
            ['draft', 'Draft', counts.draft, 'Receipts still being worked on'],
            ['posted', 'Posted', counts.posted, 'Receipts already in stock'],
            ['short', 'Short', counts.short, 'Receipts with goods billed but not delivered'],
            ['all', 'All', counts.all, 'Every receipt'],
          ]} /></div>
        </>}
        <div className="list">
          {grnPage.loading && grnPage.rows.length === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>Loading…</div>}
          {!grnPage.loading && counts.all === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>No GRNs yet. Open a confirmed document and click “Create GRN”.</div>}
          {!grnPage.loading && counts.all > 0 && grnPage.total === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>
            Nothing matches. {q ? 'Clear the search' : 'Try “All”'} to see the other {counts.all.toLocaleString('en-IN')} receipt(s).</div>}
          {grnPage.slice.map((p) => (
            <div key={p.id} className={'doc-row' + (selId === p.id ? ' sel' : '')} onClick={() => setSelId(p.id)}>
              <div className="t">{p.supplier_name || 'GRN #' + p.id}</div>
              <div className="m">
                <span className={'badge ' + (p.status === 'posted' ? 'confirmed' : 'uploaded')}>{p.status}</span>
                <span>#{p.invoice_number || '—'}</span>
                <span style={{ marginLeft: 'auto' }}>₹ {money(p.grand_total)}</span>
              </div>
              <div className="m"><span>{p.line_count} lines · {p.new_products} new product(s)</span></div>
              {p.short_qty > 0 && (
                <div className="m"><span style={{ color: 'var(--warn)' }}>
                  ⚠ {p.short_qty} short · ₹ {money(p.short_value)} to claim</span></div>
              )}
            </div>
          ))}
        </div>
        <Pager {...grnPage} noun="receipt" />
      </Sidebar>
      {grn ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="editor">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
              <h2 style={{ margin: 0 }}>{grn.supplier_name}</h2>
              <span className={'badge ' + (grn.status === 'posted' ? 'confirmed' : 'uploaded')}>{grn.status}</span>
            </div>
            <div className="kv" style={{ margin: '12px 0 20px', gridTemplateColumns: '130px 1fr 130px 1fr' }}>
              <div className="k">GRN No</div><div>{grn.grn_no || '—'}</div>
              <div className="k">Invoice</div><div>{grn.invoice_number} · {fmtDate(grn.invoice_date)}</div>
              <div className="k">Taxable</div><div>₹ {money(grn.taxable_total)}</div>
              <div className="k">Grand total</div><div>₹ {money(grn.grand_total)}</div>
              {/* Which building took the delivery in. Editable only while the GRN
                  is a draft: once posted the goods are standing on a shelf, and
                  relabelling the receipt would not move them. */}
              <div className="k" title="The warehouse this delivery was unloaded at. Its stock is what this GRN adds to.">Receive at</div>
              <div>{editable ? (
                <select value={grn.warehouse_id || ''} style={{ minWidth: 240 }}
                  onChange={(e) => setWarehouse(e.target.value)}>
                  <option value="">— default warehouse —</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}{w.code ? ` · ${w.code}` : ''}</option>
                  ))}
                </select>
              ) : (grn.warehouse_name || '—')}</div>
              {/* What that warehouse trades in, and therefore which category
                  master and attribute set this receipt works against. Shown
                  because it is the thing that silently decides how every line
                  below classifies. */}
              <div className="k" title="The business line this warehouse trades in. Its category master and attributes are what this GRN uses.">Trades in</div>
              <div>{(() => {
                const wh = warehouses.find((w) => w.id === grn.warehouse_id)
                if (!wh?.catalogue) return <span className="small">— default —</span>
                return <>{wh.catalogue}
                  {!cats.length && <span className="small" style={{ color: 'var(--danger)', marginLeft: 8 }}>
                    ⚠ no categories yet — add them under Masters → Catalogues</span>}</>
              })()}</div>
            </div>
            <Section id="grn.lines" title="Lines → inventory match"
              summary={`${grn.lines.length} line(s) · ${grn.new_products} new product(s)`}>
              {/* the category master, shared by the line cells and the breakdown editor */}
              <datalist id="essa-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
              <div className="tablewrap">
              <table className="items">
                <thead><tr><th>Product</th><th>QR code</th><th>Description</th>
                  <th style={{ minWidth: 150 }}>Category</th><th>HSN</th>
                  <th style={{ textAlign: 'right' }} title="What the supplier invoiced">Billed</th>
                  <th style={{ textAlign: 'right' }} title="What actually came out of the boxes">Received</th>
                  <th style={{ minWidth: 190 }} title="What one of these is — piece, pair, dozen — and what the billed quantity becomes because of it. This is what reaches stock, and how many QR labels print.">Unit → stock</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  {/* The retail trio, beside the purchase figures it is worked
                      out against. Typed once on the line; every variant of a
                      breakdown takes it from here. */}
                  <th style={{ textAlign: 'right', minWidth: 78 }}
                    title="What the supplier printed as the retail price">MRP</th>
                  <th style={{ textAlign: 'right', minWidth: 88 }} className="calc"
                    title="Off MRP. Type a sale price instead and this fills itself.">Discount % ƒ</th>
                  <th style={{ textAlign: 'right', minWidth: 88 }} className="calc"
                    title="MRP less the discount — e.g. 995 − 20% = 796. Type it and the discount % follows.">Sale price ƒ</th>
                  <th>Match</th>
                  {editable && <th></th>}</tr>
                  {/* One value down a whole column. Hand-written to line up with
                      the hand-written headings above it — the two must be kept in
                      step, and there are fourteen of them.

                      Only the five columns that are EDITABLE carry a box. The
                      rest are the supplier's own figures: the description, the
                      HSN, what was billed and at what rate are what the invoice
                      said, and this screen does not get to say otherwise. */}
                  {editable && (
                    <tr className="fillrow">
                      <th /><th /><th />
                      <th>{gfillCell('category', 'Category')}</th>
                      <th /><th /><th />
                      <th>{gfillCell('unit_type', 'Unit')}</th>
                      <th /><th />
                      <th>{gfillCell('mrp', 'MRP')}</th>
                      <th>{gfillCell('sale_discount_pct', 'Discount %')}</th>
                      <th>{gfillCell('sale_price', 'Sale price')}</th>
                      <th /><th />
                    </tr>
                  )}
                </thead>
                <tbody>
                  {grn.lines.map((l) => (
                    <React.Fragment key={l.id}>
                      <tr>
                        <td className="mono" style={{ color: 'var(--muted)' }}>{l.product_sku || '—'}</td>
                        <td className="mono">{l.qr_code || (l.splits.length ? '—' : <span style={{ color: 'var(--muted)' }}>on post</span>)}</td>
                        <td>{l.description}</td>
                        {/* category chosen here means the product is born mapped, instead of
                            landing "unmapped" for someone to fix product by product */}
                        <td>{editable ? (
                          <>
                            <input size={1} list="essa-cats" className="mono" style={{ fontSize: 11 }}
                              placeholder={l.category_suggestion?.best || 'unmapped'}
                              value={pcat[l.id] ?? l.category ?? ''}
                              onChange={(e) => setPcat({ ...pcat, [l.id]: e.target.value })}
                              onBlur={() => { const v = pcat[l.id]
                                if (v !== undefined && v !== (l.category ?? '')) setLineCat(l, v)
                                setPcat((p) => { const c = { ...p }; delete c[l.id]; return c }) }}
                              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }} />
                            {!l.category && l.category_suggestion?.best && (
                              <button className="catchip" title={l.category_suggestion.confident
                                ? 'Mapped from the description — click to lock it in'
                                : 'Best guess (not confident) — click to accept'}
                                onClick={() => setLineCat(l, l.category_suggestion.best)}>
                                use {l.category_suggestion.best}{l.category_suggestion.confident ? '' : ' ?'}
                              </button>
                            )}
                          </>
                        ) : (l.category || l.product_category
                          || <span className="badge review">unmapped</span>)}</td>
                        <td>{l.hsn}</td>
                        <td style={{ textAlign: 'right' }}>{l.qty}</td>
                        {/* the number that becomes stock. Equal to billed unless a
                            shortage was recorded at the dock — then the gap is the claim */}
                        <td style={{ textAlign: 'right',
                          color: l.has_shortage ? 'var(--warn)' : undefined,
                          fontWeight: l.has_shortage ? 700 : undefined }}
                          title={l.has_shortage
                            ? `${l.qty} billed, ${l.missing_qty || 0} short/damaged`
                              + (l.excess_qty ? `, ${l.excess_qty} extra` : '') + ` → ${l.received_qty} into stock`
                            : 'All of it arrived'}>
                          {l.received_qty != null ? l.received_qty : l.qty}</td>
                        {/* the conversion, shown before it is committed: a dozen
                            pillow covers is six pairs and six labels, and nobody
                            should find that out after posting */}
                        <td>
                          {editable ? (
                            <select className="mono" style={{ fontSize: 11, width: '100%' }}
                              value={l.unit_type || ''} disabled={l.unit?.locked}
                              title={l.unit?.why || ''}
                              onChange={(e) => setLineUnit(l, e.target.value)}>
                              <option value="">auto{l.unit ? ` · ${l.unit.unit_type}` : ''}</option>
                              {(units.types || []).map((t) => (
                                <option key={t.code} value={t.code}>
                                  {t.code}{t.pieces > 1 ? ` · ${t.pieces} pcs` : ''}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="mono" style={{ fontSize: 11 }}>
                              {l.unit?.unit_type || l.uom || 'PCS'}</span>
                          )}
                          {l.unit && (
                            <div className="small" title={l.unit.why}
                              style={{ marginTop: 3, color: l.unit.whole ? 'var(--muted)' : 'var(--warn)' }}>
                              {l.unit.explain}</div>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>{money(l.rate)}</td>
                        <td style={{ textAlign: 'right' }}>{money(l.amount)}</td>
                        {priceCell(l, 'mrp')}
                        {priceCell(l, 'sale_discount_pct', 'Off MRP. Type a sale price instead and this fills itself.')}
                        {priceCell(l, 'sale_price', 'MRP less the discount. Type it and the discount % follows.')}
                        <td>{l.splits.length
                          ? <span className={'badge ' + (l.split_balanced ? 'confirmed' : 'review')}
                              title={(l.split_balanced ? 'Breakdown adds up to what was received'
                                : `${l.split_remainder} of ${receivedQty(l)} received not yet broken down`)
                                + ' — this bundle line does not receive stock itself; the rows below do'}>
                              split · {l.splits.length}{l.split_balanced ? '' : ' ⚠'}</span>
                          : <span className={'badge ' + (l.is_new_product ? 'review' : 'confirmed')}>
                              {l.is_new_product ? 'new' : 'matched'}</span>}
                          {/* a posted GRN has no actions column, so the fold
                              control rides with the badge that counts them */}
                          {!editable && splitToggle(l)}</td>
                        {editable && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className={'btn' + (!l.splits.length && l.size_breakdown?.rows?.length ? ' primary' : '')}
                              style={{ padding: '2px 8px' }}
                              onClick={() => (splitFor === l.id ? setSplitFor(null) : openSplit(l))}
                              title={!l.splits.length && l.size_breakdown?.rows?.length
                                ? `The invoice already carries the mix — ${l.size_breakdown.rows
                                    .map((r) => `${r.size} → ${r.qty}`).join(', ')}`
                                  + `\nTotal ${l.size_breakdown.total} of ${receivedQty(l)} received.`
                                  + '\nClick to open it filled in, ready to check.'
                                : 'Break the bundle into what actually arrived — size, colour, material…'}>
                              {splitFor === l.id ? 'Close'
                                : l.splits.length ? 'Edit breakdown'
                                : l.size_breakdown?.rows?.length
                                  ? `Break down · ${l.size_breakdown.rows.length} sizes`
                                  : 'Break down'}</button>
                            <button className="btn" style={{ padding: '2px 8px', marginLeft: 4 }}
                              onClick={() => (shortFor === l.id ? setShortFor(null) : openShortage(l))}
                              title="Record what the supplier billed and the boxes didn't hold — it stays out of stock and becomes a claim">
                              {shortFor === l.id ? 'Close' : l.has_shortage ? '⚠ Shortage' : 'Shortage'}</button>
                            {splitToggle(l)}
                            {!l.splits.length && (
                              <button className="btn" style={{ padding: '2px 8px', marginLeft: 4 }} onClick={() => scanInto(l, null)}
                                title="Scan a QR code to pin this line to an existing product">⌗ QR</button>
                            )}
                          </td>
                        )}
                      </tr>

                      {/* what was billed and didn't arrive — never stock, always a claim */}
                      {shortFor !== l.id && (l.shortages || []).map((s) => (
                        <tr key={'sh' + s.id} style={{ background: 'var(--warn-bg)' }}>
                          <td className="mono" style={{ color: 'var(--muted)' }}>—</td>
                          <td className="mono" style={{ color: 'var(--muted)' }}>—</td>
                          <td style={{ paddingLeft: 22 }}>
                            <span style={{ color: s.kind === 'excess' ? 'var(--ok)' : 'var(--warn)' }}>⚠</span>
                            {' '}<b>{s.kind}</b>{s.variant ? <span> · {s.variant}</span> : null}
                            <span className="small" style={{ marginLeft: 8, color: 'var(--muted)' }}>
                              {s.reason || 'no reason given'}{s.recorded_by ? ` · by ${s.recorded_by}` : ''}</span>
                          </td>
                          <td colSpan={2} className="small" style={{ color: 'var(--muted)' }}>
                            {s.claimable ? 'never entered stock — claimable' : 'extra goods, taken into stock'}</td>
                          <td style={{ textAlign: 'right' }}>—</td>
                          <td style={{ textAlign: 'right', color: 'var(--warn)' }}>
                            {s.kind === 'excess' ? '+' : '−'}{s.qty}</td>
                          {/* a shortage is counted in the BILLED unit — it is a
                              fact about the invoice, not about the stock unit */}
                          <td className="small" style={{ color: 'var(--muted)' }}>
                            {s.kind === 'excess' ? 'into stock with the rest' : 'never converted'}</td>
                          <td style={{ textAlign: 'right' }}>{money(s.rate)}</td>
                          <td style={{ textAlign: 'right' }}>{s.claimable ? money(s.amount) : '—'}</td>
                          {/* goods that never arrived have no retail price to state */}
                          <td colSpan={3} />
                          {/* claiming or waiving is a decision for AFTER the goods are
                              booked in, so it lives on the posted GRN — while the GRN is
                              still a draft the shortage itself is what is being edited */}
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <span className={'badge ' + (s.status === 'claimed' ? 'confirmed' : 'review')}
                              title={s.status === 'claimed' ? 'A posted debit note has claimed this'
                                : s.status === 'waived' ? 'Accepted rather than claimed'
                                  : 'Not yet claimed from the supplier'}>{s.status}</span>
                            {!editable && s.claimable && s.status === 'waived' && (
                              <button className="btn" style={{ padding: '2px 8px', marginLeft: 5 }}
                                onClick={() => unwaive(s)} title="The supplier never did send it">Reopen</button>)}
                            {!editable && s.claimable && (s.status === 'open' || s.status === 'part-claimed') && (
                              <button className="btn" style={{ padding: '2px 8px', marginLeft: 5 }}
                                onClick={() => waive(s)} title="Accept it rather than raise a debit note">Waive</button>)}
                          </td>
                          {editable && <td />}
                        </tr>
                      ))}

                      {/* saved variant rows — one product each once posted.
                          Folded away unless this line's toggle is open. */}
                      {splitFor !== l.id && splitsShown(l) && l.splits.map((s) => (
                        <tr key={s.id} style={{ background: 'var(--panel-2)' }}>
                          <td className="mono" style={{ color: 'var(--muted)' }}>{s.product_sku || '—'}</td>
                          <td className="mono">{s.product_barcode || s.code || <span style={{ color: 'var(--muted)' }}>on post</span>}</td>
                          {/* the prices used to be repeated here as chips; they
                              have columns of their own now, beside the line's */}
                          <td style={{ paddingLeft: 22 }}>↳ <b>{s.label}</b></td>
                          <td className="mono" style={{ fontSize: 11 }}>{s.category || l.category
                            || <span style={{ color: 'var(--muted)' }}>auto</span>}</td>
                          <td>{l.hsn}</td>
                          {/* a variant row IS a received quantity — the supplier never
                              billed it separately, so there is nothing under "Billed" */}
                          <td style={{ textAlign: 'right', color: 'var(--muted)' }}>—</td>
                          <td style={{ textAlign: 'right' }}>{s.qty}</td>
                          <td className="small" title={s.unit?.why}
                            style={{ color: s.unit && !s.unit.whole ? 'var(--warn)' : 'var(--muted)' }}>
                            {s.unit?.explain || '—'}</td>
                          <td style={{ textAlign: 'right' }}>{money(s.rate)}</td>
                          <td style={{ textAlign: 'right' }}>{money(s.amount)}</td>
                          {/* a variant prices off its line unless it was saved
                              with one of its own — the same fallback the server
                              applies when it creates the product */}
                          {['mrp', 'sale_discount_pct', 'sale_price'].map((k) => {
                            const own = s[k] != null
                            const v = own ? s[k] : l[k]
                            return (
                              <td key={k} className="num" style={{ color: own ? undefined : 'var(--muted)' }}
                                title={own ? 'Set on this variant' : 'From the line'}>
                                {v == null ? '—' : k === 'sale_discount_pct' ? `${+v}%` : money(v)}</td>
                            )
                          })}
                          <td>{s.product_id
                            ? <span className="badge confirmed">{s.is_new_product ? 'created' : 'matched'}</span>
                            : <span className="badge review">new</span>}</td>
                          {editable && <td>{!s.product_id && (
                            <button className="btn" style={{ padding: '2px 8px' }} onClick={() => scanInto(l, s.id)}
                              title="Scan the QR of an existing product for this variant">⌗ QR</button>)}</td>}
                        </tr>
                      ))}

                      {/* shortage editor — what was billed and wasn't in the box */}
                      {shortFor === l.id && (() => {
                        const missing = round3(shrows.filter((r) => r.kind !== 'excess')
                          .reduce((n, r) => n + (+r.qty || 0), 0))
                        const extra = round3(shrows.filter((r) => r.kind === 'excess')
                          .reduce((n, r) => n + (+r.qty || 0), 0))
                        const recv = round3((+l.qty || 0) - missing + extra)
                        const over = missing > (+l.qty || 0) + 0.001
                        return (
                          <tr>
                            <td colSpan={editable ? 15 : 14} style={{ background: 'var(--warn-bg)', padding: '12px 14px' }}>
                              <div className="rowedit-bar"
                                style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
                                <b>Shortage on “{l.description}”</b>
                                <span className="small" style={{ color: over ? 'var(--danger)' : missing ? 'var(--warn)' : 'var(--muted)' }}>
                                  {over ? `${missing} short of only ${l.qty} billed — more than the invoice`
                                    : <>Into stock <b>{recv}</b> of {l.qty} billed
                                      {missing ? ` · ${missing} short — ₹ ${money(missing * (+l.rate || 0))} to claim` : ''}
                                      {extra ? ` · ${extra} extra` : ''}</>}
                                </span>
                              </div>
                              <div className="tablewrap">
                              <table className="items entry" style={{ margin: 0 }}>
                                <thead><tr>
                                  <th style={{ minWidth: 230 }}>What happened</th>
                                  <th style={{ minWidth: 90, textAlign: 'right' }}>Qty</th>
                                  <th style={{ minWidth: 170 }}>Reason</th>
                                  <th style={{ minWidth: 150 }}>Which ones</th>
                                  <th style={{ minWidth: 180 }}>Note</th>
                                  <th style={{ minWidth: 90, textAlign: 'right' }}>Value</th>
                                  <th></th></tr></thead>
                                <tbody>{shrows.map((r, i) => (
                                  <tr key={i}>
                                    <td>
                                      <select value={r.kind} onChange={(e) => updShrow(i, 'kind', e.target.value)}>
                                        {SHORT_KINDS.map(([k, label, hint]) =>
                                          <option key={k} value={k}>{label} — {hint}</option>)}
                                      </select>
                                    </td>
                                    <td className="num"><input value={r.qty} placeholder="0"
                                      onChange={(e) => updShrow(i, 'qty', e.target.value)} /></td>
                                    <td><input list="essa-short-reasons" value={r.reason} placeholder="why?"
                                      onChange={(e) => updShrow(i, 'reason', e.target.value)} /></td>
                                    <td><input value={r.variant} placeholder="e.g. S / White — if known"
                                      onChange={(e) => updShrow(i, 'variant', e.target.value)} /></td>
                                    <td><input value={r.note} placeholder="anything the office should see"
                                      onChange={(e) => updShrow(i, 'note', e.target.value)} /></td>
                                    <td className="num" style={{ color: 'var(--muted)' }}>
                                      {r.kind === 'excess' ? '—' : money((+r.qty || 0) * (+l.rate || 0))}</td>
                                    <td><button className="btn" style={{ padding: '2px 7px' }} title="Remove this row"
                                      onClick={() => setShrows(shrows.filter((_, j) => j !== i))}>×</button></td>
                                  </tr>
                                ))}</tbody>
                              </table>
                              </div>
                              <datalist id="essa-short-reasons">
                                {(shortOpts.reasons || []).map((v) => <option key={v} value={v} />)}
                              </datalist>
                              <div className="rowedit-bar"
                                style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                                <button className="btn" onClick={() => setShrows([...shrows, blankShortage()])}>+ add row</button>
                                {l.has_shortage && (
                                  <button className="btn" onClick={() => saveShortage(l, [])}
                                    title="No shortage after all — the whole billed quantity is expected in stock again">
                                    Clear shortage</button>
                                )}
                                <button className="btn" onClick={() => { setShortFor(null); setShrows([]) }}>Cancel</button>
                                <button className="btn primary" disabled={over}
                                  onClick={() => saveShortage(l, shrows.filter((r) => +r.qty > 0))}>Save shortage</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })()}

                      {/* attribute-breakdown editor */}
                      {splitFor === l.id && (
                        <tr>
                          <td colSpan={editable ? 15 : 14} style={{ background: 'var(--panel-2)', padding: '12px 14px' }}>
                            <div className="rowedit-bar"
                              style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                              <b>Breakdown of “{l.description}”</b>
                              {/* the target is what ARRIVED — once a shortage is recorded the
                                  rows only have to reach that, which is the point of recording it */}
                              {/* the running check. It is the breakdown, not the
                                  billed bundle, that decides what exists — so it
                                  has to account for every piece before any of
                                  them gets a SKU and a QR */}
                              {(() => {
                                const left = round3(receivedQty(l) - splitSum)
                                const ok = sameQty(splitSum, receivedQty(l))
                                return (
                                  <span className="small" style={{ color: ok ? 'var(--ok)' : 'var(--warn)', fontWeight: 600 }}>
                                    {splitSum} of {receivedQty(l)} assigned
                                    {l.has_shortage ? ` (${l.qty} billed, ${l.missing_qty} short)` : ''}
                                    {ok ? ' ✓'
                                      : left > 0
                                        ? ` · ${left} piece${left === 1 ? '' : 's'} remaining. Please complete the size breakdown before posting to inventory.`
                                        : ` · ${-left} piece${left === -1 ? '' : 's'} more than were received — remove them before posting.`}
                                  </span>
                                )
                              })()}
                              {/* the moment someone notices the sizes don't add up: "the rest
                                  never came" is an answer, and it must be easier than inventing
                                  the difference to make the total work */}
                              {!l.has_shortage && splitSum > 0 && splitSum < receivedQty(l) && (
                                <button className="catchip" style={{ color: 'var(--warn)' }}
                                  title="Record the difference as short — it stays out of stock and becomes a claim"
                                  onClick={() => openShortage(l, round3(receivedQty(l) - splitSum))}>
                                  {round3(receivedQty(l) - splitSum)} not in the box?
                                </button>
                              )}
                            </div>
                            {/* The run, typed once. Six sizes and a count against
                                each of them is what the breakdown of an ordinary
                                garment bundle IS, and "28-2-38" is the whole of it —
                                so it is read straight into the grid below and the
                                pieces that arrived are spread over it. Everything
                                stays editable afterwards: this saves the typing, it
                                does not decide anything. */}
                            {(() => {
                              const run = parseSizeRun(runSpec)
                              const spread = run.sizes.length ? spreadQty(receivedQty(l), run.sizes.length) : []
                              const even = spread.length && spread.every((q) => q === spread[0])
                              const listed = run.sizes.length > 10
                                ? run.sizes.slice(0, 9).join(', ') + `, … ${run.sizes[run.sizes.length - 1]}`
                                : run.sizes.join(', ')
                              return (
                                <div className="rowedit-bar sizerun">
                                  <span className="runlabel">Size run</span>
                                  <input value={runSpec} placeholder="28-2-38"
                                    onChange={(e) => setRunSpec(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') applySizeRun(l) }}
                                    title={'Start – step – end, the way the packing slip writes it.\n'
                                      + '28-2-38 is 28, 30, 32, 34, 36, 38 — and 28-38 steps by one.'} />
                                  <button className="btn" disabled={!run.sizes.length}
                                    onClick={() => applySizeRun(l)}
                                    title={run.sizes.length
                                      ? `Fill the grid with ${run.sizes.length} sizes and spread the ${receivedQty(l)} received over them`
                                      : 'Write the run as start-step-end first'}>Generate sizes</button>
                                  <span className={'why' + (run.why ? ' bad' : '')}>
                                    {run.why || (run.sizes.length
                                      ? <><b>{listed}</b>{` — ${run.sizes.length} sizes, ${receivedQty(l)} received, `}
                                        {even ? `${spread[0]} each` : `${Math.min(...spread)}–${Math.max(...spread)} each`}</>
                                      : 'Start–step–end. Generates the sizes and spreads what arrived evenly '
                                        + 'over them; every row stays editable afterwards.')}
                                  </span>
                                </div>
                              )
                            })()}
                            <div className="tablewrap">
                              <table className="items entry" style={{ margin: 0, minWidth: 1250 }}>
                                <thead>
                                  <tr>
                                  {SPLIT_ATTRS.map(([k, label, w]) => <th key={k} style={{ minWidth: w }}>{label}</th>)}
                                  <th style={{ minWidth: 150 }}>Category</th>
                                  {SPLIT_QTY.map(([k, label, w]) =>
                                    <th key={k} style={{ minWidth: w, textAlign: 'right' }}>{label}</th>)}
                                  <th></th></tr>
                                  {/* Under the headings, not in a toolbar above the
                                      table: the control belongs to the column it
                                      fills, and aligned under it there is nothing
                                      to explain about which is which. Same device,
                                      and the same reasoning, as the invoice grid's
                                      buffer columns.

                                      Qty has none. It is the one figure that is
                                      genuinely per row — it is the whole point of
                                      the breakdown — and the size run above already
                                      spreads it. */}
                                  <tr className="fillrow">
                                    {SPLIT_ATTRS.map(([k, label]) => <th key={k}>{fillAttr(k, label)}</th>)}
                                    <th>{fillAttr('category', 'Category')}</th>
                                    {SPLIT_QTY.map(([k]) => <th key={k}></th>)}
                                    <th></th>
                                  </tr>
                                </thead>
                                <tbody>{srows.map((r, i) => (
                                  <tr key={i}>
                                    {SPLIT_ATTRS.map(([k]) => (
                                      <td key={k}><input size={1} list={'essa-opt-' + k} value={r[k]}
                                        onChange={(e) => updSrow(i, k, e.target.value)} /></td>
                                    ))}
                                    <td><input size={1} list="essa-cats" className="mono" style={{ fontSize: 11 }}
                                      placeholder={l.category || 'auto'} value={r.category}
                                      onChange={(e) => updSrow(i, 'category', e.target.value)} /></td>
                                    {SPLIT_QTY.map(([k]) => (
                                      <td key={k} className="num">
                                        <input size={1} value={r[k]}
                                          onChange={(e) => updSrow(i, k, e.target.value)} /></td>
                                    ))}
                                    <td><button className="btn" style={{ padding: '2px 7px' }} title="Remove this row"
                                      onClick={() => setSrows(srows.filter((_, j) => j !== i))}>×</button></td>
                                  </tr>
                                ))}</tbody>
                              </table>
                            </div>
                            {/* the phone app's option lists, so both ends use one vocabulary */}
                            {SPLIT_ATTRS.map(([k]) => (
                              <datalist key={k} id={'essa-opt-' + k}>
                                {(opts[k] || []).map((v) => <option key={v} value={v} />)}
                              </datalist>
                            ))}
                            <div className="rowedit-bar"
                              style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                              {/* a new row joins the price the bar above already
                                  set — otherwise adding one would drop the whole
                                  breakdown to "mixed" and blank the bar */}
                              <button className="btn" onClick={() => {
                                const last = srows[srows.length - 1]
                                const row = blankVariant(l.rate,
                                  last?.category || l.category || l.category_suggestion?.best)
                                setSrows([...srows, last
                                  ? { ...row, rate: last.rate, mrp: last.mrp,
                                      sale_price: last.sale_price,
                                      sale_discount_pct: last.sale_discount_pct }
                                  : row])
                              }}>+ add row</button>
                              <button className="btn" title="Copy the last row's attributes into a new row — change just what differs"
                                disabled={!srows.length}
                                onClick={() => setSrows([...srows, { ...srows[srows.length - 1], qty: '' }])}>⧉ duplicate last</button>
                              {l.splits.length > 0 && (
                                <button className="btn" onClick={() => saveSplit(l, [])}
                                  title="Remove the breakdown — the line posts as one product again">Clear breakdown</button>
                              )}
                              <button className="btn" onClick={() => { setSplitFor(null); setSrows([]) }}>Cancel</button>
                              <button className="btn primary"
                                onClick={() => saveSplit(l, srows.filter((r) => variantLabel(r) || r.qty))}>Save breakdown</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="items-foot"><span>{grn.lines.length} lines</span>
                {shortage.claimable_qty > 0 && (
                  <span style={{ color: 'var(--warn)' }}>
                    ⚠ {shortage.claimable_qty} short or damaged · ₹ {money(shortage.claimable_value)} to claim
                    {shortage.open_qty > 0 && shortage.open_qty !== shortage.claimable_qty
                      ? ` (₹ ${money(shortage.open_value)} unclaimed)` : ''}
                  </span>
                )}
                <span>{grn.new_products} will be created as new products</span></div>
            </Section>
          </div>
          <div className="actionbar">
            <span className="small">{grn.status === 'posted'
              ? shortage.open_qty > 0
                ? `Posted. ⚠ ${shortage.open_qty} unit(s) short — ₹ ${money(shortage.open_value)} still to claim. Raise it in Returns, or waive it on the row.`
                : 'Posted — stock has been updated in Inventory. Unpost to correct it, then post again.'
              : unbalanced
                ? `⚠ ${unbalanced} line(s): please complete the size breakdown before posting to inventory — every piece has to be placed, or recorded as a shortage if it never arrived.`
                : shortage.claimable_qty > 0
                  ? `Posting takes in ${grn.lines.reduce((n, l) => n + receivedQty(l), 0)} unit(s). The ${shortage.claimable_qty} short stay out of stock and become a claim against the supplier.`
                  : 'Posting creates new products, adds inward stock, and updates weighted-average cost.'}</span>
            <div className="spacer" />
            {grn.status === 'posted'
              ? <button className="btn" onClick={unpost}
                  title="Reverse the stock this GRN added and put it back to draft">↺ Unpost</button>
              : <button className="btn" onClick={removeGrn}
                  title="Delete this draft GRN — the invoice document stays">Delete GRN</button>}
            <button className="btn primary" disabled={grn.status === 'posted' || unbalanced > 0} onClick={post}>
              {grn.status === 'posted' ? 'Posted ✓' : 'Post GRN to Inventory'}</button>
          </div>
        </div>
      ) : <div className="empty">Select a GRN, or create one from a confirmed document.</div>}
    </div>
  )
}

// ---------- inventory (master corrections + stock adjust) ----------
// Shown read-only on the product panel: these are keyed on the GRN breakdown and
// corrected in the phone app, never re-typed here.
const PRODUCT_ATTRS = [
  ['brand', 'Brand'], ['size', 'Size'], ['color', 'Colour'], ['material', 'Material'],
  ['pattern', 'Pattern'], ['fit', 'Fit'], ['style', 'Style'], ['sleeve', 'Sleeve'],
  ['product_type', 'Type'], ['design_no', 'Design No'],
  ['sale_price', 'Sale price'], ['sale_discount_pct', 'Discount %'],
]
function Inventory({ toast }) {
  const [summary, setSummary] = useState(null)
  const [products, setProducts] = useState([])
  const [detail, setDetail] = useState(null)
  const [adjQty, setAdjQty] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [q, setQ] = useState('')
  // The list is what this warehouse holds now; a search of 3+ characters asks
  // the server across every SKU (a real catalogue is far too large to send
  // whole), and clearing it brings the held list back.
  const searched = useRef(false)
  const load = useCallback(() => {
    api.inventorySummary().then(setSummary); api.listProducts({ held: 1 }).then(setProducts)
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const term = q.trim()
    if (term.length < 3) {
      if (searched.current) { searched.current = false; api.listProducts({ held: 1 }).then(setProducts).catch(() => {}) }
      return
    }
    const t = setTimeout(() => {
      searched.current = true
      api.listProducts({ q: term, limit: 500 }).then(setProducts).catch(() => {})
    }, 400)
    return () => clearTimeout(t)
  }, [q])
  const open = (id) => api.getProduct(id).then((d) => {
    setDetail(d); setAdjQty(''); setAdjNote('')
  })
  const doAdjust = async () => {
    if (adjQty === '') return
    await api.adjustStock(detail.id, +adjQty, adjNote || 'manual adjustment')
    toast('✓ Stock adjusted', 'ok'); await open(detail.id); load()
  }
  const genBarcode = async () => {
    try {
      const r = await api.generateBarcode(detail.id)
      toast(r.identifiers_generated?.length ? `✓ Generated ${r.identifiers_generated.join(' + ')}` : '✓ Already had its SKU', 'ok')
      await open(detail.id); load()
    } catch (err) { toast(err.detail || 'Could not generate the code', 'err') }
  }
  // --- per-piece codes: clicking a quantity opens the individual garments ---
  const [units, setUnits] = useState(null)      // {product, units[], serialisable, reason}
  const [zoom, setZoom] = useState(null)        // one piece, viewed large
  const openUnits = async (p) => {
    try { setUnits(await api.productUnits(p.id)); setZoom(null) }
    catch (err) {
      // a 404 is the recognisable case: the server was started before piece codes
      // existed and is serving this (newer) page off disk. Say that, rather than
      // leaving someone to guess at "could not load".
      toast(err.status === 404
        ? 'This server was started before piece codes existed — restart the ESSA server and reload.'
        : (err.detail || 'Could not load the piece codes'), 'err')
    }
  }
  const reloadUnits = async () => { if (units) setUnits(await api.productUnits(units.product.id)) }
  // up to 500 piece codes under one SKU — see units.MAX_PER_RECEIPT
  const unitPage = usePaged(units?.units || [], 100)
  // printing is recorded, so the sheet has to be reloaded to show the new counts
  const printUnits = (ids) => {
    if (units?.can_print === false) { toast(units.print_block, 'err'); return }
    window.open(api.unitLabelsUrl(units.product.id, ids), '_blank')
    setTimeout(reloadUnits, 1200)
  }
  const printOne = (u) => { window.open(api.unitLabelUrl(u.id), '_blank'); setTimeout(reloadUnits, 1200) }
  const makeUnits = async () => {
    try {
      const r = await api.generateUnits(units.product.id)
      toast(`✓ ${r.created} piece code(s) created`, 'ok')
      await reloadUnits(); load()
    } catch (err) { toast(err.detail || 'Could not create piece codes', 'err') }
  }

  const [scan, setScan] = useState('')
  const lookup = async (code) => {
    const c = (code ?? scan).trim(); if (!c) return
    try { const p = await api.lookupByCode(c); await open(p.id); setScan(''); toast(`✓ ${p.sku} · ${p.name || p.description}`, 'ok') }
    catch (err) { toast(err.detail || `No product for “${c}”`, 'err') }
  }
  // --- inventory integrity: what is stock, and what only looks like it ---
  const [scanRep, setScanRep] = useState(null)
  const rescan = useCallback(() => api.integrityScan().then(setScanRep).catch(() => {}), [])
  useEffect(() => { rescan() }, [rescan])
  const repairInventory = async () => {
    let plan
    try { plan = await api.integrityRepair(true) }
    catch (e) { toast(e.detail || 'Could not check what needs repairing', 'err'); return }
    const w = plan.would_remove
    const lines = [
      w.products.length && `• ${w.products.length} product(s): ${w.products.slice(0, 6).join(', ')}${w.products.length > 6 ? '…' : ''}`,
      w.units.length && `• ${w.units.length} QR / piece code(s)`,
      w.bundles.length && `• ${w.bundles.length} carton label(s): ${w.bundles.slice(0, 6).join(', ')}${w.bundles.length > 6 ? '…' : ''}`,
    ].filter(Boolean).join('\n')
    if (!window.confirm(
      'Remove these records permanently?\n\n' + lines
      + '\n\nEvery one of them traces back to no GRN and carries no stock movement, so'
      + ' nothing that a receipt created is affected. Products kept at zero stock after an'
      + ' unpost are NOT touched — they hold warehouse detailing.\n\nThis cannot be undone.')) return
    try {
      const r = await api.integrityRepair(false)
      toast(`✓ Removed ${r.counts.units} piece code(s), ${r.counts.bundles} carton(s), ${r.counts.products} product(s)`, 'ok')
      await rescan(); load()
    } catch (e) { toast(e.detail || 'Repair failed', 'err') }
  }

  const [labelScope, setLabelScope] = useState('detailed')
  const detailedCount = products.filter((p) => p.detailed).length
  const labelCount = labelScope === 'detailed' ? detailedCount : products.length
  // --- the three controls: search (q), scope chips, and the filter panel ---
  const [stockScope, setStockScope] = useState('all')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [catFilter, setCatFilter] = useState('')
  const [supFilter, setSupFilter] = useState('')
  const activeFilters = [catFilter, supFilter].filter(Boolean).length
  const inStockScope = (p) => stockScope === 'all' ? true
    : stockScope === 'detailed' ? !!p.detailed
      : stockScope === 'pending' ? !p.detailed
        : stockScope === 'instock' ? p.stock_qty > 0 : !(p.stock_qty > 0)
  const visible = products.filter(inStockScope)
    .filter((p) => !catFilter || (p.category || '').toLowerCase().includes(catFilter.toLowerCase()))
    .filter((p) => !supFilter || (p.supplier_name || '').toLowerCase().includes(supFilter.toLowerCase()))
    .filter((p) => matches(p, q, ['sku', 'barcode', 'description', 'hsn', 'supplier_name', 'category', 'size']))
  // inventory gains a row per variant received, so it outgrows a screen quickly
  const invPage = usePaged(visible, 50)
  const printLabels = () => {
    if (!products.length) { toast('No products yet — post a GRN to create products first.', 'err'); return }
    if (labelCount === 0) { toast('No detailed products yet. Detail products first, or switch to “All products”.', 'err'); return }
    window.open(api.labelsUrl(null, labelScope), '_blank')
  }
  return (
    <div className="screen">
      {/* the last full-width module without a title band: it opened straight
          onto its stat tiles, so moving here from the dashboard dropped the
          white header bar and the gold rule the other screens all keep */}
      <div className="pagehead">
        <h2>Inventory</h2>
        <div className="pagesub small">
          Stock on hand, labels and per-piece codes
        </div>
      </div>
      <div className="screenbody">
        <div style={{ display: 'flex', gap: 14, marginBottom: 20 }}>
          <Stat label="Products" value={summary?.product_count ?? '—'} accent="count" />
          <Stat label="Units in stock" value={summary ? summary.total_units.toLocaleString('en-IN') : '—'} accent="stock" />
          <Stat label="Stock value (avg cost)" value={summary ? '₹ ' + money(summary.total_stock_value) : '—'} accent="money" />
          <Stat label="Detailed (mobile)" value={summary ? `${summary.detailed ?? 0} / ${summary.product_count}` : '—'} accent="count" />
        </div>
        <div className="toolbar">
          <SearchBox value={q} onChange={setQ} placeholder="Search SKU, barcode, description, HSN, supplier…"
            style={{ width: 340 }} />
          <FilterChips value={stockScope} onChange={setStockScope} options={[
            ['all', 'All', products.length, 'Every product in stock'],
            ['detailed', 'Detailed', detailedCount, 'Inspected and recorded on the phone'],
            ['pending', 'To detail', products.length - detailedCount, 'Still waiting to be looked at'],
            ['instock', 'In stock', products.filter((p) => p.stock_qty > 0).length, 'Quantity above zero'],
            ['zero', 'Zero', products.filter((p) => !(p.stock_qty > 0)).length, 'Nothing on hand'],
          ]} />
          <FilterButton open={filtersOpen} onToggle={() => setFiltersOpen((o) => !o)} active={activeFilters} />
          <div className="spacer" />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input value={scan} onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') lookup() }}
              title="Scan a QR, piece label or barcode to jump straight to that product"
              placeholder="⌗ Scan a code…" style={{ width: 190 }} />
            <button className="btn" onClick={() => lookup()} title="Open the scanned product">Fetch</button>
            <button className="btn" onClick={printLabels}
              title={`Print a label sheet for ${labelCount} product(s) — set which in Filters`}>
              🖨 Labels ({labelCount})</button>
          </div>
        </div>
        <FilterPanel open={filtersOpen} active={activeFilters}
          onClear={() => { setCatFilter(''); setSupFilter(''); setLabelScope('detailed') }}>
          <div className="field" style={{ width: 190 }}><label>Category</label>
            <input list="inv-cats" value={catFilter} placeholder="any category"
              onChange={(e) => setCatFilter(e.target.value)} />
            <datalist id="inv-cats">{[...new Set(products.map((p) => p.category).filter(Boolean))].map((c) => <option key={c} value={c} />)}</datalist>
          </div>
          <div className="field" style={{ width: 190 }}><label>Supplier</label>
            <input list="inv-sups" value={supFilter} placeholder="any supplier"
              onChange={(e) => setSupFilter(e.target.value)} />
            <datalist id="inv-sups">{[...new Set(products.map((p) => p.supplier_name).filter(Boolean))].map((s) => <option key={s} value={s} />)}</datalist>
          </div>
          <div className="field" style={{ width: 190 }}><label>Label sheet covers</label>
            <select value={labelScope} onChange={(e) => setLabelScope(e.target.value)}
              title="Which products the Labels button prints">
              <option value="detailed">Detailed only ({detailedCount})</option>
              <option value="all">All products ({products.length})</option>
            </select>
          </div>
        </FilterPanel>

        {/* Inventory Repair. Only shown when there is something to say — a clean
            database should not carry a permanent maintenance banner. */}
        {scanRep && !scanRep.clean && (
          <div className="section" style={{ borderColor: 'var(--danger)', marginBottom: 14 }}>
            <h4 style={{ color: 'var(--danger)' }}>⚠ Inventory mismatch detected</h4>
            <table className="items" style={{ margin: 0 }}>
              <thead><tr><th>What</th><th style={{ textAlign: 'right' }}>Count</th><th>Meaning</th></tr></thead>
              <tbody>
                {[
                  ['Orphan products', scanRep.counts.orphan_products,
                    'no GRN line, no breakdown row, no stock movement — nothing that could have created them survives'],
                  ['Orphan QR / piece codes', scanRep.counts.orphan_units,
                    'piece codes with no posted receipt behind them'],
                  ['Orphan cartons', scanRep.counts.orphan_bundles,
                    'bundle labels for a receipt that no longer exists'],
                  ['SKUs with a QR count mismatch', scanRep.counts.unit_mismatches,
                    'live piece codes don’t equal what the GRNs received'],
                ].filter(([, n]) => n > 0).map(([what, n, why]) => (
                  <tr key={what}><td><b>{what}</b></td>
                    <td style={{ textAlign: 'right' }}>{n}</td>
                    <td className="small" style={{ color: 'var(--muted)' }}>{why}</td></tr>
                ))}
                {scanRep.counts.unposted_products > 0 && (
                  <tr><td>Kept after unpost</td>
                    <td style={{ textAlign: 'right' }}>{scanRep.counts.unposted_products}</td>
                    <td className="small" style={{ color: 'var(--muted)' }}>
                      excluded from stock but <b>never deleted</b> — these hold detailing recorded
                      by hand in the warehouse</td></tr>
                )}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <span className="small" style={{ color: 'var(--muted)' }}>
                {scanRep.counts.removable > 0
                  ? `${scanRep.counts.removable} record(s) can be removed. Nothing traceable to a GRN is touched.`
                  : 'Nothing is safe to delete automatically — the counts above need a human decision.'}
              </span>
              <div style={{ flex: 1 }} />
              <button className="btn" onClick={() => api.integrityScan().then(setScanRep)}>Re-scan</button>
              <button className="btn" disabled={!scanRep.counts.removable} onClick={repairInventory}
                title="Delete only records that trace back to no GRN at all">
                Repair ({scanRep.counts.removable})</button>
            </div>
          </div>
        )}
        <div className="tablewrap">
        <table className="items">
          <thead><tr><th style={{ width: 46 }}>QR</th><th>SKU</th><th>Product</th><th>Size</th><th>Category</th><th>HSN</th><th>Supplier</th>
            <th style={{ textAlign: 'right' }}>Stock</th><th style={{ textAlign: 'right' }}>Avg cost</th>
            <th style={{ textAlign: 'right' }}>Value</th></tr></thead>
          <tbody>
            {invPage.slice.map((p) => (
              <tr key={p.id} style={{ cursor: 'pointer', background: detail?.id === p.id ? 'var(--panel-2)' : '' }} onClick={() => open(p.id)}>
                {/* The real QR, small enough for a list and still scannable off the
                    screen. `lazy` keeps a long list from firing a request per row. */}
                <td style={{ padding: 2 }}>
                  <img src={api.qrSvgUrl(p.id, 2)} alt={`QR ${p.sku}`} loading="lazy"
                    title={`Scan or click to open ${p.sku}`}
                    style={{ width: 34, height: 34, display: 'block', background: '#fff', borderRadius: 3, padding: 1 }} />
                </td>
                <td className="mono" style={{ color: 'var(--muted)' }}>{p.sku}</td>
                {/* What it IS leads; what the supplier's bill called it sits
                    under it. "TISSOT Lycra" is a mill's wording and names
                    nothing anyone picks off a shelf — see display_name. */}
                <td>
                  <div>{p.name || p.description}</div>
                  {p.description && p.description !== (p.name || '') && (
                    <div className="small" style={{ color: 'var(--muted)' }}
                      title="What the supplier's invoice called it">{p.description}</div>
                  )}
                </td>
                {/* sizes split off one bundle line share a description — the size is what tells them apart */}
                <td>{p.size || '—'}</td>
                <td className="mono" style={{ fontSize: 11 }}>{p.category
                  || <span className="badge review" title="No confident category match — open the product to pick one">unmapped</span>}</td>
                <td>{p.hsn}</td><td>{p.supplier_name || '—'}</td>
                {/* the quantity is a way in, not just a number: 8 pcs means eight
                    individually coded garments, and this is where you see them */}
                <td style={{ textAlign: 'right' }}>
                  {/* Negative stock is a real condition (more dispatched than held)
                      and it must look wrong, not sit in the column as an ordinary
                      figure — a minus sign alone is easy to read straight past. */}
                  <button className="qtylink" onClick={(e) => { e.stopPropagation(); openUnits(p) }}
                    style={p.stock_qty < 0 ? { color: 'var(--danger)', fontWeight: 700 } : undefined}
                    title={p.stock_qty < 0
                      ? `Negative stock — more has been dispatched than was received. Click to see the piece codes.`
                      : `Show the ${p.stock_qty} individual piece codes`}>
                    {p.stock_qty < 0 ? '⚠ ' : ''}{p.stock_qty} {p.uom}
                  </button>
                </td>
                <td style={{ textAlign: 'right' }}>{money(p.avg_cost)}</td>
                <td style={{ textAlign: 'right', color: p.stock_value < 0 ? 'var(--danger)' : undefined }}>
                  ₹ {money(p.stock_value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <Pager {...invPage} noun="product" />
        {/* A list shortened by a filter must say so, or it reads as stock that
            has gone missing — the one misreading this screen cannot afford. */}
        {products.length > 0 && (
          <div className="small" style={{ padding: '10px 0', color: 'var(--muted)' }}>
            Showing {visible.length} of {products.length} product(s)
            {visible.length < products.length && <>
              {' — '}
              <button className="link" style={{ padding: 0 }}
                onClick={() => { setQ(''); setStockScope('all'); setCatFilter(''); setSupFilter('') }}>
                clear search and filters</button>
            </>}
          </div>
        )}
      </div>

      {/* Clicking a quantity opens the pieces behind it: one inventory record of 8
          is eight garments, each with its own code and its own label to print. */}
      {units && (
        <div className="piece-wrap" onClick={() => setUnits(null)}>
          <div className="piece-card" onClick={(e) => e.stopPropagation()}>
            <div className="piece-head">
              <b className="mono">{units.product.sku}</b>
              <span>{units.product.name || units.product.description}</span>
              <span className="small">
                {[units.product.size, units.product.color].filter(Boolean).join(' · ')}
              </span>
              {/* one code per stock unit. For a pair product that unit IS two
                  garments, so the panel says how many pieces are behind it —
                  otherwise "6 codes, 12 pillow covers" reads as a shortfall */}
              <span style={{ marginLeft: 'auto' }} className="small">
                {units.count} code{units.count === 1 ? '' : 's'} for {units.product.stock_qty} {units.product.uom} in stock
                {units.product.pieces_per_unit > 1
                  ? ` · 1 ${units.product.unit_type} = ${units.product.pieces_per_unit} pcs`
                  : ''}
              </span>
              <button className="btn" onClick={() => setUnits(null)}>✕</button>
            </div>

            <div className="piece-body">
              {zoom && (
                <div className="piece-zoom">
                  <img src={api.unitQrSvgUrl(zoom.id, 6)} alt={zoom.code} />
                  <b className="mono">{zoom.code}</b>
                  <span className="small">
                    {zoom.print_count ? `printed ${zoom.print_count}×` : 'not printed yet'}
                    {zoom.last_printed_by ? ` · last by ${zoom.last_printed_by}` : ''}
                  </span>
                  <button className="btn" onClick={() => setZoom(null)}>Close</button>
                </div>
              )}
              {units.units.length === 0 ? (
                <p className="small" style={{ padding: '10px 0' }}>
                  {units.serialisable
                    ? 'No individual codes yet — this stock predates them.'
                    : `No individual codes: ${units.reason}.`}
                </p>
              ) : (
                <div className="piece-grid">
                  {unitPage.slice.map((u) => {
                    // a dead code is indistinguishable from a live one — same format,
                    // same QR, same product — so it has to be marked, not left to the eye
                    const dead = u.state && u.state !== 'posted'
                    return (
                      <div key={u.id} className="piece"
                        style={dead ? { opacity: 0.55, borderColor: 'var(--danger)' } : undefined}>
                        <img src={api.unitQrSvgUrl(u.id, 3)} alt={u.code} loading="lazy" />
                        <div className="code">{u.code}</div>
                        <div className="small" style={{ fontSize: 10 }}>
                          {dead
                            ? <span style={{ color: 'var(--danger)' }}>no posted GRN</span>
                            : (u.print_count ? `printed ${u.print_count}×` : 'not printed')}
                        </div>
                        <div className="acts">
                          <button className="btn" onClick={() => setZoom(u)} title="Show this code large">View</button>
                          <button className="btn" disabled={dead} onClick={() => printOne(u)}
                            title={dead ? 'This code belongs to no posted GRN — it is left over, not a garment'
                              : u.print_count ? 'Print this label again' : 'Print this label'}>
                            {u.print_count ? 'Reprint' : 'Print'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <Pager {...unitPage} noun="piece code" />
            </div>

            <div className="piece-foot">
              <span className="small">
                {units.can_print === false
                  /* Say the number, say the mismatch, say what to do. A label goes on a
                     garment, so printing more of them than there are garments is not a
                     tidiness problem — it is tags on the floor with nothing to attach
                     them to, every one of which scans as real. */
                  ? <span style={{ color: 'var(--danger)' }}>
                      ⚠ {units.print_block}
                      {units.orphan_units > 0 && <> {' '}<b>{units.orphan_units}</b> of the codes
                        shown belong to no posted GRN — Inventory → <b>Repair</b> removes them.</>}
                    </span>
                  : <>Every piece carries the same SKU and its own code, so a scan says which
                      garment it is — not just which product.</>}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                {units.serialisable && units.can_print !== false
                  && units.count < Math.round(units.product.stock_qty || 0) && (
                  <button className="btn" onClick={makeUnits}
                    title="Create the missing codes for stock received before per-piece codes existed">
                    Generate missing ({Math.round(units.product.stock_qty) - units.count})
                  </button>
                )}
                {units.units.length > 0 && (
                  <button className="btn primary" disabled={units.can_print === false}
                    onClick={() => printUnits(null)}
                    title={units.can_print === false
                      ? 'Inventory mismatch detected — ' + units.print_block
                      : `Print a label for each of the ${units.live_units ?? units.count} pieces`}>
                    🖨 Print all {units.live_units ?? units.count}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="sidebar" style={{ width: 400, borderRight: 'none', borderLeft: '1px solid var(--line)' }}>
          <div className="head"><h3>{detail.sku}</h3>
            <button className="btn" style={{ padding: '2px 9px' }} onClick={() => setDetail(null)}>×</button></div>
          <div style={{ padding: 16, overflowY: 'auto' }}>
            {/* Inventory is a VIEW of the product, not a second entry form. Everything
                here is decided upstream: description / HSN / UOM come off the invoice,
                category and prices are set on the GRN breakdown, and the physical
                attributes are recorded in the phone app. To change any of it, unpost
                the GRN, correct it there and post again — one place, one truth. */}
            <h4 style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', margin: '0 0 10px' }}>Product</h4>
            <div className="kv">
              {/* the name is the category; the supplier's wording keeps its own
                  row rather than the name's, because it is still what a re-buy
                  is matched on and it belongs to the invoice, not to us */}
              <div className="k">Name</div><div><b>{detail.name || detail.description}</b></div>
              <div className="k">On the invoice</div>
              <div style={{ color: 'var(--text-2)' }}>{detail.description || '—'}</div>
              <div className="k">HSN</div><div>{detail.hsn || '—'}</div>
              <div className="k">UOM</div><div>{detail.uom || '—'}</div>
              <div className="k">MRP</div><div>{detail.mrp != null ? '₹ ' + money(detail.mrp) : '—'}</div>
              <div className="k">Category</div>
              <div>{detail.category
                ? <>{detail.category}{detail.category_section && <span style={{ color: 'var(--muted)' }}> · {detail.category_section}</span>}</>
                : <span className="badge review" title="No confident match from the description — set it on the GRN line and re-post">unmapped</span>}</div>
              <div className="k">Supplier</div><div>{detail.supplier_name || '—'}</div>
            </div>

            <h4 style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', margin: '18px 0 8px' }}>
              Product attributes</h4>
            <div className="kv" style={{ margin: '0 0 6px' }}>
              {PRODUCT_ATTRS.map(([k, label]) => {
                const v = detail[k]
                const shown = v == null || v === '' ? null : (typeof v === 'number' ? money(v) : String(v))
                return (
                  <React.Fragment key={k}>
                    <div className="k">{label}</div>
                    <div>{shown ?? <span style={{ color: 'var(--muted)' }}>—</span>}</div>
                  </React.Fragment>
                )
              })}
            </div>
            {detail.detailed_by && (
              <div className="small" style={{ color: 'var(--muted)', marginBottom: 4 }}>
                Last detailed by <b>{detail.detailed_by}</b>
              </div>
            )}

            <div className="kv" style={{ margin: '18px 0' }}>
              <div className="k">Current stock</div><div><b>{detail.stock_qty}</b> {detail.uom}</div>
              <div className="k">Avg cost</div><div>₹ {money(detail.avg_cost)}</div>
              <div className="k">Value</div><div>₹ {money(detail.stock_value)}</div>
            </div>

            <h4 style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', margin: '18px 0 8px' }}>QR code &amp; label</h4>
            {/* Gated on the SKU, not a barcode: the SKU is the only code we issue
                now, and it is what the QR resolves to. */}
            {detail.sku ? (
              <div>
                <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', textAlign: 'center' }}>
                  <img src={api.qrSvgUrl(detail.id)} alt="QR" style={{ width: 150, height: 150 }} />
                  <div className="mono" style={{ fontSize: 12, marginTop: 2, color: '#000' }}>{detail.sku}</div>
                </div>
                {detail.barcode && (
                  <div className="small" style={{ marginTop: 6, color: 'var(--muted)' }}>
                    Supplier's printed code: <span className="mono">{detail.barcode}</span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <a className="btn primary" href={api.labelUrl(detail.id)} target="_blank" rel="noreferrer">🖨 Print label</a>
                  <button className="btn" onClick={genBarcode} title="Re-run identifier assignment">Ensure IDs</button>
                </div>
              </div>
            ) : detail.detailed ? (
              <button className="btn primary" onClick={genBarcode}>Generate SKU + QR</button>
            ) : (
              <p className="small">No SKU or QR yet.</p>
            )}

            <h4 style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', margin: '0 0 8px' }}>Adjust stock</h4>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div className="field" style={{ width: 110 }}><label>Set stock to</label>
                <input value={adjQty} placeholder={detail.stock_qty} onChange={(e) => setAdjQty(e.target.value)} /></div>
              <div className="field" style={{ flex: 1 }}><label>Reason</label>
                <input value={adjNote} placeholder="e.g. physical count" onChange={(e) => setAdjNote(e.target.value)} /></div>
              <button className="btn" onClick={doAdjust}>Apply</button>
            </div>

            <h4 style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', margin: '18px 0 8px' }}>
              Physical details {detail.detailed ? <span className="badge confirmed" style={{ marginLeft: 6 }}>detailed</span> : <span className="badge review" style={{ marginLeft: 6 }}>pending</span>}</h4>
            {detail.detailed ? (
              <div className="kv" style={{ marginBottom: 6 }}>
                <div className="k">Color</div><div>{detail.color || '—'}</div>
                <div className="k">Size</div><div>{detail.size || '—'}</div>
                <div className="k">Pattern</div><div>{detail.pattern || '—'}</div>
                <div className="k">Fit</div><div>{detail.fit || '—'}</div>
                <div className="k">Type</div><div>{detail.product_type || '—'}</div>
                <div className="k">Material</div><div>{detail.material || '—'}</div>
                <div className="k">Design No</div><div>{detail.design_no || '—'}</div>
                <div className="k">Sale price</div><div>{detail.sale_price != null ? '₹ ' + money(detail.sale_price) : '—'}</div>
                <div className="k">Discount %</div><div>{detail.sale_discount_pct != null ? detail.sale_discount_pct + '%' : '—'}</div>
                <div className="k">By</div><div>{detail.detailed_by || '—'}{detail.detailed_at ? ' · ' + fmtDate(detail.detailed_at) : ''}</div>
              </div>
            ) : <p className="small">Not yet detailed.</p>}

            <h4 style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', margin: '18px 0 8px' }}>Stock movements</h4>
            <table className="items"><thead><tr><th>Kind</th><th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Balance</th></tr></thead>
              <tbody>{detail.movements.map((m) => (
                <tr key={m.id}><td>{m.kind}</td>
                  <td style={{ textAlign: 'right', color: m.qty_delta >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
                    {m.qty_delta >= 0 ? '+' : ''}{m.qty_delta}</td>
                  <td style={{ textAlign: 'right' }}>{money(m.rate)}</td>
                  <td style={{ textAlign: 'right' }}>{m.balance_after}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- the product record, as every stock movement has to show it ----------
//
// Stock Outward, Stock Inward and Purchase Return are all somebody standing over
// a carton matching a row on a screen against a garment in their hand. A barcode
// and a description cannot settle that — four sizes of one style share both — so
// these three render the whole record the backend sends (services/stock_view.py):
// the QR that is actually scanned, the name, the attributes that tell one variant
// from its siblings, and the batch the stock was received on.

// One QR, sized for where it is shown. Renders the real code, so it scans off the
// screen — a picker with a phone doesn't have to find the printed label first.
function ProductQr({ product, size = 40, title }) {
  if (!product) return <span style={{ color: 'var(--muted)' }}>—</span>
  return (
    <img className="pqr" src={api.qrSvgUrl(product.product_id, size > 60 ? 4 : 2)}
      alt={`QR ${product.sku || ''}`} loading="lazy"
      title={title || `${product.sku || ''} — scan or click to enlarge`}
      style={{ width: size, height: size }} />
  )
}

// The attribute tuple as chips. Blank attributes are dropped by the backend, so a
// sparsely-detailed product shows what it has instead of a row of dashes.
function ProductAttrs({ product, showCategory = true }) {
  if (!product) return null
  const chips = product.attributes || []
  if (!chips.length && !product.category) {
    return <span className="small" style={{ color: 'var(--muted)' }}>no details recorded yet</span>
  }
  return (
    <div className="attrchips">
      {chips.map((a) => (
        <span key={a.key} className="attrchip" title={a.label}>
          <i>{a.label}</i>{a.value}
        </span>
      ))}
      {showCategory && product.category && <span className="attrchip cat">{product.category}</span>}
    </div>
  )
}

// Which receipt the goods came in on — this system's batch. Stock is pooled per
// SKU, so a dispatch can draw on more than one GRN; the extras are named in the
// tooltip rather than hidden behind a single "the" batch.
function BatchTag({ product }) {
  const b = product?.batch
  if (!b) return <span style={{ color: 'var(--muted)' }}>—</span>
  const more = (product.batches || []).slice(1)
  return (
    <span className="batchtag" title={[
      b.grn_no ? `GRN ${b.grn_no}` : null,
      b.invoice_number ? `Invoice ${b.invoice_number}${b.invoice_date ? ' · ' + fmtDate(b.invoice_date) : ''}` : null,
      b.bundle_code ? `Bundle ${b.bundle_code}` : null,
      b.supplier ? `From ${b.supplier}` : null,
      more.length ? `+ ${more.length} earlier receipt(s): ${more.map((x) => x.label).join(', ')}` : null,
    ].filter(Boolean).join('\n')}>
      {b.label}{more.length ? ` +${more.length}` : ''}
    </span>
  )
}

// The identity block used in a table cell: name, SKU, variant chips.
function ProductIdent({ product, fallback }) {
  if (!product) return <span>{fallback || '—'}</span>
  return (
    <div className="pident">
      <div className="nm">{product.name}</div>
      <div className="sub">
        <span className="mono">{product.sku || product.code}</span>
        {product.uom && <span>{product.uom}</span>}
        {product.hsn && <span>HSN {product.hsn}</span>}
        {product.supplier_barcode && (
          <span className="mono" title="The supplier's own printed code">
            ⌗ {product.supplier_barcode}</span>
        )}
      </div>
      <ProductAttrs product={product} />
    </div>
  )
}

// The full card, opened by clicking a QR — everything about the item at once,
// with the code big enough to scan across a packing bench.
function ProductCardModal({ product, onClose }) {
  if (!product) return null
  const money2 = (v) => (v == null ? '—' : '₹ ' + money(v))
  return (
    <div className="piece-wrap" onClick={onClose}>
      <div className="piece-card" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="piece-head">
          <b className="mono">{product.sku || product.code}</b>
          <span>{product.name}</span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button>
        </div>
        <div className="piece-body" style={{ display: 'flex', gap: 20 }}>
          <div style={{ textAlign: 'center' }}>
            <img src={api.qrSvgUrl(product.product_id, 5)} alt="QR"
              style={{ width: 190, height: 190, background: '#fff', borderRadius: 6, padding: 8 }} />
            <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>{product.sku || product.code}</div>
            <a className="btn" style={{ marginTop: 8, display: 'inline-block' }}
              href={api.labelUrl(product.product_id)} target="_blank" rel="noreferrer">🖨 Print label</a>
          </div>
          <div style={{ flex: 1 }}>
            <div className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
              <div className="k">Product</div><div>{product.name}</div>
              <div className="k">Category</div><div>{product.category || '—'}
                {product.category_section ? <span className="small"> · {product.category_section}</span> : null}</div>
              {(product.attributes || []).map((a) => (
                <React.Fragment key={a.key}>
                  <div className="k">{a.label}</div><div>{a.value}</div>
                </React.Fragment>
              ))}
              <div className="k">HSN / UOM</div><div>{product.hsn || '—'} · {product.uom || '—'}</div>
              <div className="k">Batch</div><div><BatchTag product={product} /></div>
              <div className="k">Supplier</div><div>{product.supplier || '—'}</div>
              <div className="k">In stock</div><div><b>{product.stock_qty}</b> {product.uom}</div>
              {/* the two prices, kept visibly apart: one is what we paid, the
                  other what we sell for, and a debit note may only use the first */}
              <div className="k">GRN cost</div><div>{money2(product.grn_cost)}
                <span className="small" style={{ color: 'var(--muted)' }}> — purchase price</span></div>
              <div className="k">MRP / Sale</div><div>{money2(product.mrp)} / {money2(product.sale_price)}
                <span className="small" style={{ color: 'var(--muted)' }}> — selling side</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// One dispatch / receipt / return line, rendered the same way on all three
// screens. `cols` are the screen-specific numbers appended after the identity.
function ProductRow({ line, onZoom, children, style }) {
  const p = line.product
  return (
    <tr style={style}>
      <td style={{ padding: 3, width: 46 }}>
        <span onClick={() => p && onZoom?.(p)} style={{ cursor: p ? 'zoom-in' : 'default' }}>
          <ProductQr product={p} />
        </span>
      </td>
      <td><ProductIdent product={p} fallback={line.description} /></td>
      <td className="small"><BatchTag product={p} /></td>
      {children}
    </tr>
  )
}

// A scan field. The warehouse types nothing here — the imager sends the payload
// and an Enter, which is why submit is on Enter rather than a button.
function ScanBox({ onScan, placeholder, label }) {
  const [code, setCode] = useState('')
  const submit = () => { const c = code.trim(); if (!c) return; setCode(''); onScan(c) }
  return (
    <div className="scanbox">
      <span className="ico">⌗</span>
      <input value={code} autoFocus onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
        placeholder={placeholder || 'Scan a QR / piece label / SKU…'} />
      <button className="btn" onClick={submit}>{label || 'Add'}</button>
    </div>
  )
}

// ---------- picking many products at once ----------
// The dropdown on a dispatch row answers one question — "which product is THIS
// line?" — and answers it once per line. A note carrying twenty products was
// twenty blank rows and twenty hunts down the same list, which is where the time
// on this screen went. This is that list as a tick sheet: filter it, tick what is
// going, correct the quantities, and the rows arrive already filled in.
//
// Two rules it keeps, both so that nothing you have already typed can be undone
// from in here:
//   * it only ADDS. A product already on the note is listed and disabled rather
//     than dropped from the list, so "where is it?" is answered on screen.
//   * quantity starts at the whole of what is on hand, because dispatching a
//     line usually means dispatching the line — and it is a text box, not a
//     figure that is committed to.
// Stock it cannot dispatch is not offered at all: a row for something with none
// on hand can only be refused at posting time.
function ProductPicker({ products, already, onAdd, onClose }) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState({})        // product_id -> qty, as typed
  const here = new Set((already || []).map(Number))
  const shown = products.filter((p) => (+p.stock_qty || 0) > 0)
    .filter((p) => matches(p, q, ['description', 'sku', 'size', 'color', 'category']))
  const chosen = Object.keys(picked)
  const units = chosen.reduce((n, k) => n + (+picked[k] || 0), 0)

  // What the header tick acts on: the rows ON SCREEN that are not already on the
  // note. So "pillow" then tick-all is "every pillow cover", not the warehouse —
  // and un-ticking it leaves anything picked under an earlier search alone,
  // because taking away a choice the filter is hiding is the one thing a tick
  // box must not do quietly. The footer count is what tells you they are there.
  const selectable = shown.filter((p) => !here.has(+p.id))
  const allOn = selectable.length > 0 && selectable.every((p) => p.id in picked)
  const someOn = selectable.some((p) => p.id in picked)

  const toggle = (p) => setPicked((m) => {
    const next = { ...m }
    if (p.id in next) delete next[p.id]
    else next[p.id] = String(p.stock_qty)
    return next
  })
  const toggleAll = () => setPicked((m) => {
    const next = { ...m }
    selectable.forEach((p) => {
      if (allOn) delete next[p.id]
      else if (!(p.id in next)) next[p.id] = String(p.stock_qty)
    })
    return next
  })
  const add = () => {
    const rows = chosen
      .map((k) => ({ product_id: String(k), qty: String(+picked[k] || 0) }))
      .filter((r) => +r.qty > 0)
    if (rows.length) onAdd(rows)
  }

  return (
    <div className="piece-wrap" onClick={onClose}>
      <div className="piece-card" style={{ maxWidth: 880 }} onClick={(e) => e.stopPropagation()}>
        <div className="piece-head">
          <b>Add products</b>
          <span className="small" style={{ color: 'var(--muted)' }}>{shown.length} in stock</span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button>
        </div>
        <div className="piece-body">
          <SearchBox value={q} onChange={setQ} placeholder="Search product / SKU / size / colour…" />
          <div className="tablewrap" style={{ marginTop: 10 }}>
            <table className="items entry">
              <thead><tr>
                <th style={{ width: 30 }}>
                  {/* half-ticked when only some of the shown rows are chosen —
                      a box that reads "none" over a part-selection is a lie */}
                  <input type="checkbox" checked={allOn} disabled={!selectable.length}
                    ref={(el) => { if (el) el.indeterminate = !allOn && someOn }}
                    onChange={toggleAll}
                    title={allOn ? 'Clear the ones shown'
                      : `Tick all ${selectable.length} shown`} />
                </th><th>Product</th><th>Category</th>
                <th style={{ textAlign: 'right', width: 90 }}>On hand</th>
                <th style={{ textAlign: 'right', width: 110 }}>Qty</th>
              </tr></thead>
              <tbody>{shown.map((p) => {
                const on = p.id in picked
                const got = here.has(+p.id)
                return (
                  <tr key={p.id} style={{ opacity: got ? 0.5 : 1, cursor: got ? 'default' : 'pointer' }}
                    onClick={() => { if (!got) toggle(p) }}
                    title={got ? 'Already on this note — change the quantity on the row itself' : ''}>
                    <td><input type="checkbox" checked={on} disabled={got} readOnly /></td>
                    <td>
                      <div>{p.name || p.description}</div>
                      <span className="small mono" style={{ color: 'var(--muted)' }}>
                        {p.sku}{p.size ? ' · ' + p.size : ''}{p.color ? ' · ' + p.color : ''}
                        {got ? ' · on this note' : ''}</span>
                    </td>
                    <td className="small">{p.category || '—'}</td>
                    <td className="num">{p.stock_qty} {p.uom}</td>
                    {/* the quantity box is the one place a click must not tick the row */}
                    <td className="num" onClick={(e) => e.stopPropagation()}>
                      <input value={picked[p.id] ?? ''} disabled={got || !on}
                        onChange={(e) => setPicked((m) => ({ ...m, [p.id]: e.target.value }))} /></td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
          {shown.length === 0 && <div className="empty" style={{ marginTop: 24 }}>
            {q ? 'Nothing matches.' : 'No product has stock to dispatch.'}</div>}
        </div>
        <div className="piece-foot">
          <span className="small">{chosen.length} selected · {round3(units)} unit(s)</span>
          {/* the only way to drop ticks a search is currently hiding */}
          {chosen.length > 0 && (
            <button className="btn" style={{ padding: '2px 9px' }} onClick={() => setPicked({})}
              title="Drop every tick, including any the search is hiding">Clear</button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!units} onClick={add}>
            Add{chosen.length ? ` ${chosen.length}` : ''}</button>
        </div>
      </div>
    </div>
  )
}

// ---------- stock outward ----------
function StockOutward({ toast }) {
  const [products, setProducts] = useState([])
  const [sel, setSel] = useState(null)
  const [creating, setCreating] = useState(false)
  // the sidebar's scope filter — the same chips Stock Inward and Returns use
  const [scope, setScope] = useState('all')
  // Where the goods are being picked from. WAREHOUSE is the normal case; MULTI is
  // for a dispatch drawn from more than one place, so the paperwork says so
  // instead of naming a single location that isn't the whole truth.
  const FROM_LOCATIONS = ['WAREHOUSE', 'MULTI']
  // The places this company trades from. Loaded once: the destination picker and
  // the source picker both read it, and the list changes about once a year.
  const [places, setPlaces] = useState({ warehouses: [], stores: [] })
  // `to_kind` is a UI-only choice of WHICH picker is showing. The server is sent
  // one of to_warehouse_id / to_store_id / to_destination and decides the kind
  // from that — see models.StockOutward.
  const BLANK = { date: '', to_destination: '', packed_by: '',
    from_location: 'WAREHOUSE', from_warehouse_id: '', to_kind: 'store',
    to_warehouse_id: '', to_store_id: '', lines: [] }
  const [form, setForm] = useState(BLANK)
  const [q, setQ] = useState('')
  // derived AFTER the state it reads — a const referenced above its own
  // declaration is a temporal-dead-zone throw, and in a render that is the whole
  // tab going blank rather than one broken value
  // One page at a time from the server, searched and filtered there — every
  // dispatch ever made is tens of thousands of notes, 10 MB sent whole.
  const qd = useDebounced(q)
  const outPage = useServerPaged(({ limit, offset }) =>
    api.outwardsPage({ status: scope, limit, offset, q: qd }), `${scope}|${qd}`)
  const counts = outPage.counts
  const [zoom, setZoom] = useState(null)          // a product card, opened large
  const [cards, setCards] = useState({})          // product_id -> full record, for the draft rows
  const [picking, setPicking] = useState(false)   // the tick-sheet over stock is open
  const refresh = () => outPage.reload()
  useEffect(() => { api.listProducts({ held: 1 }).then(setProducts) }, [])
  useEffect(() => {
    api.locationTree().then((t) => {
      const warehouses = (t.warehouses || []).filter((w) => w.id && w.active !== false)
      const stores = warehouses.flatMap((w) => (w.stores || [])
        .filter((s) => s.active !== false)
        .map((s) => ({ ...s, warehouse_name: w.name })))
      setPlaces({ warehouses, stores })
      // Default the source to the first warehouse so a one-warehouse install
      // never has to answer a question it has only one answer to.
      setForm((f) => (f.from_warehouse_id || !warehouses.length ? f
        : { ...f, from_warehouse_id: String(warehouses[0].id) }))
    }).catch(() => { /* the old free-text destination still works without it */ })
  }, [])
  useEffect(() => { if (sel) api.getOutward(sel).then(setForm2); function setForm2(o){ setDetail(o) } }, [sel])
  const [detail, setDetail] = useState(null)

  // A line being packed shows the same record the posted one will: pull the card
  // as soon as a product is chosen, so the picker verifies BEFORE it is dispatched
  // rather than reading it back afterwards.
  const loadCard = useCallback(async (id) => {
    if (!id || cards[id]) return
    try { const c = await api.productCard(id); setCards((m) => ({ ...m, [c.product_id]: c })) }
    catch { /* a product with no card is still dispatchable — the row just stays plain */ }
  }, [cards])
  // The same fill for a whole batch of rows. Deduped against what is already
  // held BEFORE the requests go out: loadCard in a loop reads one stale `cards`
  // and asks the server for the same record as many times as it is called.
  const loadCards = useCallback(async (ids) => {
    const want = [...new Set(ids.map(Number))].filter((id) => id && !cards[id])
    await Promise.all(want.map(async (id) => {
      try { const c = await api.productCard(id); setCards((m) => ({ ...m, [c.product_id]: c })) }
      catch { /* as above — the row still dispatches, it just stays plain */ }
    }))
  }, [cards])

  const addLine = () => setForm({ ...form, lines: [...form.lines, { product_id: '', qty: 1 }] })
  // Rows arriving from the picker. They land on the END of the note, and a blank
  // row left over from "+ add item" is consumed rather than left sitting under
  // them looking like an item nobody finished choosing.
  const addPicked = (rows) => {
    setForm((f) => ({ ...f, lines: [...f.lines.filter((l) => l.product_id), ...rows] }))
    setPicking(false)
    loadCards(rows.map((r) => r.product_id))
    toast(`✓ ${rows.length} product${rows.length === 1 ? '' : 's'} added`, 'ok')
  }
  const updLine = (i, k, v) => {
    const l = form.lines.map(x => ({ ...x })); l[i][k] = v; setForm({ ...form, lines: l })
    if (k === 'product_id') loadCard(v)
  }
  const rmLine = (i) => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })
  // Scanning is the fast path in and the safe one: the code resolves to exactly
  // one product, so nobody picks the wrong size off a dropdown of look-alikes.
  const addScanned = async (code) => {
    try {
      const c = await api.productCard(code)
      setCards((m) => ({ ...m, [c.product_id]: c }))
      const at = form.lines.findIndex((l) => +l.product_id === c.product_id)
      if (at >= 0) {
        const l = form.lines.map(x => ({ ...x })); l[at].qty = (+l[at].qty || 0) + 1
        setForm({ ...form, lines: l })
        toast(`+1 ${c.name}${c.variant ? ' · ' + c.variant : ''} (${l[at].qty})`, 'ok')
      } else {
        setForm({ ...form, lines: [...form.lines, { product_id: String(c.product_id), qty: 1 }] })
        toast(`✓ ${c.name}${c.variant ? ' · ' + c.variant : ''}`, 'ok')
      }
    } catch (e) { toast(e.detail || `Nothing matches “${code}”`, 'err') }
  }
  const save = async () => {
    const lines = form.lines.filter(l => l.product_id).map(l => ({ product_id: +l.product_id, qty: +l.qty }))
    if (!lines.length) { toast('Add at least one product', 'err'); return }
    // Only the destination the chosen kind names is sent. Passing all three and
    // letting the server pick would mean a destination left over from a kind the
    // person switched away from silently deciding where the goods go.
    if (form.to_kind === 'warehouse' && !form.to_warehouse_id) {
      toast('Choose the warehouse this is going to', 'err'); return }
    if (form.to_kind === 'store' && !form.to_store_id) {
      toast('Choose the store this is going to', 'err'); return }
    const body = {
      date: form.date, packed_by: form.packed_by, from_location: form.from_location,
      from_warehouse_id: form.from_warehouse_id ? +form.from_warehouse_id : null,
      to_warehouse_id: form.to_kind === 'warehouse' ? +form.to_warehouse_id : null,
      to_store_id: form.to_kind === 'store' ? +form.to_store_id : null,
      to_destination: form.to_kind === 'other' ? form.to_destination : null,
      lines,
    }
    try {
      const o = await api.createOutward(body)
      toast(`✓ Outward ${o.code} created`, 'ok'); setCreating(false)
      setForm({ ...BLANK, from_warehouse_id: form.from_warehouse_id })
      refresh(); setSel(o.id)
    } catch (e) { toast(e.detail || 'Could not create the outward', 'err') }
  }
  const post = async () => {
    try { const r = await api.postOutward(sel); toast(`✓ Dispatched · ${r.total_qty} units out`, 'ok'); api.getOutward(sel).then(setDetail); refresh() }
    catch (e) {
      const d = e.detail
      if (d && d.error === 'insufficient_stock') {
        // Named per warehouse, and "there is more of it elsewhere" is said out
        // loud — otherwise a picker reads this as "we are out of it" and stops,
        // when the answer is a transfer from the branch that has it.
        toast('Not enough at ' + (d.problems[0]?.warehouse || 'this warehouse') + ': '
          + d.problems.map(p => `${p.product} (need ${p.requested}, have ${p.on_hand}`
            + (p.elsewhere > 0 ? `, ${p.elsewhere} elsewhere` : '') + ')').join('; '), 'err')
      } else toast(typeof d === 'string' ? d : 'Post failed', 'err')
    }
  }
  // scanning a garment against an open dispatch — is it on this note?
  const verify = async (code) => {
    try {
      const r = await api.verifyOutward(sel, code)
      setZoom(r.product)
      toast(r.matched ? `✓ On this dispatch — ${r.product.name}`
        : `⚠ NOT on this dispatch — ${r.product.name}${r.product.variant ? ' · ' + r.product.variant : ''}`,
        r.matched ? 'ok' : 'err')
    } catch (e) { toast(e.detail || `Nothing matches “${code}”`, 'err') }
  }
  return (
    <div className="body">
      <Sidebar id="outward" label="Outwards">
        <div className="head"><h3>Outwards · {outPage.total.toLocaleString('en-IN')}</h3>
          <button className="btn primary" style={{ padding: '4px 10px' }} onClick={() => { setCreating(true); setSel(null) }}>+ New</button></div>
        {(counts.all || 0) > 0 && <>
          <SearchBox value={q} onChange={setQ} placeholder="Search destination, code, status…" />
          <div className="toolbar"><FilterChips value={scope} onChange={setScope} options={[
            ['draft', 'Draft', counts.draft || 0, 'Prepared, nothing dispatched yet'],
            ['posted', 'Sent', counts.posted || 0, 'Dispatched, not yet accepted'],
            ['received', 'Received', counts.received || 0, 'Accepted at the destination'],
            ['all', 'All', counts.all || 0, 'Every dispatch'],
          ]} /></div>
        </>}
        <div className="list">
          {outPage.loading && outPage.rows.length === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>Loading…</div>}
          {!outPage.loading && (counts.all || 0) > 0 && outPage.total === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>
            Nothing matches. Try “All” or clear the search.</div>}
          {outPage.slice.map((o) => (
            <div key={o.id} className={'doc-row' + (sel === o.id && !creating ? ' sel' : '')} onClick={() => { setSel(o.id); setCreating(false) }}>
              <div className="t">{o.to_destination || o.code}</div>
              <div className="m"><span className={'badge ' + (o.status === 'posted' ? 'confirmed' : 'uploaded')}>{o.status}</span>
                {/* A transfer comes back to us and a shop dispatch does not, which
                    is the difference that decides whether anyone has to receive it */}
                {o.kind === 'transfer' && <span className="badge" title="Warehouse to warehouse — the far end still has to count it in">transfer</span>}
                <span>{o.code}</span>
                {o.from_warehouse && <span title="Dispatched from">{o.from_warehouse}</span>}
                <span style={{ marginLeft: 'auto' }}>{o.total_qty} units</span></div>
            </div>
          ))}
        </div>
        <Pager {...outPage} noun="dispatch" nouns="dispatches" />
      </Sidebar>
      {creating ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="editor">
            <h2 style={{ marginTop: 0 }}>New Stock Outward</h2>
            <div className="grid" style={{ maxWidth: 640 }}>
              <DateField label="Date" value={form.date} onChange={(v) => setForm({ ...form, date: v })} />
              <div className="field"><label>From warehouse</label>
                <select value={form.from_warehouse_id} style={{ width: '100%' }}
                  onChange={(e) => setForm({ ...form, from_warehouse_id: e.target.value })}>
                  {!places.warehouses.length && <option value="">(no warehouses set up)</option>}
                  {places.warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}{w.code ? ` · ${w.code}` : ''}</option>
                  ))}
                </select>
                <div className="hint">The stock comes off this building's shelf, and
                  it is this building's on-hand figure the dispatch is checked against.</div>
              </div>
              <div className="field"><label>Send to</label>
                <select value={form.to_kind} style={{ width: '100%' }}
                  onChange={(e) => setForm({ ...form, to_kind: e.target.value,
                    to_warehouse_id: '', to_store_id: '', to_destination: '' })}>
                  <option value="store">A store</option>
                  <option value="warehouse">Another warehouse (transfer)</option>
                  <option value="other">Somewhere else</option>
                </select></div>
              {form.to_kind === 'warehouse' && (
                <div className="field"><label>To warehouse</label>
                  <select value={form.to_warehouse_id} style={{ width: '100%' }}
                    onChange={(e) => setForm({ ...form, to_warehouse_id: e.target.value })}>
                    <option value="">— choose —</option>
                    {places.warehouses.filter((w) => String(w.id) !== String(form.from_warehouse_id))
                      .map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                  <div className="hint">A transfer. The stock leaves here now and
                    arrives there when that warehouse counts it in — until then it
                    is in transit and belongs to neither.</div>
                </div>
              )}
              {form.to_kind === 'store' && (
                <div className="field"><label>To store</label>
                  <select value={form.to_store_id} style={{ width: '100%' }}
                    onChange={(e) => setForm({ ...form, to_store_id: e.target.value })}>
                    <option value="">— choose —</option>
                    {places.stores.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} · {s.warehouse_name}</option>
                    ))}
                  </select>
                  <div className="hint">The shop's own till takes it from here —
                    it does not come back into the warehouse ledger.</div>
                </div>
              )}
              {form.to_kind === 'other' && (
                <div className="field"><label>To (destination)</label>
                  <input value={form.to_destination} placeholder="e.g. a customer, or a place not set up yet"
                    onChange={(e) => setForm({ ...form, to_destination: e.target.value })} /></div>
              )}
              <div className="field"><label>Packed by</label><input value={form.packed_by} onChange={(e) => setForm({ ...form, packed_by: e.target.value })} /></div>
              <div className="field"><label>From location</label>
                <select value={form.from_location} style={{ width: '100%' }}
                  onChange={(e) => setForm({ ...form, from_location: e.target.value })}>
                  {FROM_LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select></div>
            </div>
            <Section id="outward.new-items" title="Items to dispatch" style={{ marginTop: 18 }}>
              <ScanBox onScan={addScanned} placeholder="Scan a QR / piece label / SKU to add…" />
              <div className="tablewrap">
              <table className="items">
                <thead><tr><th style={{ width: 46 }}>QR</th><th>Product</th><th>Batch</th>
                  <th style={{ width: 230 }}>Or pick from inventory</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>On hand</th><th></th></tr></thead>
                <tbody>{form.lines.map((l, i) => {
                  const card = cards[+l.product_id]
                  const short = card && +l.qty > (card.stock_qty ?? 0)
                  return (
                    <tr key={i}>
                      <td style={{ padding: 3 }}>
                        <span onClick={() => card && setZoom(card)} style={{ cursor: card ? 'zoom-in' : 'default' }}>
                          <ProductQr product={card} /></span></td>
                      <td><ProductIdent product={card} fallback="— nothing selected —" /></td>
                      <td className="small"><BatchTag product={card} /></td>
                      <td><select value={l.product_id} onChange={(e) => updLine(i, 'product_id', e.target.value)}
                        style={{ width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 5, padding: '5px' }}>
                        <option value="">— select product —</option>
                        {products.map(p => <option key={p.id} value={p.id}>
                          {p.name || p.description}{p.size ? ' · ' + p.size : ''}{p.color ? ' · ' + p.color : ''} (stock {p.stock_qty})</option>)}
                      </select></td>
                      <td className="num"><input value={l.qty} onChange={(e) => updLine(i, 'qty', e.target.value)} /></td>
                      <td style={{ textAlign: 'right', color: short ? 'var(--danger)' : undefined }}
                        title={short ? 'More than is on hand — posting will be refused' : ''}>
                        {card ? card.stock_qty : '—'}{short ? ' ⚠' : ''}</td>
                      <td><button className="btn" style={{ padding: '2px 7px' }} onClick={() => rmLine(i)}>×</button></td>
                    </tr>
                  )
                })}</tbody>
              </table>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn primary" onClick={() => setPicking(true)}
                  title="Tick several products off a list of what is in stock and add them all at once">
                  ⊞ Pick products</button>
                <button className="btn" onClick={addLine}>+ add item</button>
              </div>
            </Section>
          </div>
          <div className="actionbar"><div className="spacer" />
            <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn primary" onClick={save}>Create Outward</button></div>
        </div>
      ) : detail ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="editor">
            <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
              <h2 style={{ margin: 0 }}>{detail.to_destination}</h2>
              <span className={'badge ' + (detail.status === 'posted' ? 'confirmed' : 'uploaded')}>{detail.status}</span>
              {detail.kind === 'transfer' && <span className="badge">warehouse transfer</span>}</div>
            <div className="kv" style={{ margin: '12px 0 20px', gridTemplateColumns: '130px 1fr 130px 1fr' }}>
              <div className="k">Code</div><div>{detail.code}</div><div className="k">Date</div><div>{fmtDate(detail.date)}</div>
              <div className="k">From</div><div>{detail.from_warehouse || detail.from_location}</div>
              <div className="k">To</div>
              <div>{detail.to_warehouse || detail.to_store || detail.to_destination || '—'}
                {detail.to_store && <span className="small"> (store)</span>}</div>
              <div className="k">Packed by</div><div>{detail.packed_by || '—'}</div>
              <div className="k" /><div />
              {detail.status === 'received' && <>
                <div className="k">Received by</div><div>{detail.received_by || '—'}</div>
                <div className="k">Received on</div><div>{fmtDate(detail.received_date || detail.received_at)}</div>
              </>}
            </div>
            {detail.status !== 'draft' && (
              <div style={{ marginBottom: 14 }}>
                <ScanBox onScan={verify} label="Verify"
                  placeholder="Scan a garment to check it belongs to this dispatch…" />
              </div>
            )}
            <Section id="outward.items" title="Items">
              <div className="tablewrap">
              <table className="items">
                <thead><tr><th style={{ width: 46 }}>QR</th><th>Product</th><th>Batch</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  {detail.status === 'received' && <th style={{ textAlign: 'right' }}>Accepted</th>}
                  <th style={{ textAlign: 'right' }}>Cost</th><th style={{ textAlign: 'right' }}>Value</th>
                  <th style={{ textAlign: 'right' }}>On hand</th></tr></thead>
                <tbody>{detail.lines.map(l => (
                  <ProductRow key={l.id} line={l} onZoom={setZoom}>
                    <td style={{ textAlign: 'right' }}>{l.qty}</td>
                    {detail.status === 'received' && (
                      <td style={{ textAlign: 'right', color: l.short_qty > 0 ? 'var(--danger)' : 'var(--ok)' }}>
                        {l.accepted_qty}{l.short_qty > 0 ? ` (−${l.short_qty})` : ''}</td>
                    )}
                    <td style={{ textAlign: 'right' }} title="Weighted-average purchase cost">{money(l.rate)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.value)}</td>
                    <td style={{ textAlign: 'right' }}>{l.stock_on_hand}</td>
                  </ProductRow>
                ))}</tbody>
              </table>
              </div>
              <div className="items-foot"><span>{detail.lines.length} items</span>
                <span>Σ qty <b>{detail.total_qty}</b></span>
                {detail.status === 'received' && <span>accepted <b>{detail.accepted_qty}</b></span>}
                {detail.shortfall > 0 && <span style={{ color: 'var(--danger)' }}>short <b>{detail.shortfall}</b></span>}
              </div>
            </Section>
          </div>
          <div className="actionbar">
            <span className="small">{detail.status === 'received'
              ? `Received at ${detail.to_destination || 'the destination'}.`
                + (detail.kind === 'transfer' ? ' The accepted quantity is now that warehouse’s stock.' : '')
              : detail.status === 'posted'
                ? 'Dispatched — stock is out of ' + (detail.from_warehouse || 'the warehouse') + '. '
                  + (detail.kind === 'transfer'
                    ? `In transit until ${detail.to_warehouse} counts it in on Stock Inward.`
                    : detail.kind === 'store'
                      ? 'The shop’s till takes it from here.'
                      : 'Accept it on Stock Inward when it lands.')
                : 'Posting takes the stock out of ' + (detail.from_warehouse || 'the warehouse') + '.'}</span>
            <div className="spacer" />
            <button className="btn primary" disabled={detail.status !== 'draft'} onClick={post}>
              {detail.status === 'draft' ? 'Post Outward (reduce stock)' : 'Posted ✓'}</button>
          </div>
        </div>
      ) : <div className="empty">Select an outward, or click “+ New” to dispatch stock.</div>}
      {picking && creating && (
        <ProductPicker products={products} onAdd={addPicked} onClose={() => setPicking(false)}
          already={form.lines.map((l) => l.product_id)} />
      )}
      {zoom && <ProductCardModal product={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}

// ---------- stock inward (accepting a dispatched transfer at the destination) ----------
function StockInward({ toast }) {
  const [sel, setSel] = useState(null)
  const [detail, setDetail] = useState(null)
  const [scope, setScope] = useState('posted')     // awaiting receipt | already received
  const [acc, setAcc] = useState({})               // line_id -> accepted qty (blank = all)
  const [who, setWho] = useState('')
  const [date, setDate] = useState('')
  const [q, setQ] = useState('')
  const [zoom, setZoom] = useState(null)
  const [hit, setHit] = useState(null)             // the line a scan just landed on
  // Paged by the server: "Received" is every transfer ever accepted.
  const qd = useDebounced(q)
  const inwPage = useServerPaged(({ limit, offset }) =>
    api.outwardsPage({ status: scope, limit, offset, q: qd }), `${scope}|${qd}`)
  // how many this chip holds before any search — whether there is anything to search
  const inScope = scope === 'all' ? (inwPage.counts.all || 0) : (inwPage.counts[scope] || 0)

  const refresh = () => inwPage.reload()
  const open = (id) => api.getOutward(id).then((o) => { setSel(id); setDetail(o); setAcc({}); setHit(null) })

  // Scanning while counting the box in: it says which line the garment is, and
  // ticks one more onto its accepted count. Something not on the note is the
  // error worth shouting about — that is a mis-dispatch, not a miscount.
  const scan = async (code) => {
    try {
      const r = await api.verifyOutward(sel, code)
      if (!r.matched) {
        setZoom(r.product)
        toast(`⚠ NOT on this transfer — ${r.product.name}${r.product.variant ? ' · ' + r.product.variant : ''}`, 'err')
        return
      }
      const line = detail.lines.find((l) => l.id === r.line_id)
      const now = (acc[r.line_id] ?? '') === '' ? 1 : +acc[r.line_id] + 1
      if (now > (line?.qty ?? 0)) {
        toast(`All ${line.qty} of ${r.product.name} are already counted in`, 'err'); return
      }
      setAcc({ ...acc, [r.line_id]: now }); setHit(r.line_id)
      toast(`✓ ${r.product.name}${r.product.variant ? ' · ' + r.product.variant : ''} — ${now} of ${line.qty}`, 'ok')
    } catch (e) { toast(e.detail || `Nothing matches “${code}”`, 'err') }
  }

  const receive = async () => {
    try {
      const accepted = {}
      Object.entries(acc).forEach(([k, v]) => { if (v !== '') accepted[k] = +v })
      const r = await api.receiveOutward(sel, { received_by: who, date, accepted })
      toast(r.shortfall > 0
        ? `✓ Received ${r.accepted_qty} of ${r.total_qty} — ${r.shortfall} short`
        : `✓ Received in full · ${r.accepted_qty} units`, r.shortfall > 0 ? 'err' : 'ok')
      open(sel); refresh()
    } catch (e) { toast('Receive failed: ' + (e.detail || e.message), 'err') }
  }

  const editable = detail && detail.status === 'posted'
  const acceptedOf = (l) => ((acc[l.id] ?? '') === '' ? (l.qty || 0) : +acc[l.id] || 0)
  const counted = detail ? detail.lines.reduce((s, l) => s + acceptedOf(l), 0) : 0

  return (
    <div className="body">
      <Sidebar id="inward" label="Stock Inward">
        <div className="head"><h3>Stock Inward · {inwPage.total.toLocaleString('en-IN')}</h3></div>
        <div style={{ display: 'flex', gap: 6, padding: '0 12px 8px' }}>
        </div>
        <div className="toolbar"><FilterChips value={scope}
          onChange={(k) => { setScope(k); setSel(null); setDetail(null) }} options={[
            ['posted', 'Awaiting', null, 'Dispatched and waiting to be counted in'],
            ['received', 'Received', null, 'Already accepted'],
            ['all', 'All', null, 'Every transfer'],
          ]} /></div>
        {inScope > 0 && <SearchBox value={q} onChange={setQ} placeholder="Search destination, code…" />}
        <div className="list">
          {inwPage.loading && inwPage.rows.length === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>Loading…</div>}
          {!inwPage.loading && inScope === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>
            {scope === 'posted' ? 'Nothing in transit — dispatched transfers appear here to be received.' : 'Nothing here yet.'}</div>}
          {!inwPage.loading && inScope > 0 && inwPage.total === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>
            Nothing matches — clear the search.</div>}
          {inwPage.slice.map((o) => (
            <div key={o.id} className={'doc-row' + (sel === o.id ? ' sel' : '')} onClick={() => open(o.id)}>
              <div className="t">{o.to_destination || o.code}</div>
              <div className="m"><span className={'badge ' + (o.status === 'received' ? 'confirmed' : 'review')}>
                {o.status === 'received' ? 'received' : 'in transit'}</span>
                <span>{o.code}</span><span style={{ marginLeft: 'auto' }}>{o.total_qty} units</span></div>
              {o.status === 'received' && o.shortfall > 0 && (
                <div className="m"><span style={{ color: 'var(--danger)' }}>{o.shortfall} short</span></div>)}
            </div>
          ))}
        </div>
        <Pager {...inwPage} noun="transfer" />
      </Sidebar>
      {detail ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="editor">
            <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
              <h2 style={{ margin: 0 }}>{detail.to_destination || detail.code}</h2>
              <span className={'badge ' + (detail.status === 'received' ? 'confirmed' : 'review')}>
                {detail.status === 'received' ? 'received' : 'in transit'}</span>
            </div>
            <div className="kv" style={{ margin: '12px 0 18px', gridTemplateColumns: '130px 1fr 130px 1fr' }}>
              <div className="k">Package</div><div className="mono">{detail.code}</div>
              <div className="k">Dispatched</div><div>{fmtDate(detail.date || detail.posted_at)}</div>
              <div className="k">From</div><div>{detail.from_company} · {detail.from_location}</div>
              <div className="k">Packed by</div><div>{detail.packed_by || '—'}</div>
              {detail.status === 'received' && <>
                <div className="k">Received by</div><div>{detail.received_by || '—'}</div>
                <div className="k">Received on</div><div>{fmtDate(detail.received_date || detail.received_at)}</div>
              </>}
            </div>
            {editable && (
              <div style={{ marginBottom: 14 }}>
                <ScanBox onScan={scan} label="Count in"
                  placeholder="Scan each garment as it comes out of the box…" />
              </div>
            )}
            <Section id="inward.lines" title={editable ? 'Check the goods in' : 'Goods received'}>
              <div className="tablewrap">
              <table className="items">
                <thead><tr><th style={{ width: 46 }}>QR</th><th>Product</th><th>Batch</th>
                  <th style={{ textAlign: 'right' }}>Sent</th>
                  <th style={{ textAlign: 'right' }}>Accepted</th>
                  <th style={{ textAlign: 'right' }}>Short</th>
                  <th style={{ textAlign: 'right' }}>Cost</th></tr></thead>
                <tbody>{detail.lines.map((l) => {
                  const a = acceptedOf(l)
                  const short = Math.round((l.qty - a) * 1000) / 1000
                  return (
                    <ProductRow key={l.id} line={l} onZoom={setZoom}
                      style={hit === l.id ? { background: 'var(--info-bg)' } : undefined}>
                      <td style={{ textAlign: 'right' }}>{l.qty}</td>
                      <td className="num">{editable
                        ? <input value={acc[l.id] ?? ''} placeholder={l.qty}
                            onChange={(e) => setAcc({ ...acc, [l.id]: e.target.value })} />
                        : l.accepted_qty}</td>
                      <td style={{ textAlign: 'right', color: (editable ? short : l.short_qty) > 0 ? 'var(--danger)' : 'var(--muted)' }}>
                        {(editable ? short : l.short_qty) > 0 ? (editable ? short : l.short_qty) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.rate)}</td>
                    </ProductRow>
                  )
                })}</tbody>
              </table>
              </div>
              <div className="items-foot"><span>{detail.lines.length} items</span>
                <span>sent <b>{detail.total_qty}</b></span>
                <span>accepting <b>{Math.round(counted * 1000) / 1000}</b></span>
                {detail.total_qty - counted > 0 && (
                  <span style={{ color: 'var(--danger)' }}>short <b>{Math.round((detail.total_qty - counted) * 1000) / 1000}</b></span>)}
              </div>
            </Section>
          </div>
          {editable ? (
            <div className="actionbar">
              <div className="field" style={{ width: 170 }}><label>Received by</label>
                <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="who took it in" /></div>
              <DateField label="Date" width={150} value={date} onChange={setDate} />
              <div className="spacer" />
              <button className="btn primary" onClick={receive}>Receive Goods</button>
            </div>
          ) : (
            <div className="actionbar">
              <span className="small">{detail.status === 'received'
                ? (detail.shortfall > 0
                  ? `Received with a shortfall of ${detail.shortfall} unit(s).`
                  : 'Received in full.')
                : 'This transfer has not been dispatched yet — post it on Stock Outward first.'}</span>
              <div className="spacer" />
            </div>
          )}
        </div>
      ) : <div className="empty">Select a transfer to check it in.</div>}
      {zoom && <ProductCardModal product={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}
// Same `accent` families as DashTile, so a figure keeps its colour whether it is
// shown in a strip or on a dashboard.
function Stat({ label, value, accent }) {
  return (
    <div className={'stat' + (accent ? ' t-' + accent : '')}>
      <div className="lbl">{label}</div>
      {/* same length-aware step-down the dashboard tiles use */}
      <div className={'val' + (longValue(value) ? ' long' : '')}>{value}</div>
    </div>
  )
}

// ---------- supplier payments (accounts payable) ----------
function Payments({ toast }) {
  const [suppliers, setSuppliers] = useState([])
  const [sel, setSel] = useState(null)
  const [bills, setBills] = useState([])
  const [rows, setRows] = useState({})     // purchase_id -> {sel, cash, discount, tds, debit}
  const [ledger, setLedger] = useState(null)
  const [payments, setPayments] = useState([])
  const [head, setHead] = useState({ date: '', mode: 'NEFT', ref_no: '', remarks: '' })
  const [q, setQ] = useState('')

  const loadSuppliers = useCallback(() => api.listSuppliers().then(setSuppliers), [])
  useEffect(() => { loadSuppliers(); api.listPayments().then(setPayments) }, [loadSuppliers])
  const payPage = usePaged(suppliers.filter((s) => matches(s, q, ['name', 'gstin'])), 50)
  const loadSupplier = (id) => {
    setSel(id)
    api.pendingBills(id).then((b) => {
      setBills(b)
      const r = {}; b.forEach(x => { r[x.purchase_id] = { sel: false, cash: x.outstanding, discount: 0, tds: 0, debit: 0 } }); setRows(r)
    })
    api.supplierLedger(id).then(setLedger)
  }
  const upd = (pid, k, v) => setRows({ ...rows, [pid]: { ...rows[pid], [k]: v } })
  const totals = bills.reduce((a, b) => {
    const r = rows[b.purchase_id]; if (!r || !r.sel) return a
    a.cash += +r.cash || 0; a.disc += +r.discount || 0; a.tds += +r.tds || 0; a.debit += +r.debit || 0
    a.settle += (+r.cash || 0) + (+r.discount || 0) + (+r.tds || 0) + (+r.debit || 0); a.n++
    return a
  }, { cash: 0, disc: 0, tds: 0, debit: 0, settle: 0, n: 0 })

  const record = async () => {
    const allocations = bills.filter(b => rows[b.purchase_id]?.sel).map(b => {
      const r = rows[b.purchase_id]
      return { purchase_id: b.purchase_id, cash: +r.cash || 0, discount: +r.discount || 0, tds: +r.tds || 0, debit_adjust: +r.debit || 0 }
    })
    if (!allocations.length) { toast('Select at least one invoice', 'err'); return }
    const pay = await api.createPayment({ supplier_id: sel, ...head, allocations })
    toast(`✓ Payment ${pay.receipt_no} recorded`, 'ok')
    loadSupplier(sel); loadSuppliers(); api.listPayments().then(setPayments)
    setHead({ date: '', mode: 'NEFT', ref_no: '', remarks: '' })
  }

  return (
    <div className="body">
      <Sidebar id="payables" label="Payables">
        <div className="head"><h3>Suppliers · payables</h3></div>
        <SearchBox value={q} onChange={setQ} placeholder="Search supplier, GSTIN…" />
        <div className="list">
          {payPage.slice.map((s) => (
            <div key={s.id} className={'sup-row' + (sel === s.id ? ' sel' : '')} onClick={() => loadSupplier(s.id)}>
              <div className="t">{s.name}</div>
              <div className="m"><span>{s.document_count} bill(s)</span></div>
            </div>
          ))}
        </div>
        <Pager {...payPage} noun="supplier" />
      </Sidebar>
      {sel ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="editor">
            {ledger && <div style={{ display: 'flex', gap: 14, marginBottom: 18 }}>
              <Stat label="Outstanding" value={'₹ ' + money(ledger.outstanding)} accent="money" />
              <Stat label="Pending bills" value={bills.length} accent="count" />
            </div>}
            <Section id="pay.pending-bills" title="Pending bills — select, then set cash / discount / TDS / debit">
              {bills.length === 0 ? <p className="small">No outstanding invoices for this supplier.</p> : (
                <div className="tablewrap">
                <table className="items">
                  <thead><tr><th></th><th>Invoice</th><th>Date</th><th style={{ textAlign: 'right' }}>Days</th>
                    <th style={{ textAlign: 'right' }}>Outstanding</th><th style={{ textAlign: 'right' }}>Cash</th>
                    <th style={{ textAlign: 'right' }}>Discount</th><th style={{ textAlign: 'right' }}>TDS</th>
                    <th style={{ textAlign: 'right' }}>Debit</th></tr></thead>
                  <tbody>{bills.map((b) => {
                    const r = rows[b.purchase_id] || {}
                    return (
                      <tr key={b.purchase_id} style={{ background: r.sel ? 'var(--panel-2)' : '' }}>
                        <td><input type="checkbox" checked={!!r.sel} onChange={(e) => upd(b.purchase_id, 'sel', e.target.checked)} /></td>
                        <td className="mono">{b.invoice_number}</td><td>{fmtDate(b.invoice_date)}</td>
                        <td style={{ textAlign: 'right' }}>{b.days ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{money(b.outstanding)}</td>
                        <td className="num"><input value={r.cash ?? ''} disabled={!r.sel} onChange={(e) => upd(b.purchase_id, 'cash', e.target.value)} /></td>
                        <td className="num"><input value={r.discount ?? ''} disabled={!r.sel} onChange={(e) => upd(b.purchase_id, 'discount', e.target.value)} /></td>
                        <td className="num"><input value={r.tds ?? ''} disabled={!r.sel} onChange={(e) => upd(b.purchase_id, 'tds', e.target.value)} /></td>
                        <td className="num"><input value={r.debit ?? ''} disabled={!r.sel} onChange={(e) => upd(b.purchase_id, 'debit', e.target.value)} /></td>
                      </tr>
                    )
                  })}</tbody>
                </table>
                </div>
              )}
              {totals.n > 0 && <div className="items-foot">
                <span>{totals.n} selected</span><span>cash <b>₹{money(totals.cash)}</b></span>
                <span>disc <b>₹{money(totals.disc)}</b></span><span>TDS <b>₹{money(totals.tds)}</b></span>
                <span>debit <b>₹{money(totals.debit)}</b></span><span>settling <b>₹{money(totals.settle)}</b></span></div>}
            </Section>

            {ledger && ledger.rows.length > 0 && <Section id="pay.ledger" title="Supplier ledger" summary={`${ledger.rows.length} row(s)`}>
              <table className="items"><thead><tr><th>Date</th><th>Type</th><th>Ref</th>
                <th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th>
                <th style={{ textAlign: 'right' }}>Balance</th></tr></thead>
                <tbody>{ledger.rows.map((r, i) => (
                  <tr key={i}><td>{fmtDate(r.date)}</td><td>{r.type}</td>
                    <td className="mono">{r.ref}{r.detail ? <span className="small"> · {r.detail}</span> : ''}</td>
                    <td style={{ textAlign: 'right' }}>{r.debit ? money(r.debit) : ''}</td>
                    <td style={{ textAlign: 'right', color: 'var(--ok)' }}>{r.credit ? money(r.credit) : ''}</td>
                    <td style={{ textAlign: 'right' }}><b>{money(r.balance)}</b></td></tr>
                ))}</tbody>
              </table>
            </Section>}
          </div>
          <div className="actionbar">
            <div className="field" style={{ width: 120 }}><label>Mode</label>
              <select value={head.mode} onChange={(e) => setHead({ ...head, mode: e.target.value })}
                style={{ width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 7, padding: '7px' }}>
                <option>NEFT</option><option>RTGS</option><option>Cash</option><option>Cheque</option></select></div>
            <div className="field" style={{ width: 140 }}><label>Ref / UTR</label><input value={head.ref_no} onChange={(e) => setHead({ ...head, ref_no: e.target.value })} /></div>
            <DateField label="Date" width={150} value={head.date} onChange={(v) => setHead({ ...head, date: v })} />
            <div className="spacer" />
            <div style={{ textAlign: 'right', marginRight: 8 }}><div className="small">paying</div><b style={{ fontSize: 18 }}>₹ {money(totals.cash)}</b></div>
            <button className="btn primary" disabled={totals.n === 0} onClick={record}>Record Payment</button>
          </div>
        </div>
      ) : <div className="empty">Select a supplier to see pending bills and record a payment.</div>}
    </div>
  )
}

// ---------- purchase returns ----------
function Returns({ toast }) {
  const [list, setList] = useState([])
  const [picking, setPicking] = useState(false)
  const [scope, setScope] = useState('all')
  const [detail, setDetail] = useState(null)
  const [qtys, setQtys] = useState({})
  const [reason, setReason] = useState('')
  const [date, setDate] = useState('')
  const [q, setQ] = useState('')
  const [zoom, setZoom] = useState(null)
  const refresh = useCallback(() => api.listReturns().then(setList), [])
  useEffect(() => { refresh() }, [refresh])

  // The reference-invoice picker: posted GRNs, a page at a time and searched on
  // the server — every posted receipt at once was a table of tens of thousands.
  const [pq, setPq] = useState('')
  const pqd = useDebounced(pq)
  const pickPage = useServerPaged(({ limit, offset }) => (picking
    ? api.purchasesPage({ limit, offset, q: pqd, status: 'posted' })
    : Promise.resolve({ rows: [], total: 0 })), `${picking}|${pqd}`)
  const openPicker = () => { setPq(''); setPicking(true); setDetail(null) }
  // Received lines come back at 0 — how many go back is still a decision. Shortage
  // lines come back at the quantity counted at the dock, because that one isn't:
  // the pieces are missing and by how many was settled when the boxes were opened.
  // Seeding the editor from the server keeps that pre-fill visible and postable.
  const seedQtys = (r) => Object.fromEntries((r.lines || [])
    .filter((l) => +l.qty > 0).map((l) => [l.id, String(l.qty)]))
  const startReturn = async (purchaseId, shortagesOnly) => {
    try {
      const r = await api.buildReturn(purchaseId, shortagesOnly)
      setDetail(r); setPicking(false); setQtys(seedQtys(r)); setReason(shortagesOnly ? 'Short delivery' : ''); setDate('')
      if (shortagesOnly && !(r.shortage_lines || 0)) toast('No unclaimed shortage on that invoice', 'err')
    } catch (e) { toast(e.detail || 'Could not raise the debit note', 'err') }
  }
  const openReturn = (id) => api.getReturn(id).then(r => { setDetail(r); setPicking(false); setQtys(seedQtys(r)) })
  const post = async () => {
    try {
      const line_qtys = {}; Object.entries(qtys).forEach(([k, v]) => { if (+v > 0) line_qtys[k] = +v })
      if (!Object.keys(line_qtys).length) { toast('Set a return qty on at least one line', 'err'); return }
      const res = await api.postReturn(detail.id, { reason, date, line_qtys })
      const short = res.shortage_lines
        ? ` · ${res.shortage_lines} shortage claim(s), ₹${money(res.shortage_value)} (no stock moved)` : ''
      toast(`✓ Debit note ${detail.code} posted · ₹${money(res.debit_total)}${short}`, 'ok')
      api.getReturn(detail.id).then(setDetail); refresh()
    } catch (e) { toast('Post failed: ' + (e.detail || e.message), 'err') }
  }
  const editable = detail && detail.status !== 'posted'
  const shown = list.filter((r) => scope === 'all' || r.status === scope)
    .filter((r) => matches(r, q, ['supplier_name', 'invoice_number', 'code', 'status']))
  const retPage = usePaged(shown, 50)
  const draftTotal = detail ? detail.lines.reduce((s, l) => s + (+qtys[l.id] || 0) * (l.rate || 0), 0) : 0

  return (
    <div className="body">
      <Sidebar id="returns" label="Returns">
        <div className="head"><h3>Returns · {list.length}</h3>
          <button className="btn primary" style={{ padding: '4px 10px' }} onClick={openPicker}>+ New</button></div>
        {list.length > 0 && <>
          <SearchBox value={q} onChange={setQ} placeholder="Search supplier, invoice, code…" />
          <div className="toolbar"><FilterChips value={scope} onChange={setScope} options={[
            ['draft', 'Draft', list.filter((r) => r.status === 'draft').length, 'Debit notes not yet posted'],
            ['posted', 'Posted', list.filter((r) => r.status === 'posted').length, 'Raised against the supplier'],
            ['all', 'All', list.length, 'Every debit note'],
          ]} /></div>
        </>}
        <div className="list">
          {list.length > 0 && shown.length === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>
            Nothing matches. Try “All” or clear the search.</div>}
          {retPage.slice.map((r) => (
            <div key={r.id} className={'doc-row' + (detail?.id === r.id && !picking ? ' sel' : '')} onClick={() => openReturn(r.id)}>
              <div className="t">{r.supplier_name}</div>
              <div className="m"><span className={'badge ' + (r.status === 'posted' ? 'confirmed' : 'uploaded')}>{r.status}</span>
                <span>{r.code}</span><span style={{ marginLeft: 'auto' }}>₹ {money(r.total)}</span></div>
              <div className="m"><span>vs {r.invoice_number}</span></div>
            </div>
          ))}
        </div>
        <Pager {...retPage} noun="return" />
      </Sidebar>
      {picking ? (
        <div className="editor">
          <h2 style={{ marginTop: 0 }}>New Purchase Return — pick a reference invoice</h2>
          <SearchBox value={pq} onChange={setPq} placeholder="Search supplier, invoice, GRN no…" style={{ maxWidth: 360 }} />
          {pickPage.loading && pickPage.rows.length === 0 && <div className="empty" style={{ marginTop: 20 }}>Loading…</div>}
          {!pickPage.loading && pickPage.total === 0 && <div className="empty" style={{ marginTop: 20 }}>
            {pq ? 'No posted GRN matches — clear the search.' : 'No posted GRN to return against yet.'}</div>}
          <table className="items"><thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th>
            <th style={{ textAlign: 'right' }}>Grand total</th>
            <th style={{ textAlign: 'right' }}>Short</th><th></th></tr></thead>
            <tbody>{pickPage.rows.map(p => (
              <tr key={p.id}><td>{p.supplier_name}</td><td className="mono">{p.invoice_number}</td>
                <td>{fmtDate(p.invoice_date)}</td><td style={{ textAlign: 'right' }}>₹ {money(p.grand_total)}</td>
                <td style={{ textAlign: 'right', color: p.short_qty ? 'var(--warn)' : 'var(--muted)' }}
                  title={p.short_qty ? `${p.short_qty} unit(s) counted short or damaged at receiving` : ''}>
                  {p.short_qty ? `${p.short_qty} · ₹ ${money(p.short_value)}` : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {p.short_qty > 0 && (
                    <button className="btn" style={{ padding: '3px 10px', marginRight: 5 }}
                      title="Debit note for the goods that never arrived — quantities already counted at the dock"
                      onClick={() => startReturn(p.id, true)}>Claim shortage →</button>
                  )}
                  <button className="btn" style={{ padding: '3px 10px' }} onClick={() => startReturn(p.id)}>Return →</button></td></tr>
            ))}</tbody>
          </table>
          <Pager {...pickPage} noun="posted GRN" />
        </div>
      ) : detail ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="editor">
            <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
              <h2 style={{ margin: 0 }}>{detail.code} · {detail.supplier_name}</h2>
              <span className={'badge ' + (detail.status === 'posted' ? 'confirmed' : 'uploaded')}>{detail.status}</span></div>
            <div className="kv" style={{ margin: '12px 0 20px', gridTemplateColumns: '140px 1fr 140px 1fr' }}>
              <div className="k">Debit note vs</div><div className="mono">{detail.invoice_number}
                {detail.grn_no ? <span className="small"> · GRN {detail.grn_no}</span> : null}</div>
              <div className="k">Debit total</div><div>₹ {money(detail.status === 'posted' ? detail.total : draftTotal)}{editable ? ' + tax' : ''}</div>
              <div className="k">Priced at</div>
              <div style={{ gridColumn: 'span 3' }}>
                <span className="badge confirmed">{detail.cost_basis_label || 'Purchase / GRN cost'}</span>
              </div>
            </div>
            <Section id="return.lines" title={editable ? 'Set return quantity per line' : 'Returned lines'}>
              <div className="tablewrap">
              <table className="items">
                <thead><tr><th style={{ width: 46 }}>QR</th><th>Product</th><th>Batch</th>
                  <th style={{ textAlign: 'right' }}>Received</th>
                  <th style={{ textAlign: 'right' }}>On hand</th>
                  <th style={{ textAlign: 'right' }} title="The purchase price this item was received at — the debit note's basis">
                    GRN cost</th>
                  <th style={{ textAlign: 'right' }}>{editable ? 'Return qty' : 'Qty'}</th>
                  <th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
                <tbody>{detail.lines.map(l => {
                  const q = editable ? (qtys[l.id] ?? '') : l.qty
                  const amt = editable ? (+qtys[l.id] || 0) * (l.rate || 0) : l.amount
                  if (!editable && !l.qty) return null
                  const over = editable && +q > (l.available_qty ?? Infinity)
                  return (
                    <ProductRow key={l.id} line={l} onZoom={setZoom}
                      style={l.is_shortage_claim ? { background: 'var(--warn-bg)' } : undefined}>
                      <td style={{ textAlign: 'right' }} title={l.is_shortage_claim
                        ? `${l.purchased_qty} counted short at receiving — this line claims goods that never arrived, so posting it moves no stock`
                        : l.already_returned
                          ? `${l.already_returned} already returned on an earlier debit note`
                          : 'Received on this invoice'}>
                        {l.is_shortage_claim
                          ? <span className="badge review">{l.purchased_qty} short</span>
                          : (l.purchased_qty || '—')}
                        {l.already_returned > 0 && <span className="small" style={{ color: 'var(--warn)' }}> −{l.already_returned}</span>}
                      </td>
                      {/* never arrived, so there is no stock figure and posting won't touch one */}
                      <td style={{ textAlign: 'right' }}>{l.is_shortage_claim
                        ? <span className="small" style={{ color: 'var(--muted)' }} title="These units never entered stock">no stock</span>
                        : l.on_hand}</td>
                      <td style={{ textAlign: 'right' }} title={{
                        grn_variant_rate: 'The rate this variant was received at on the GRN breakdown',
                        invoice_line_rate: 'The rate the supplier billed on this invoice line',
                        weighted_avg_cost: 'Weighted-average purchase cost (no GRN rate survives for this line)',
                      }[l.cost_source] || 'Purchase cost'}>
                        {money(l.grn_rate ?? l.rate)}
                        {l.cost_source === 'weighted_avg_cost' && <span className="small" style={{ color: 'var(--muted)' }}> avg</span>}
                      </td>
                      <td className="num">{editable
                        ? <input value={q} placeholder="0" style={over ? { borderColor: 'var(--danger)' } : undefined}
                            title={over ? `Only ${l.available_qty} available to return` : ''}
                            onChange={(e) => setQtys({ ...qtys, [l.id]: e.target.value })} />
                        : l.qty}</td>
                      <td style={{ textAlign: 'right' }}>{money(amt)}</td>
                    </ProductRow>
                  )
                })}</tbody>
              </table>
              </div>
              <div className="items-foot">
                <span>{detail.lines.length - (detail.shortage_lines || 0)} received item(s)</span>
                {detail.shortage_lines > 0 && (
                  <span style={{ color: 'var(--warn)' }}>
                    ⚠ {detail.shortage_lines} shortage claim(s)
                  </span>
                )}
              </div>
            </Section>
          </div>
          {editable && (
            <div className="actionbar">
              <div className="field" style={{ width: 180 }}><label>Reason</label><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. damaged / wrong item" /></div>
              <DateField label="Date" width={150} value={date} onChange={setDate} />
              <div className="spacer" />
              <button className="btn primary" onClick={post}>Post Debit Note</button>
            </div>
          )}
        </div>
      ) : <div className="empty">Select a return, or click “+ New” to return goods against an invoice.</div>}
      {zoom && <ProductCardModal product={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}

// ---------- reports ----------
// Group headings and their order come from the server (services/reports.GROUPS),
// so the screen and the catalogue can never drift apart. This is only the
// fallback for a server too old to serve them.
const REPORT_GROUPS = {
  transport: 'Transport Reports', invoice: 'Invoice Reports', stock: 'Stock Reports',
  purchase: 'Purchase Reports', purchase_return: 'Purchase Return Reports',
  outward: 'Outward Reports', master: 'Other Reports',
}
const PARAM_LABEL = { date_from: 'From', date_to: 'To', as_on: 'As on' }

// ==========================================================================
//  Ask a report
//  ------------------------------------------------------------------------
//  A question in English or Tamil instead of picking one of 33 reports and
//  setting its filters. The server routes the question to a real report from the
//  catalogue and answers in the ordinary {columns, rows, totals} shape, so the
//  answer lands in the table below unchanged.
//
//  The reading is shown, always. A router that quietly picks the wrong report
//  hands someone a table of real numbers answering a question they did not ask,
//  and nothing on screen would give them a way to notice. Saying "I read this as
//  Purchase Items Report, 1–31 July, supplier AMS Garments" costs one line and
//  makes a misread visible in the moment rather than a fortnight later.
// ==========================================================================

// Same shape the server's /csv writes, because someone comparing the two should
// not have to wonder which is authoritative.
const toCsv = (columns, rows, totals) => {
  const cell = (v) => {
    // Dates leave in the format the screen showed them in. A download that
    // disagrees with the table it came from is the one nobody trusts.
    const s = v == null ? '' : String(fmtLoose(v))
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [columns.map(cell).join(',')]
  rows.forEach((r) => lines.push(columns.map((c) => cell(r[c])).join(',')))
  if (totals && Object.keys(totals).length) {
    lines.push('')
    lines.push(['TOTALS', ...Object.entries(totals).map(([k, v]) => cell(`${k}=${v}`))].join(','))
  }
  return lines.join('\r\n')
}

const downloadCsv = (name, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

// ---------- speaking the question instead of typing it ----------
//
// The browser's own recogniser, not an upload to a transcription service: it is
// free, adds no key to configure, sends no audio anywhere, and already speaks
// ta-IN. What comes out is dropped into the same box someone would have typed
// into, so the question takes the identical path from there.
//
// WHERE THIS DOES NOT WORK, AND WHY IT SAYS SO
// Speech recognition needs a secure context — https, or localhost. run.bat binds
// 0.0.0.0:8000 and the README tells people to reach the app from a phone at
// http://<computer-ip>:8000, and on that origin the API is simply absent. A mic
// button that silently does nothing there would read as a broken feature, so the
// reason is detected and shown instead.
const SpeechRec = typeof window !== 'undefined' &&
  (window.SpeechRecognition || window.webkitSpeechRecognition)

//: The recogniser has to be told which language to expect — it cannot be left to
//: work it out, and the two are far enough apart that guessing wrong transcribes
//: to nonsense. So this is a choice someone makes, and it is remembered.
const VOICE_LANGS = [
  ['en-IN', 'EN', 'English — Indian English'],
  ['ta-IN', 'தமிழ்', 'Tamil'],
]

const voiceBlockedBecause = () => {
  if (!SpeechRec) return 'this browser has no speech recognition — Chrome or Edge does'
  if (!window.isSecureContext) {
    return `voice needs https or localhost, and this page is on `
      + `${window.location.protocol}//${window.location.hostname} — `
      + `open the app at http://localhost:8000 on the machine running it`
  }
  return null
}

function VoiceButton({ onInterim, onSpoken, disabled }) {
  const [listening, setListening] = useState(false)
  const [err, setErr] = useState('')
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem('essa_voice_lang') || 'en-IN' } catch { return 'en-IN' }
  })
  const rec = useRef(null)
  const blocked = voiceBlockedBecause()

  const pickLang = (l) => {
    setLang(l)
    try { localStorage.setItem('essa_voice_lang', l) } catch { /* private mode */ }
  }

  // A live recogniser holding the microphone open after this screen is gone is
  // both a stuck mic light and a callback firing into an unmounted component.
  useEffect(() => () => { try { rec.current?.abort() } catch { /* already gone */ } }, [])

  const stop = () => { try { rec.current?.stop() } catch { /* not started */ } }

  const start = () => {
    if (blocked || listening) return
    setErr('')
    const r = new SpeechRec()
    rec.current = r
    r.lang = lang
    r.interimResults = true      // so the words appear while they are being said
    r.continuous = false         // one question per press, not an open microphone
    r.maxAlternatives = 1

    r.onresult = (e) => {
      let interim = '', final = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript
        if (e.results[i].isFinal) final += chunk; else interim += chunk
      }
      if (interim) onInterim(interim)
      // Asked as soon as it is heard, and the words stay in the box: a mishearing
      // is then visible both in the box and in the reading above the table, which
      // is a better correction loop than making someone press Ask every time.
      //
      // Listening is cleared here rather than left to `onend`. With
      // continuous = false the recogniser does end itself, but not always
      // promptly — and until it does, the button still pulses as though the mic
      // were open and the language switch stays disabled.
      if (final) { onInterim(final); setListening(false); onSpoken(final.trim()) }
    }
    r.onerror = (e) => {
      setErr({
        'not-allowed': 'microphone permission was refused — allow it in the browser address bar',
        'service-not-allowed': 'the browser blocked speech recognition on this page',
        'no-speech': 'nothing was heard — try again a little closer to the microphone',
        'audio-capture': 'no microphone was found',
        'network': 'speech recognition could not reach the network',
        'aborted': '',
      }[e.error] || `speech recognition failed (${e.error})`)
      setListening(false)
    }
    r.onend = () => setListening(false)
    try { r.start(); setListening(true) } catch (e) { setErr('could not start the microphone') }
  }

  if (blocked) {
    return (
      <span className="askvoice-off" title={`Voice input unavailable: ${blocked}`}>
        🎤 <span className="askvoice-why">off</span>
      </span>
    )
  }

  return (
    <span className="askvoice">
      <button className={'askmic' + (listening ? ' on' : '')} disabled={disabled}
        onClick={() => (listening ? stop() : start())}
        title={listening ? 'Stop listening' : `Ask by voice (${VOICE_LANGS.find(([l]) => l === lang)?.[2]})`}>
        {listening ? '⏹' : '🎤'}
      </button>
      {/* Which language to listen for. Two buttons rather than a select: it is a
          two-way switch someone flips mid-shift, not a setting to go and find. */}
      <span className="asklangs">
        {VOICE_LANGS.map(([l, short, full]) => (
          <button key={l} className={'asklang' + (lang === l ? ' on' : '')} title={`Listen for ${full}`}
            disabled={listening} onClick={() => pickLang(l)}>{short}</button>
        ))}
      </span>
      {listening && <span className="asklistening" title="Listening — speak your question">listening…</span>}
      {err && <span className="askvoice-err" title={err}>{err}</span>}
    </span>
  )
}

function AskBar({ value, onChange, onAsk, busy, engine }) {
  return (
    <div className="askbar">
      <span className="ico" aria-hidden="true">✨</span>
      {/* the clear button is positioned against this wrapper, not the bar, so
          adding controls to the right of the input cannot displace it */}
      <span className="askfield">
        <input value={value} onChange={(e) => onChange(e.target.value)}
          placeholder="Ask a question, or press 🎤 — “what did we buy last month”, “நிலுவை பாக்கி எவ்வளவு”"
          title="Ask in English or Tamil, typed or spoken. The question is routed to one of the reports on the left."
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onAsk() }} />
        {value && <button className="askclear" title="Clear" onClick={() => onChange('')}>×</button>}
      </span>
      {/* Spoken words land in the same box, so voice is a way of filling this
          control rather than a second path through the feature. */}
      <VoiceButton onInterim={onChange} onSpoken={(t) => onAsk(t)} disabled={busy} />
      {/* onAsk() called with no argument on purpose — onClick={onAsk} would hand
          it the click event as the question text. */}
      <button className="btn primary" disabled={busy || !value.trim()} onClick={() => onAsk()}
        title="Find the report that answers this">{busy ? 'Reading…' : 'Ask'}</button>
      {engine === 'keywords' && (
        <span className="askengine" title={'No vision/API key is set, so questions are matched on keywords rather than read. '
          + 'Turn on a key in the top bar for full sentences and Tamil phrasing this list does not cover.'}>
          keyword mode
        </span>
      )}
    </div>
  )
}

// What the question was taken to mean, what the report could honour, and what it
// could not. The last of those is the point: only `stock_movement` filters by
// product and nothing filters by supplier, so a question can easily ask for a cut
// the report cannot make.
function AskReading({ read, onDismiss }) {
  const chips = Object.entries(read.applied || {})
  return (
    <div className={'askread' + (read.report_key ? '' : ' miss')}>
      <div className="askread-top">
        <span className="askread-what">
          {read.report_key
            ? <><b>{read.report_name}</b> — {read.reading}</>
            : <>Nothing in the catalogue answers that. <span className="small">{read.reading}</span></>}
        </span>
        <span className="spacer" />
        {read.engine === 'model' && read.confidence !== 'high' && (
          <span className="askflag" title="The router was not certain of this match — check it is the report you meant before trusting the figures.">
            {read.confidence} confidence
          </span>
        )}
        {read.engine === 'keywords' && (
          <span className="askflag" title="Matched on keywords, not read as a sentence.">keywords</span>
        )}
        <button className="askclear" title="Dismiss this reading" onClick={onDismiss}>×</button>
      </div>
      {chips.length > 0 && (
        <div className="askchips">
          {chips.map(([k, v]) => (
            <span key={k} className="askchip" title={`The report ran with ${k} = ${fmtLoose(v)}`}>
              {(PARAM_LABEL[k] || k.replace(/_/g, ' '))}: <b>{String(fmtLoose(v))}</b>
            </span>
          ))}
        </div>
      )}
      {(read.narrowed || []).map((n, i) => (
        <div key={'n' + i} className="asknote">↳ {n}</div>
      ))}
      {(read.ignored || []).map((n, i) => (
        <div key={'i' + i} className="asknote warn">⚠ {n}</div>
      ))}
      {read.degraded && <div className="asknote warn">⚠ {read.degraded}</div>}
    </div>
  )
}

function Reports() {
  // Everything this screen reads is held in the dashboard cache (dashcache.js)
  // for the workspace it was read in, and the report that was on screen — with
  // its filters — is remembered there too. Leaving for a dashboard and coming
  // back finds the same report, drawn at once, re-reading behind the table.
  const wh = warehouse.get()?.id
  const memo = recall(REPORTS_MEMO(wh)) || {}
  const cat = useCached(DASH.reportCat(wh).key, () => DASH.reportCat(wh).read()).data || []
  const groups = useCached(DASH.reportGroups(wh).key, () => DASH.reportGroups(wh).read()).data || []
  // The Store's Sales / Retail Reports, listed under the warehouse's own and
  // opened in the shop's report page — undefined while asking, null when the
  // Store is not signed in, [] when there is no Store here at all.
  const store = useCached(DASH.storeReports(wh).key, () => DASH.storeReports(wh).read()).data
  // engine + example questions
  const askMeta = useCached(DASH.reportExamples(wh).key, () => DASH.reportExamples(wh).read()).data || null
  const [picked, setKey] = useState(memo.key || null)
  // Until something is picked, the first report in the catalogue — as before,
  // but without waiting on an effect once the catalogue is already held.
  const key = picked || cat[0]?.key || null
  const [q, setQ] = useState('')
  const [filters, setFilters] = useState(memo.filters || {})   // the values behind a report's params
  const [filtersOpen, setFiltersOpen] = useState(false)
  // --- ask ---
  const [ask, setAsk] = useState('')
  const [asked, setAsked] = useState(null)      // the interpretation, while it stands
  const [asking, setAsking] = useState(false)
  // An answered question's table. Not cached: it can be narrowed after the
  // report ran, so it is not what the report alone would return.
  const [askRep, setAskRep] = useState(null)
  const entry = cat.find((r) => r.key === key)
  // a filter only counts if the selected report declares it — switching from a
  // date-ranged report to one without dates must not keep filtering silently
  const active = (f = filters, e = entry) =>
    Object.fromEntries(Object.entries(f).filter(([k, v]) => v && (e?.params || []).includes(k)))
  const storeKey = key?.startsWith('store:') ? key.slice(6) : null
  // The report itself. Only once the catalogue says which filters it takes —
  // asked before that, the same report would be read twice under two keys —
  // and not while an answered question's table is up, which already is it.
  const runQ = entry && !storeKey && !askRep ? DASH.report(wh, key, active()) : null
  const rq = useCached(runQ?.key || null, () => runQ.read())
  useEffect(() => { if (runQ) cacheTrim(`${wh || 'co'}|rep|`, REPORTS_HELD) }, [runQ?.key])
  useEffect(() => { remember(REPORTS_MEMO(wh), { key, filters }) }, [wh, key, filters])
  // A question nothing answered leaves no table, whatever report was up before.
  const miss = !!(asked && !asked.report_key)
  const rep = askRep || (miss ? null : rq.data) || null
  const busy = rq.busy
  const load = () => { setAskRep(null); return rq.refresh().catch(() => {}) }
  // Picking a report by hand, or touching a filter, means the question no longer
  // describes what is on screen — so the reading goes rather than sitting there
  // captioning a table it no longer refers to.
  // Clicking the report already open re-reads it, as it always did.
  const pick = (k) => {
    if (k === key && !askRep) rq.refresh().catch(() => {})
    setKey(k); setAskRep(null); setQ(''); setAsked(null)
  }
  // A Store report: shown in the shop's own page, which has its own period,
  // branch and till filters and its own export. '' is the Store's catalogue.
  const pickStore = (k) => { setKey('store:' + k); setAskRep(null); setQ(''); setAsked(null) }
  const storeCount = (store || []).reduce((n, g) => n + g.reports.length, 0)
  const setFilter = (p, v) => {
    setFilters({ ...filters, [p]: v })
    setAsked(null)
    setAskRep(null)
  }

  // An answered question drives the ordinary controls: it selects the report in
  // the list and writes its filters into the filter panel. So the search box, the
  // filter panel and the export keep working on the result exactly as they would
  // if the report had been picked by hand — nothing downstream needs an ask path.
  // `text` is passed explicitly by the example buttons: they setAsk() and ask in
  // the same handler, and a runAsk() closing over `ask` would still be holding
  // the previous render's value at that point. Typed rather than trusted, because
  // wiring this straight to an onClick hands it a MouseEvent instead.
  const runAsk = async (text) => {
    const question = (typeof text === 'string' ? text : ask).trim()
    if (!question) return
    setAsking(true); setQ('')
    try {
      const r = await api.askReport(question)
      setAsked(r.interpretation)
      if (r.ok && r.report) {
        setKey(r.interpretation.report_key)
        setFilters(r.interpretation.applied || {})
        setAskRep(r.report)
      } else {
        setAskRep(null)
      }
    } catch (e) {
      // The frontend is served off disk and picks up a rebuild on refresh, but
      // routes are registered when Python starts — so a backend left running
      // from before this endpoint existed serves the new screen and then rejects
      // its calls. That is a restart, not a broken feature, and saying "Method
      // Not Allowed" sends someone looking in entirely the wrong place.
      const stale = e.status === 404 || e.status === 405
      setAsked({
        report_key: null, engine: 'none',
        reading: stale
          ? 'the server is still running the code from before this feature was added — '
            + 'restart the backend (Ctrl-C in the run window, then run.bat again) and ask again'
          : (e.detail || 'the question could not be sent'),
      })
      setAskRep(null)
    }
    setAsking(false)
  }
  const rows = rep ? rep.rows.filter((row) => !q || rep.columns.some((c) => String(row[c] ?? '').toLowerCase().includes(q.toLowerCase()))) : []
  // a stock or transport report over a year runs to thousands of rows
  const repPage = usePaged(rows, 100)
  const grouped = cat.reduce((a, r) => { (a[r.group] = a[r.group] || []).push(r); return a }, {})
  const order = groups.length ? groups : Object.entries(REPORT_GROUPS).map(([k2, n]) => ({ key: k2, name: n }))
  const dateParams = (entry?.params || []).filter((p) => PARAM_LABEL[p])
  // A report's columns are whatever the report returns, so a cell is formatted
  // by what it IS rather than by which column it sits in: figures grouped, dates
  // read back as DD-MM-YYYY like everywhere else, everything else left alone.
  const fmt = (v) => typeof v === 'number' ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : (fmtLoose(v) ?? '')
  // Dismissing a miss puts the previously selected report back, rather than
  // leaving the pane empty with a live selection behind it. Clearing the
  // reading is enough: the report's own read is still held.
  const dismissReading = () => { setAsked(null) }
  return (
    <div className="body">
      <Sidebar id="reports" label="Reports">
        <div className="head"><h3>Reports · {cat.length + storeCount}</h3></div>
        <div className="list" style={{ padding: '6px 0' }}>
          {order.filter((g) => grouped[g.key]?.length).map((g) => (
            <div key={g.key}>
              <div style={{ padding: '10px 14px 4px', fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', letterSpacing: '.5px' }}>
                {g.name} <span style={{ opacity: 0.6 }}>({grouped[g.key].length})</span>
              </div>
              {grouped[g.key].map(r => (
                // A question nothing answered leaves no report on screen, so
                // nothing in this list is highlighted either — a highlight with
                // no table next to it reads as "this is what you are looking at".
                <div key={r.key} className={'doc-row' + (key === r.key && !miss ? ' sel' : '')}
                  style={{ padding: '8px 14px' }} onClick={() => pick(r.key)}>
                  <div className="t" style={{ fontWeight: key === r.key && !miss ? 700 : 400 }}>{r.name}</div>
                </div>
              ))}
            </div>
          ))}
          {store !== undefined && !(Array.isArray(store) && store.length === 0) && (
            <div>
              <div style={{ padding: '16px 14px 4px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', borderTop: '1px solid var(--line)', marginTop: 8 }}>
                Sales / Retail Reports <span style={{ opacity: 0.6, fontWeight: 400 }}>· Store</span>
              </div>
              <div className={'doc-row' + (storeKey === '' ? ' sel' : '')} style={{ padding: '8px 14px' }}
                onClick={() => pickStore('')}>
                <div className="t" style={{ fontWeight: storeKey === '' ? 700 : 400 }}>
                  {store ? 'Report catalogue & sales overview' : 'Open Store reports'}</div>
                {!store && <div className="small" style={{ color: 'var(--muted)' }}>
                  Sign in to the Store to list its reports here</div>}
              </div>
              {(store || []).map((g) => (
                <div key={g.key}>
                  <div style={{ padding: '10px 14px 4px', fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', letterSpacing: '.5px' }}>
                    Store · {g.label} <span style={{ opacity: 0.6 }}>({g.reports.length})</span>
                  </div>
                  {g.reports.map((r) => (
                    <div key={r.key} className={'doc-row' + (storeKey === r.key ? ' sel' : '')}
                      style={{ padding: '8px 14px' }} onClick={() => pickStore(r.key)}
                      title={r.unavailable ? 'Listed for completeness — the Store has no record for this' : undefined}>
                      <div className="t" style={{ fontWeight: storeKey === r.key ? 700 : 400, opacity: r.unavailable ? 0.55 : 1 }}>{r.label}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </Sidebar>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {storeKey !== null ? (
          <div className="posframe">
            {/* `?wh=` blank clears any one-warehouse scope the Store frame left in
                the shop's session: from Central, every store's figures. */}
            <iframe key={storeKey} src={'/pos/reports/' + (storeKey ? 'r/' + storeKey : '') + '?wh='}
              title="Store — Sales / Retail Reports" />
          </div>
        ) : <>
        <AskBar value={ask} onChange={setAsk} onAsk={runAsk} busy={asking}
          engine={askMeta?.engine} />
        {asked && <AskReading read={asked} onDismiss={dismissReading} />}
        {/* Examples until the first question — a blank box teaches nobody what it
            will accept, and the Tamil ones are the only signal that it does. */}
        {!asked && !ask && (askMeta?.examples || []).length > 0 && (
          <div className="askegs">
            <span className="small">Try:</span>
            {askMeta.examples.map((e) => (
              <button key={e.q} className="askeg" title={e.note}
                onClick={() => { setAsk(e.q); runAsk(e.q) }}>{e.q}</button>
            ))}
          </div>
        )}
        {rep ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', padding: '14px var(--gutter)', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', gap: 8 }}>
              <h2 style={{ margin: 0 }}>{entry?.name}</h2>
              <div style={{ marginLeft: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {Object.entries(rep.totals).map(([k, v]) => (
                  <span key={k} className="small">{k.replace(/_/g, ' ')}: <b style={{ color: 'var(--text)' }}>{fmt(v)}</b></span>
                ))}
              </div>
              <div className="spacer" style={{ flex: 1 }} />
              <SearchBox value={q} onChange={setQ} placeholder="Search these rows…" style={{ width: 200 }} />
              {/* Only the filters this report declares — see services/reports.run.
                  Behind the same ⛭ control every other screen uses, so a report
                  with a date range and a list with a status scope are the same
                  gesture. Reports with no filters simply don't show the button. */}
              {dateParams.length > 0 && (
                <FilterButton open={filtersOpen} onToggle={() => setFiltersOpen((o) => !o)}
                  active={Object.keys(active()).length} />
              )}
              {/* the export carries the same filters, so it can't quietly hand back
                  a different set of rows than the one on screen.

                  Once rows have been narrowed after the report ran, the server
                  cannot reproduce them from filters alone — asking it would return
                  the wider set under the same button. So a narrowed result is
                  written from the rows on screen instead. */}
              {asked?.narrowed?.length ? (
                <button className="btn" onClick={() => downloadCsv(`${key}.csv`, toCsv(rep.columns, rep.rows, rep.totals))}
                  title="Download exactly these rows, including the narrowing applied after the report ran">
                  Export CSV</button>
              ) : (
                <a className="btn" href={api.reportCsvUrl(key, active())} target="_blank"
                  rel="noreferrer" title="Download exactly these rows, with these filters">Export CSV</a>
              )}
            </div>
            {dateParams.length > 0 && (
              <div style={{ padding: '0 var(--gutter)' }}>
                <FilterPanel open={filtersOpen} active={Object.keys(active()).length}
                  onClear={() => { setFilters({}); setAskRep(null) }}
                  hint={`This report accepts: ${dateParams.map((p) => PARAM_LABEL[p]).join(', ')}`}>
                  {dateParams.map((p) => (
                    <DateField key={p} label={PARAM_LABEL[p]} width={150}
                      value={filters[p] || ''} onChange={(v) => setFilter(p, v)} />
                  ))}
                </FilterPanel>
              </div>
            )}
            <div style={{ flex: 1, overflow: 'auto', padding: '0 var(--gutter) var(--gutter)' }}>
              {rep.note && (
                <div className="small" style={{ padding: '10px 0 2px', color: 'var(--muted)' }}>
                  ⓘ {rep.note}
                </div>
              )}
              <div className="small" style={{ padding: '8px 0', color: 'var(--muted)' }}>
                {busy ? 'running…' : <>{rows.length} of {rep.rows.length} rows{q ? ` matching “${q}”` : ''}</>}</div>
              <div className="tablewrap">
              <table className="items">
                <thead><tr>{rep.columns.map(c => <th key={c} style={{ textAlign: typeof rep.rows[0]?.[c] === 'number' ? 'right' : 'left' }}>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
                <tbody>{repPage.slice.map((row, i) => (
                  <tr key={i}>{rep.columns.map(c => (
                    <td key={c} className={typeof row[c] === 'number' ? 'mono' : ''} style={{ textAlign: typeof row[c] === 'number' ? 'right' : 'left' }}>
                      {typeof row[c] === 'number' ? fmt(row[c]) : (row[c] || '')}</td>
                  ))}</tr>
                ))}</tbody>
              </table>
              </div>
              {rep.rows.length === 0 && <p className="empty" style={{ marginTop: 40 }}>No data yet.</p>}
            </div>
            {/* the CSV export takes the WHOLE report, not the page — a download
                that silently stopped at row 100 would be the worst kind of wrong */}
            <Pager {...repPage} noun="row" />
          </>
        ) : asked && !asked.report_key ? (
          <div className="empty" style={{ marginTop: 60 }}>
            No report answers that question.<br />
            <span className="small">Pick one from the list on the left.</span>
          </div>
        ) : rq.error && !busy ? (
          // Said, rather than "Loading report…" for ever, which is what a
          // failed read used to leave behind.
          <div className="empty" style={{ marginTop: 60 }}>
            The report could not be read: {rq.error.detail || rq.error.message}<br />
            <button className="btn" style={{ marginTop: 10 }} onClick={load}>Try again</button>
          </div>
        ) : <div className="empty">Loading report…</div>}
        </>}
      </div>
    </div>
  )
}

// ---------- vision settings modal ----------
function VisionSettings({ onClose, onChanged, toast }) {
  const [st, setSt] = useState(null)
  const [key, setKey] = useState('')
  const [models, setModels] = useState([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.getSettings().then((s) => {
      setSt(s)
      if (s.has_key) api.listModels().then((r) => { if (r.ok) setModels(r.models) })
    })
  }, [])

  const activate = async () => {
    if (!key.trim()) { toast('Paste your Anthropic API key first', 'err'); return }
    setBusy(true)
    try {
      const r = await api.setVisionKey(key.trim(), null)
      if (!r.ok) { toast(r.message || 'Could not activate', 'err'); setBusy(false); return }
      if (r.models) setModels(r.models)
      toast(r.verified ? '👁 Vision on · ' + (r.chosen_model || '') : '👁 Vision on (' + r.message + ')', 'ok')
      setKey(''); setSt(r); onChanged && onChanged()
    } catch (e) { toast('Failed: ' + (e.detail || e.message), 'err') }
    setBusy(false)
  }
  const changeModel = async (m) => {
    const r = await api.setModel(m); setSt(r); onChanged && onChanged()
    toast('Model set to ' + m, 'ok')
  }
  const turnOff = async () => {
    setBusy(true)
    const r = await api.turnOffVision(); setSt(r); setModels([]); onChanged && onChanged()
    toast('Vision turned off — uploads use offline OCR', 'ok'); setBusy(false)
  }

  const on = st?.vision_enabled
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(11,61,46,.4)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: 540, maxWidth: 'calc(100vw - 32px)', background: 'var(--panel)', border: '1px solid var(--line)',
        borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-3)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>👁 Vision extraction</h2>
          <div className="spacer" style={{ flex: 1 }} />
          <button className="btn" style={{ padding: '2px 9px' }} onClick={onClose}>×</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0',
          padding: '10px 12px', borderRadius: 8,
          background: on ? 'var(--ok-bg)' : 'var(--panel-2)', border: '1px solid ' + (on ? 'var(--ok-line)' : 'var(--line)') }}>
          <span style={{ fontSize: 20 }}>{on ? '🟢' : '⚪'}</span>
          <div>
            <div style={{ fontWeight: 600 }}>{on ? 'Vision mode is ON' : 'Vision mode is OFF'}</div>
            <div className="small">{on
              ? `key ${st.key_masked} · model ${st.model}`
              : `new uploads currently use ${st?.active_live_provider || 'offline OCR'}`}</div>
          </div>
        </div>

        <div className="field" style={{ marginBottom: 10 }}>
          <label>Anthropic API key</label>
          <input type="password" value={key} placeholder={on ? '•••• stored — paste a new key to replace' : 'sk-ant-...'}
            onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        </div>
        {on && (
          <div className="field" style={{ marginBottom: 14 }}>
            <label>Model {models.length ? `(${models.length} available on your key)` : ''}</label>
            {models.length ? (
              <select value={st.model || ''} onChange={(e) => changeModel(e.target.value)}
                style={{ width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 7, padding: '8px' }}>
                {!models.find(m => m.id === st.model) && st.model && <option value={st.model}>{st.model} (current)</option>}
                {models.map(m => <option key={m.id} value={m.id}>{m.display_name} — {m.id}</option>)}
              </select>
            ) : (
              <input value={st.model || ''} disabled />
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn primary" disabled={busy} onClick={activate}>
            {busy ? 'Checking…' : 'Activate vision'}</button>
          {on && <button className="btn" disabled={busy} onClick={turnOff}>Turn off</button>}
          <div className="spacer" style={{ flex: 1 }} />
        </div>
      </div>
    </div>
  )
}

// ---------- scanning overlay (shown while an upload is being extracted) ----------
function ScanningOverlay({ url, name, vision }) {
  return (
    <div className="scan-overlay">
      <div className="scan-frame">
        {url
          ? <img src={url} alt={name} />
          : <div className="scan-placeholder">{name}</div>}
        <div className="scan-tint" />
        <div className="scan-line" />
      </div>
      <div className="scan-cap"><span className="scan-dot" />
        {vision ? 'Reading invoice with vision' : 'Scanning invoice (OCR)'}<span className="scan-ellipsis" /></div>
      <div className="scan-sub">{name} · extracting supplier, line items and totals…</div>
    </div>
  )
}

// ---------- LR Entry form (one consignment, keyed in by hand) ----------
//
// Mirrors the warehouse Transport Entry screen field for field: the left column
// is the consignment as it travelled, the right is the paperwork against it and
// where the bundles land. Importing a register page is still the fast way in —
// this is for the consignment that arrives with no page to photograph, and for
// correcting one that did.
//
//: How long goods are bought to stand before they are expected to have moved.
//: It is a house policy rather than a fact about any one consignment, so it
//: arrives filled in and is changed on the deliveries that differ, not typed on
//: the ninety-nine that do not. Left blank it was simply never recorded, and the
//: Item Locator's stock age then had nothing to call late. The server carries
//: the same default for rows that never pass through this form — see
//: models.LREntry.stock_holding_days.
const DEFAULT_HOLDING_DAYS = 90

// [key, label, type, opts]. `req` marks the boxes the server also enforces
// (REQUIRED_MANUAL in routers/lr.py); `list` names a master dropdown, `src` a
// master with its own table. combo = dropdown you can also type a new value into.
//
// NOTE: this array is EVALUATED when the module loads, so anything interpolated
// into it must already be declared above — a `const` further down the file is in
// its temporal dead zone here, and the ReferenceError takes the whole bundle
// with it. A blank page, not a broken form.
const LR_FORM_LEFT = [
  // First, because it is first in the business chain: goods arrive against an
  // order. Only confirmed orders are offered — see the `po` branch in LRField.
  ['purchase_order_id', 'Purchase Order', 'po', { req: 1, wide: 1 }],
  ['lr_mode', 'LR Mode', 'select', { req: 1, list: 'lr_mode' }],
  ['lr_no', 'LR No', 'text', { req: 1 }],
  ['lr_date', 'LR Date', 'date', { req: 1 }],
  ['recv_date', 'Received Date', 'date', {}],
  ['supplier_name', 'Supplier', 'combo', { req: 1, src: 'suppliers', wide: 1 }],
  ['agent', 'Agent / Commission', 'combo', { req: 1, src: 'agents' }],
  ['agent_commission', 'Commission %', 'num', {}],
  ['transport', 'Transport', 'combo', { src: 'transports', wide: 1 }],
  ['auto_transfer_location', 'Auto transfer Location', 'select', { list: 'auto_transfer_location' }],
  ['purchase_manager', 'Purchase Manager', 'combo', { list: 'purchase_manager' }],
  ['stock_holding_days', 'Stock Holding Period (days)', 'num',
   { hint: `${DEFAULT_HOLDING_DAYS} days unless this delivery says otherwise` }],
  ['additional_margin', 'Additional Margin', 'num', {}],
  ['bundle', 'No Of Bundles', 'num', { req: 1 }],
  ['boxes', 'No Of Boxes', 'num', { req: 1 }],
  ['qty', 'No Of Pieces', 'num', { req: 1 }],
  ['amount', 'Goods Value', 'num', {}],
]
// The reference screen also carried Company, Bundle Rack, Section, Remark, Due
// Date, Pay Mode, PackageSlip No/Date, Actual & Charged Weight, From/Receiving
// City, Loading Charge and Cash/Cheque. Every one came back empty on every
// consignment Essa receives, so they were removed outright rather than kept as
// boxes nobody fills.
const LR_FORM_RIGHT = [
  ['lr_entry_date', 'LR Entry Date', 'date', { req: 1 }],
  ['lr_entry_no', 'LR Entry No', 'ro', {}],
  ['inv_no', 'Invoice No', 'text', {}],
  ['inv_date', 'Inv Date', 'date', {}],
  ['freight_amount', 'Freight Charge', 'charge', { flag: 'freight_applicable' }],
  // the G. TOTAL at the foot of the LR — freight plus L.R. charge, H.C., S.T.
  // charge and the rest. Read off the page on import; typed here when the
  // consignment arrives with no LR copy to photograph.
  ['freight_total', 'Total Charges', 'num', {}],
  // ours, not on their form: how the freight actually settled.
  ['paid_topay', 'Paid / ToPay', 'select', { fixed: ['TOPAY', 'PAID', 'NO'] }],
  ['item', 'Item', 'text', { wide: 1 }],
]
const LR_FORM_KEYS = [...LR_FORM_LEFT, ...LR_FORM_RIGHT]
  .filter(([, , t]) => t !== 'ro').map(([k]) => k)
  .concat('freight_applicable')

function LRField({ spec, form, set, opts, lists, flagged }) {
  const [key, label, type, o = {}] = spec
  const v = form[key] ?? ''
  const style = o.wide ? { gridColumn: '1 / -1' } : null
  const choices = o.fixed || (o.list ? (opts[o.list] || []) : (lists[o.src] || []))
  const req = o.req ? <span style={{ color: 'var(--danger)' }}> *</span> : null
  // Same `.field.flag` + `.flagnote` the invoice review uses, so a field the
  // machine is unsure of looks identical on both screens. Only the purchase
  // order form passes this today; the LR form leaves it undefined and the class
  // never appears.
  const cls = 'field' + (flagged ? ' flag' : '')
  const flagnote = flagged
    ? <div className="flagnote">⚠ needs review</div> : null

  if (type === 'po') {
    // Only confirmed orders are listed, because only those may have goods booked
    // in against them — the server enforces the same rule, so this can never
    // offer a choice that would then be refused on save.
    //
    // An order already cited but no longer in the open list (it was cancelled,
    // or belongs to another warehouse) is added back as a disabled row. Dropping
    // it silently would make the box look empty on a row that plainly has one,
    // and the first thing anybody would do is pick a different order.
    const open = lists.purchase_orders || []
    const missing = v && !open.some((p) => String(p.id) === String(v))
    return (
      <div className={cls} style={style}>
        <label>{label}{req}</label>
        <select value={v} onChange={(e) => set(key, e.target.value)}>
          <option value="">— select the order these goods are against —</option>
          {missing && <option value={v} disabled>
            order #{v} — not open here</option>}
          {open.map((p) => (
            <option key={p.id} value={p.id}>
              {p.po_no} · {p.supplier_name || 'no supplier'}
              {p.item ? ' · ' + p.item : ''}
              {p.total ? ' · ₹' + Number(p.total).toLocaleString('en-IN') : ''}
            </option>
          ))}
        </select>
        <div className="small" style={{ marginTop: 3 }}>
          {open.length
            ? 'Confirmed orders only. Raise or confirm one in Purchase Orders.'
            : 'No confirmed orders yet — raise one in Purchase Orders first.'}
        </div>
      </div>
    )
  }
  if (type === 'charge') {
    // checkbox + amount, as on their form. The box says the charge APPLIES at
    // all, which a zero amount can't express — nothing quoted yet vs quoted nil.
    return (
      <div className={cls} style={style}>
        <label>{label}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* unticking clears the amount: an amount saved under an unticked box
              would claim a charge the entry says does not apply */}
          <input type="checkbox" style={{ width: 16, flex: '0 0 auto' }}
            checked={!!form[o.flag]}
            onChange={(e) => { set(o.flag, e.target.checked); if (!e.target.checked) set(key, '') }} />
          <input value={v} inputMode="decimal" placeholder="0.00"
            disabled={!form[o.flag]}
            title={form[o.flag] ? '' : 'Tick the box to record this charge'}
            onChange={(e) => set(key, e.target.value)} />
        </div>
      </div>
    )
  }
  return (
    <div className={cls} style={style}>
      <label>{label}{req}</label>
      {type === 'ro'
        ? <input value={v || '— on save —'} disabled title="Allocated by the system when the entry is saved" />
        : type === 'area'
          ? <input value={v} onChange={(e) => set(key, e.target.value)} placeholder="anything worth noting about this consignment" />
          : type === 'select'
            ? <select value={v} onChange={(e) => set(key, e.target.value)}>
                <option value=""></option>
                {choices.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            : type === 'combo'
              ? <>
                  <input value={v} list={'lrl-' + key} onChange={(e) => set(key, e.target.value)}
                    placeholder="pick one, or type a new name" />
                  <datalist id={'lrl-' + key}>{choices.map((c) => <option key={c} value={c} />)}</datalist>
                </>
              : type === 'date'
                /* a saved row may hold a date read off a register page in the
                   page's own format — DateField shows what it can and never
                   discards what it can't */
                ? <DateField inline value={v} onChange={(x) => set(key, x)} />
                : <input value={v} type="text"
                    inputMode={type === 'num' ? 'decimal' : undefined}
                    onChange={(e) => set(key, e.target.value)} />}
      {flagnote}
      {o.hint && !flagged && <div className="small" style={{ marginTop: 3 }}>{o.hint}</div>}
    </div>
  )
}

const today = () => new Date().toISOString().slice(0, 10)
// A fresh form: the two dates default to today, exactly as their screen does.
const blankLR = () => ({ lr_entry_date: today(), lr_date: today(), recv_date: today(),
  auto_transfer_location: 'NONE', freight_applicable: false,
  stock_holding_days: DEFAULT_HOLDING_DAYS })

function LREntryForm({ editing, opts, lists, onDone, onCancel, toast, reloadOpts }) {
  const [form, setForm] = useState(() => editing ? { ...editing } : blankLR())
  const [busy, setBusy] = useState(false)
  const [pendingFiles, setPendingFiles] = useState([])   // queued before first save
  const [attType, setAttType] = useState('')
  const [atts, setAtts] = useState(editing?.attachments || [])
  const fileRef = useRef(null)
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  useEffect(() => {
    setForm(editing ? { ...editing } : blankLR())
    setAtts(editing?.attachments || [])
    setPendingFiles([])
  }, [editing])

  const queueFile = (e) => {
    const f = e.target.files[0]; if (!f) return
    setPendingFiles((p) => [...p, { file: f, doc_type: attType || 'Other' }])
    e.target.value = ''
  }
  const dropAttachment = async (a) => {
    await api.lrDeleteAttachment(a.id)
    setAtts((x) => x.filter((y) => y.id !== a.id))
  }
  // Files picked before the entry exists have nowhere to attach yet, so they
  // ride along in state and go up the moment it has an id.
  const flushFiles = async (id) => {
    const done = []
    for (const p of pendingFiles) {
      try { done.push(await api.lrAddAttachment(id, p.file, p.doc_type)) }
      catch { toast(`Could not attach ${p.file.name}`, 'err') }
    }
    setPendingFiles([])
    return done
  }

  const submit = async (next) => {
    setBusy(true)
    try {
      const body = {}
      LR_FORM_KEYS.forEach((k) => { if (form[k] !== undefined) body[k] = form[k] })
      const saved = editing ? await api.lrUpdate(editing.id, body) : await api.lrCreate(body)
      const uploaded = await flushFiles(saved.id)
      if (saved.duplicate_of)
        toast(`Saved ${saved.lr_entry_no} — but LR/Invoice already exists on entry #${saved.duplicate_of.join(', #')}. Check it isn't a double entry.`, 'err')
      else
        toast(`✓ ${editing ? 'Updated' : 'Saved'} ${saved.lr_entry_no}${uploaded.length ? ` · ${uploaded.length} file(s) attached` : ''}`, 'ok')
      reloadOpts()
      if (next) {
        // Save&Next: keep the header the operator would only retype — same lorry,
        // same supplier, same day — and clear what is per-consignment.
        const keep = ['lr_mode', 'lr_entry_date', 'lr_date', 'recv_date',
          'supplier_name', 'agent', 'transport',
          'auto_transfer_location', 'purchase_manager']
        const carried = blankLR()
        keep.forEach((k) => { if (form[k]) carried[k] = form[k] })
        setForm(carried); setAtts([])
        onDone(saved, true)
      } else { onDone(saved, false) }
    } catch (e) {
      toast(e.detail || 'Save failed', 'err')
    }
    setBusy(false)
  }

  return (
    <div className="section">
      <h4>{editing ? `Edit entry ${editing.lr_entry_no || '#' + editing.id}` : 'New transport entry'}
        <button className="h4btn" onClick={onCancel}>✕ close</button></h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: '0 28px' }}>
        {[LR_FORM_LEFT, LR_FORM_RIGHT].map((col, ci) => (
          <div key={ci} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 12px', alignContent: 'start' }}>
            {col.map((spec) => <LRField key={spec[0]} spec={spec} form={form} set={set} opts={opts} lists={lists} />)}
          </div>
        ))}
      </div>

      <h4 style={{ marginTop: 22 }}>File attachments</h4>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ width: 190 }}><label>Type</label>
          <select value={attType} onChange={(e) => setAttType(e.target.value)}>
            <option value="">Type</option>
            {(opts.attachment_type || []).map((t) => <option key={t} value={t}>{t}</option>)}
          </select></div>
        <button className="btn" onClick={() => fileRef.current?.click()}>＋ Add file</button>
        <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={queueFile} />
      </div>
      {(atts.length > 0 || pendingFiles.length > 0) && (
        <table className="items" style={{ marginTop: 10, maxWidth: 620 }}>
          <thead><tr><th>File</th><th style={{ width: 150 }}>Type</th><th style={{ width: 90 }}>Action</th></tr></thead>
          <tbody>
            {atts.map((a) => (
              <tr key={a.id}><td><a href={a.url} target="_blank" rel="noreferrer">{a.filename}</a></td>
                <td>{a.doc_type}</td>
                <td><button className="btn" style={{ padding: '2px 7px' }} onClick={() => dropAttachment(a)}>×</button></td></tr>
            ))}
            {pendingFiles.map((p, i) => (
              <tr key={'p' + i} style={{ opacity: 0.7 }}>
                <td>{p.file.name} <span className="small">(uploads on save)</span></td>
                <td>{p.doc_type}</td>
                <td><button className="btn" style={{ padding: '2px 7px' }}
                  onClick={() => setPendingFiles((x) => x.filter((_, j) => j !== i))}>×</button></td></tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <button className="btn primary" disabled={busy} onClick={() => submit(false)}>
          {busy ? 'Saving…' : editing ? '💾 Update' : '💾 Save'}</button>
        {!editing && <button className="btn" disabled={busy} onClick={() => submit(true)}
          title="Save this one and start another, keeping the supplier / lorry / dates">💾 Save &amp; Next</button>}
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// ---------- LR search ----------
//: [key, label, width, which master list stands behind it]. Supplier and
//: Transport are the same two masters the entry form offers, and they have to be
//: offered here for the same reason: a register searched for a supplier spelled
//: the other way finds nothing and says "no rows", which reads as "no such
//: consignment" rather than "not how it is spelled in here". `q` has no list —
//: it searches four different columns at once and no single master covers it.
const LR_SEARCH_FIELDS = [
  ['q', 'LR / Invoice / Entry no / item', 240, null],
  ['supplier', 'Supplier', 160, 'suppliers'],
  ['transport', 'Transport', 130, 'transports'],
]
function LRSearchPanel({ onResults, onClear, toast, lists }) {
  const [f, setF] = useState({})
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }))
  const run = async () => {
    try { onResults(await api.lrSearch(f)) }
    catch { toast('Search failed', 'err') }
  }
  const clear = () => { setF({}); onClear() }
  // "all" is the absence of a filter, not a filter — counting it would show 2
  // active on a panel nobody has touched
  const activeCount = Object.entries(f)
    .filter(([, v]) => v && v !== 'all').length
  return (
    <Section id="lr.search" title="Search the register"
      summary={activeCount ? `${activeCount} filter(s) set` : 'no filters set'}>
      <FilterPanel open active={activeCount} onClear={clear} onApply={run}
        hint={activeCount
          ? `${activeCount} filter(s) — Apply, or press Enter in any box`
          : 'Set any of these, then Apply. Enter runs it too.'}>
        {LR_SEARCH_FIELDS.map(([k, label, w, src]) => {
          const choices = (src && lists?.[src]) || []
          return (
            <div key={k} className="field" style={{ width: w }}><label>{label}</label>
              {/* a combo, not a select: the register holds names typed off a
                  register page long before anybody made a master of them, so the
                  list has to guide without refusing what is not on it */}
              <input value={f[k] || ''} list={choices.length ? 'lrs-' + k : undefined}
                placeholder={choices.length ? 'pick one, or type' : undefined}
                onChange={(e) => set(k, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') run() }} />
              {choices.length > 0 && (
                <datalist id={'lrs-' + k}>
                  {choices.map((c) => <option key={c} value={c} />)}
                </datalist>
              )}
            </div>
          )
        })}
        <DateField label="Received from" width={140} value={f.date_from || ''}
          onChange={(v) => set('date_from', v)} />
        <DateField label="to" width={140} value={f.date_to || ''}
          onChange={(v) => set('date_to', v)} />
        <div className="field" style={{ width: 120 }}><label>Received</label>
          <select value={f.received || 'all'} onChange={(e) => set('received', e.target.value)}
            title="Whether the warehouse has taken the consignment in">
            <option value="all">All</option><option value="pending">Not received</option>
            <option value="received">Received</option></select></div>
        <div className="field" style={{ width: 120 }}><label>Invoice</label>
          <select value={f.status || 'all'} onChange={(e) => set('status', e.target.value)}
            title="Whether an invoice has been matched to the consignment">
            <option value="all">All</option><option value="linked">Linked</option>
            <option value="unlinked">Not linked</option></select></div>
      </FilterPanel>
    </Section>
  )
}

// ---------- LR Entry (upload register image → OCR grid → save) ----------
// Columns in the import grid — exactly what vision returns (lr.LR_FIELDS), so a
// register page that carries a column can be reviewed before it is saved.
const LR_COLS = [
  ['recv_date', 'Recv Date', 100], ['transport', 'Transport', 110],
  ['lr_mode', 'Mode', 100], ['bundle', 'Bundle', 60], ['boxes', 'Boxes', 55],
  ['lr_no', 'LR No', 110], ['lr_date', 'LR Date', 100], ['supplier_name', 'Supplier', 180],
  ['agent', 'Agent', 120], ['inv_no', 'Inv No', 80], ['inv_date', 'Inv Date', 100],
  ['qty', 'Pieces', 60], ['amount', 'Goods Value', 95],
  ['paid_topay', 'Paid/ToPay', 80], ['freight_amount', 'Freight', 70],
  // freight is the first line of a transporter's bill, not the bill. `charges`
  // is the block under it (H.C., S.T. charge, …) and `freight_total` the G.
  // TOTAL printed at its foot — what the lorry is actually paid.
  ['freight_charges', 'Charges', 130], ['freight_total', 'Total Charges', 95],
  ['item', 'Item', 110],
]
//: read off the page and totalled, never typed in this grid
const LR_READONLY_COLS = new Set(['freight_charges'])
//: which of those are dates — picked from a calendar, never retyped
const LR_DATE_COLS = new Set(['recv_date', 'lr_date', 'inv_date'])
// The SAVED register is laid out to fit one screen rather than scroll sideways.
// Two devices get it there without dropping anything:
//   * `sub` puts a second, muted line in the same cell, so a value and its date
//     (LR no + LR date, invoice + invoice date) share one column instead of two.
//   * `pair` prints two counts as "2 / 1" in one cell (bundles / boxes).
// `num` right-aligns figures — a register exists to be read down its columns,
// and ragged left-aligned numbers cannot be compared at a glance.
const LR_REG_COLS = [
  { k: 'lr_entry_no', h: 'Entry No', w: 88, mono: 1 },
  { k: 'recv_date', h: 'Recv Date', w: 86, mono: 1 },
  { k: 'transport', h: 'Transport', w: 132, sub: 'lr_mode' },
  { k: 'supplier_name', h: 'Supplier', w: 168, sub: 'agent' },
  { k: 'lr_no', h: 'LR No', w: 112, sub: 'lr_date', mono: 1 },
  { k: 'inv_no', h: 'Invoice', w: 112, sub: 'inv_date', mono: 1 },
  // The receipt raised against this consignment. Next to the invoice it
  // belongs to, because the two are quoted together when a delivery is
  // queried — and blank until the goods are actually received, which is
  // itself the answer to "has this come in yet?".
  { k: 'grn_no', h: 'GRN No', w: 116, mono: 1 },
  { k: 'item', h: 'Item', w: 92 },
  { k: 'bundle', h: 'Bdl / Box', w: 68, num: 1, pair: 'boxes' },
  { k: 'qty', h: 'Pieces', w: 58, num: 1 },
  { k: 'amount', h: 'Goods Value', w: 88, num: 1 },
  { k: 'paid_topay', h: 'Paid/ToPay', w: 84, edit: 1 },
  { k: 'freight_amount', h: 'Freight', w: 76, num: 1, edit: 1 },
  // the transporter's G. TOTAL — freight plus the charge lines under it. Given
  // its own column rather than replacing freight, because a bill of 455 made of
  // 425 haulage and 30 sundries is two facts and a payment run needs both.
  { k: 'freight_total', h: 'Charges', w: 82, num: 1, edit: 1 },
  { k: 'purchase_manager', h: 'Purch Mgr', w: 92 },
]
// freight settlement — completed or corrected when the lorry actually delivers,
// so these stay editable on already-saved rows
const LR_SETTLE_COLS = LR_REG_COLS.filter((c) => c.edit).map((c) => c.k)

// ==========================================================================
//  Purchase Orders — what we asked for, before anything arrived
//  ------------------------------------------------------------------------
//  The first document in the chain, and the one this system did not have: intake
//  began at the supplier's invoice, so nothing could say what was ORDERED.
//
//  The screen is shaped by the lifecycle rather than by the fields. An order is
//  drafted, sent, agreed, and only then may goods be booked in against it — so
//  the status is the first thing on every row, the actions available change with
//  it, and a confirmed order shows as read-only rather than as a form with a
//  save button that would be refused. See services/purchase_orders.py.
// ==========================================================================

//: Header fields, in the order the buying office fills them. Same two-column
//: split the LR form uses, and the same field types, so the two screens are one
//: thing to learn.
const PO_FORM_LEFT = [
  ['po_date', 'PO Date', 'date', { req: 1 }],
  ['supplier_name', 'Supplier', 'combo', { req: 1, src: 'suppliers', wide: 1 }],
  ['brand', 'Brand', 'text', {}],
  ['item', 'Item', 'text', { wide: 1 }],
  ['purchaser', 'Purchaser', 'combo', { list: 'purchase_manager' }],
  ['agent', 'Agent', 'combo', { src: 'agents' }],
]
const PO_FORM_RIGHT = [
  ['po_no', 'PO No', 'ro', {}],
  ['company', 'Company', 'text', { wide: 1 }],
  ['place', 'Place', 'text', {}],
  ['transport', 'Transport', 'combo', { src: 'transports' }],
  ['discount_pct', 'Discount %', 'num', { hint: 'comes off the line total' }],
  ['notes', 'Notes', 'area', { wide: 1 }],
]
const PO_FORM_KEYS = [...PO_FORM_LEFT, ...PO_FORM_RIGHT]
  .filter(([, , t]) => t !== 'ro').map(([k]) => k)

// The same form, described the way voicefill.js wants it — so one sentence can
// fill several boxes ("supplier Matoshree brand ESSA item frocks discount 5").
//
// BUILT FROM THE FORM'S OWN SPECS, never written out again. That is the whole
// mechanism voicefill.js relies on: the labels are the grammar, so a field
// renamed on the form is renamed in the grammar at the same moment, and a field
// added is dictatable the moment it exists.
//
// Three kinds are left out, each for a reason:
//   * `ro` — the PO number is allocated on save; there is nothing to dictate.
//   * `date` — picked, never dictated. The masters do the same, and for the same
//     reason: a misheard date is a plausible wrong date, which is the worst kind.
//   * `po` — the order picker on the LR form, which is an id, not a phrase.
// A `combo` becomes `text`, not `select`: its list is a suggestion, and a select
// whose value is not in the list is DROPPED — which would silently discard a new
// supplier's name, the very thing a combo exists to allow.
const poDictateDef = (opts, lists) => ({
  key: 'purchase_order',
  label: 'Purchase Order',
  plainForm: true,
  groups: [{
    title: 'Order',
    fields: [...PO_FORM_LEFT, ...PO_FORM_RIGHT]
      .filter(([, , type]) => !['ro', 'date', 'po'].includes(type))
      .map(([key, label, type, o = {}]) => {
        const field = { key, label, type: type === 'combo' || type === 'area' ? 'text' : type }
        const choices = o.fixed || (o.list ? (opts[o.list] || []) : (lists[o.src] || []))
        if (type === 'select' && choices.length) field.options = choices
        return field
      }),
  }],
})

//: The line grid. `amount` is derived from qty x rate as you type, but stays
//: editable — a buyer who types an agreed line total has agreed that total, and
//: the server keeps whatever is actually sent.
const PO_LINE_COLS = [
  { k: 'particulars', h: 'Particulars', w: 220 },
  { k: 'size', h: 'Size', w: 110 },
  { k: 'qty', h: 'Qty', w: 70, num: 1 },
  { k: 'uom', h: 'UOM', w: 66 },
  { k: 'rate', h: 'Rate', w: 84, num: 1 },
  { k: 'amount', h: 'Amount', w: 96, num: 1 },
]

const blankPOLine = () => ({ particulars: '', size: '', qty: '', uom: '', rate: '', amount: '' })
const blankPO = () => ({ po_date: today(), lines: [blankPOLine()] })

//: What each state means, said in words. The badge carries the colour; this
//: carries the sentence, because "pending" alone does not tell a new buyer
//: whether they are waiting on themselves or on the supplier.
const PO_STATUS_HINT = {
  draft: 'Being written. Not sent to anyone yet.',
  pending: 'Sent to the supplier, awaiting their confirmation.',
  confirmed: 'Agreed. Goods may now be booked in against it.',
  cancelled: 'Called off. Nothing can be received against it.',
}

function POLineGrid({ lines, setLines, readOnly, flags = {} }) {
  const set = (i, k, v) => setLines(lines.map((l, n) => {
    if (n !== i) return l
    const row = { ...l, [k]: v }
    // Keep the amount in step while the buyer is still typing qty and rate, but
    // never overwrite one they have typed themselves — hence only when the box
    // is empty or was itself derived.
    if (k === 'qty' || k === 'rate') {
      const q = parseFloat(k === 'qty' ? v : row.qty)
      const r = parseFloat(k === 'rate' ? v : row.rate)
      if (!isNaN(q) && !isNaN(r) && (!l.amount || l._derived)) {
        row.amount = String(Math.round(q * r * 100) / 100)
        row._derived = true
      }
    }
    if (k === 'amount') row._derived = false
    return row
  }))
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="items entry">
        <thead><tr>
          {PO_LINE_COLS.map((c) => <th key={c.k} style={{ width: c.w, textAlign: c.num ? 'right' : 'left' }}>{c.h}</th>)}
          {!readOnly && <th style={{ width: 34 }}></th>}
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              {PO_LINE_COLS.map((c) => {
                // Paths come from the server as `lines.<row>.<field>` — the same
                // dotted shape extraction/validate.py uses for invoice fields, so
                // one convention covers both review screens.
                const bad = !!flags[`lines.${i}.${c.k}`]
                return (
                  <td key={c.k} className={bad ? 'flagcell' : undefined}
                    title={bad ? 'This did not add up — check it against the page' : undefined}>
                    {readOnly
                      ? <span style={{ display: 'block', textAlign: c.num ? 'right' : 'left' }}>
                          {l[c.k] || <span className="small">—</span>}</span>
                      : <input value={l[c.k] ?? ''} inputMode={c.num ? 'decimal' : undefined}
                          style={{ textAlign: c.num ? 'right' : 'left' }}
                          onChange={(e) => set(i, c.k, e.target.value)} />}
                  </td>
                )
              })}
              {!readOnly && (
                <td>
                  {/* The last line is never removable — a grid with no rows has
                      nowhere to type, and "add a line" would be the only way back
                      into a form somebody is in the middle of. */}
                  <button className="rowdel" title="Remove this line"
                    disabled={lines.length < 2}
                    onClick={() => setLines(lines.filter((_, n) => n !== i))}>×</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <button className="btn" style={{ marginTop: 8 }}
          onClick={() => setLines([...lines, blankPOLine()])}>+ Add line</button>
      )}
    </div>
  )
}

// A form's starting values: a saved order, a reading off a photograph, or empty.
// One function so the three routes into this screen cannot drift — and so a
// field added to `blankPO` reaches an extracted order too.
const poInitial = (editing, extracted) => {
  if (editing) return { ...editing }
  if (extracted?.draft) return { ...blankPO(), ...extracted.draft,
    document_id: extracted.document_id, entry_source: 'import' }
  return blankPO()
}
const poInitialLines = (editing, extracted) => {
  const src = editing?.lines?.length ? editing.lines : extracted?.draft?.lines
  return src?.length ? src.map((l) => ({ ...l })) : [blankPOLine()]
}

function POForm({ editing, extracted, lists, opts, onDone, onCancel, toast }) {
  const [form, setForm] = useState(() => poInitial(editing, extracted))
  const [lines, setLines] = useState(() => poInitialLines(editing, extracted))
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  useEffect(() => {
    setForm(poInitial(editing, extracted))
    setLines(poInitialLines(editing, extracted))
  }, [editing, extracted])

  // What the reading was unsure of. Only ever set on an extracted order — a
  // hand-keyed one has nothing to be unsure about, and a form that flagged its
  // own boxes would be inventing doubt.
  const flags = extracted?.field_flags || {}
  const warnings = extracted?.warnings || []
  // Rebuilt when the dropdown vocabularies arrive, so a supplier added a moment
  // ago is a word the dictation knows.
  const dictateDef = useMemo(() => poDictateDef(opts, lists), [opts, lists])

  const readOnly = !!editing && editing.editable === false
  // §11: closing this tab with an order half typed asks first. Registered from
  // the FORM rather than the module, because the module is only holding work
  // while a form is open on it — a list of orders has nothing to lose.
  useUnsavedGuard('purchase_orders', !readOnly && (
    !!extracted                                   // a reading nobody has saved
    || (!editing && (lines.some((l) => l.particulars || l.qty || l.rate)
                     || !!form.supplier_name))))
  // Shown live rather than only after a save, because the discount is the figure
  // the office argues about and finding out what it came to on the next screen
  // is finding out too late.
  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0)
  const discount = subtotal * (parseFloat(form.discount_pct) || 0) / 100

  const save = async () => {
    setBusy(true)
    try {
      const body = {}
      PO_FORM_KEYS.forEach((k) => { if (form[k] !== undefined) body[k] = form[k] })
      // Pins the saved order to the page it was read off, so it can always be
      // checked against the paper. Only ever set on the extracted route.
      if (form.document_id) { body.document_id = form.document_id; body.entry_source = 'import' }
      body.lines = lines.map((l) => {
        const { _derived, ...rest } = l                      // eslint-disable-line no-unused-vars
        return rest
      })
      const saved = editing?.id ? await api.poUpdate(editing.id, body) : await api.poCreate(body)
      toast(editing?.id ? `${saved.po_no} saved` : `${saved.po_no} raised`, 'ok')
      onDone(saved)
    } catch (e) {
      toast(e.detail || 'Could not save the order', 'err')
    } finally { setBusy(false) }
  }

  return (
    <Section id="po-form"
      title={editing?.id ? `Order ${editing.po_no}`
        : extracted ? 'Review what was read' : 'New purchase order'}
      actions={<>
        {/* Dictation fills boxes; it never saves. A spoken sentence lands in the
            form and the person presses Save, exactly as the OCR path does — the
            same rule, because both are input methods and neither is a decision. */}
        {!readOnly && <MasterDictate def={dictateDef} data={form} toast={toast}
          onFills={(fills) => setForm((f) => {
            const next = { ...f }
            fills.forEach(({ field, value }) => { next[field.key] = value })
            return next
          })} />}
        {!readOnly && <button className="btn primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : extracted ? 'Confirm & save' : 'Save'}</button>}
        <button className="btn" onClick={onCancel}>Close</button>
      </>}>
      {extracted && (
        // The whole point of the OCR path is that this screen exists. Nothing has
        // been written yet — the banner says so outright, because a form that
        // arrives pre-filled reads as a saved record unless it says otherwise.
        <div className={'warnbox ' + (warnings.length ? '' : 'clean')} style={{ marginBottom: 16 }}>
          <h4>
            {warnings.length
              ? `${warnings.length} thing(s) to check before saving`
              : 'Read cleanly — check it and save'}
            <span className="small" style={{ float: 'right' }}>
              {extracted.provider === 'claude_vision' ? 'read by vision · confidence ' : ''}
              {extracted.provider === 'claude_vision'
                ? <b className={'conf ' + confClass(extracted.confidence)}>
                    {Math.round((extracted.confidence ?? 0) * 100)}%</b>
                : null}
            </span>
          </h4>
          <p className="small" style={{ marginTop: 4 }}>
            Nothing has been saved yet. Correct anything below, then press
            <b> Confirm &amp; save</b>.{extracted.note ? ' · ' + extracted.note : ''}
          </p>
          {warnings.length ? <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
        </div>
      )}
      {readOnly && (
        <div className="warnbox" style={{ marginBottom: 16 }}>
          <h4>This order is {editing.status} — it cannot be edited</h4>
          <p className="small">{PO_STATUS_HINT[editing.status]}
            {editing.status === 'confirmed' && ' To change it, cancel it and raise a replacement, so the change leaves a trail.'}</p>
        </div>
      )}
      {/* Same two-column grid the LR form uses — see LREntryForm. Repeated here
          rather than extracted, because pulling a shared layout wrapper out of a
          working screen is a change to that screen for no gain to it. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: '0 28px' }}>
        {[PO_FORM_LEFT, PO_FORM_RIGHT].map((col, ci) => (
          <div key={ci} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 12px', alignContent: 'start' }}>
            {col.map((spec) => <LRField key={spec[0]} spec={spec} form={form}
              set={readOnly ? () => {} : set} opts={opts} lists={lists}
              flagged={!!flags[spec[0]]} />)}
          </div>
        ))}
      </div>
      <h4 style={{ marginTop: 22 }}>Lines</h4>
      <POLineGrid lines={lines} setLines={setLines} readOnly={readOnly} flags={flags} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 28, marginTop: 14,
                    paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <div><span className="small">Subtotal</span><div style={{ textAlign: 'right' }}><b>{money(subtotal)}</b></div></div>
        {!!discount && <div><span className="small">Discount {form.discount_pct}%</span>
          <div style={{ textAlign: 'right' }}><b>− {money(discount)}</b></div></div>}
        <div><span className="small">Total</span><div style={{ textAlign: 'right', fontSize: 16 }}>
          <b>{money(subtotal - discount)}</b></div></div>
      </div>
    </Section>
  )
}

function PurchaseOrdersView({ toast }) {
  const [rows, setRows] = useState([])
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useState('')
  const [form, setForm] = useState(null)          // null = closed, {} = new, row = edit
  const [extracted, setExtracted] = useState(null)   // a reading awaiting review
  const [opts, setOpts] = useState({})
  const [lists, setLists] = useState({})
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)      // a page is being read
  const [canRead, setCanRead] = useState(null)       // null = not asked yet
  const fileRef = useRef(null)

  const refresh = useCallback(() => api.poList().then(setRows).catch(() => {}), [])
  useEffect(() => { refresh() }, [refresh])
  // Asked once, so the button can explain itself rather than fail on a press.
  useEffect(() => {
    api.poExtractStatus().then((s) => setCanRead(!!s.available)).catch(() => setCanRead(false))
  }, [])

  const readPage = async (file) => {
    if (!file) return
    setReading(true)
    try {
      const res = await api.poExtract(file)
      // Even a failed read opens the form: the person is standing there with the
      // page in their hand, and the fallback for "vision could not read this" is
      // to type it, not to be sent back to an empty screen. `note` says what
      // happened. This is §17's OCR-failure path.
      setExtracted(res)
      setForm({})
      if (res.provider === 'claude_vision') {
        toast(res.warnings?.length
          ? `Read — ${res.warnings.length} thing(s) to check`
          : 'Read cleanly — check it and save', res.warnings?.length ? 'warn' : 'ok')
      } else {
        toast(res.note || 'The page could not be read — key it in', 'warn')
      }
    } catch (e) {
      toast(e.detail || 'That file could not be uploaded', 'err')
    } finally {
      setReading(false)
      if (fileRef.current) fileRef.current.value = ''   // same file can be retried
    }
  }
  useEffect(() => {
    api.masterOptions().then(setOpts).catch(() => {})
    Promise.all([api.listSuppliers(), api.agents(), api.transports()])
      .then(([s, a, t]) => setLists({
        suppliers: s.map((x) => x.name).filter(Boolean),
        agents: a.map((x) => x.name).filter(Boolean),
        transports: t.map((x) => x.name).filter(Boolean),
      })).catch(() => {})
  }, [])

  const shown = rows
    .filter((r) => status === 'all' || r.status === status)
    .filter((r) => matches(r, query, ['po_no', 'supplier_name', 'item', 'brand', 'purchaser']))
  const page = usePaged(shown, 25)

  const openEdit = async (r) => {
    try { setForm(await api.poGet(r.id)) } catch { toast('Could not open that order', 'err') }
  }
  const move = async (r, to) => {
    setBusy(true)
    try {
      const saved = await api.poStatus(r.id, to)
      toast(`${saved.po_no} is now ${to}`, 'ok')
      refresh()
      if (form?.id === r.id) setForm(saved)
    } catch (e) { toast(e.detail || 'Could not change the status', 'err') }
    finally { setBusy(false) }
  }
  // Why an order may not be deleted, or null when it may. The same rule the
  // server keeps (services/purchase_orders.DELETABLE, and never an order a
  // consignment cites) — asked here so the icon can say so before anyone presses.
  const cannotDelete = (r) => (r.linked_lr_count
    ? `${r.linked_lr_count} consignment${r.linked_lr_count === 1 ? ' is' : 's are'} booked against ${r.po_no} — it cannot be deleted`
    : r.status === 'draft' || r.status === 'cancelled' ? null
      : `${r.po_no} is ${r.status} — cancel it first, so it is on record that it was called off`)
  const remove = async (e, r) => {
    e.stopPropagation()
    const why = cannotDelete(r)
    if (why) { toast(why, 'warn'); return }
    if (!window.confirm(r.status === 'draft'
      ? `Delete draft ${r.po_no}? This cannot be undone.`
      : `Delete cancelled order ${r.po_no}? It will be removed from the order book. This cannot be undone.`)) return
    try {
      await api.poDelete(r.id); toast(`${r.po_no} deleted`, 'ok')
      if (form?.id === r.id) setForm(null)
      refresh()
    } catch (err) { toast(err.detail || 'Could not delete it', 'err') }
  }

  const count = (s) => rows.filter((r) => r.status === s).length

  return (
    // `screen` pins the header band and scrolls the body under it — the same
    // structure every other single-column module uses. `main` would have been
    // wrong: it is a horizontal flex row, for the screens that put an image
    // beside their fields.
    <div className="screen">
      <div className="pagehead">
        <h2>Purchase Orders</h2>
        <span className="small pagesub">
          Goods are booked in against a confirmed order.</span>
        <div style={{ flex: 1 }} />
        {/* Two ways in, as the LR register has: photograph the page, or type it.
            `accept` covers both the desktop file picker and the phone, where
            the browser offers the camera among the image sources — no separate
            mobile control, and nothing to keep in step between two of them. */}
        <input ref={fileRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }}
          onChange={(e) => readPage(e.target.files?.[0])} />
        <button className="btn" disabled={reading || canRead === false}
          title={canRead === false
            ? 'Reading a photographed order needs the vision key — set it in Settings'
            : 'Photograph or upload an order and have it read'}
          onClick={() => fileRef.current?.click()}>
          {reading ? 'Reading…' : '📷 Read an order'}
        </button>
        <button className="btn primary" onClick={() => { setExtracted(null); setForm({}) }}>
          + New order</button>
      </div>
      <div className="screenbody">

        {form && (
          <POForm editing={form.id ? form : null} extracted={form.id ? null : extracted}
            lists={lists} opts={opts} toast={toast}
            onCancel={() => { setForm(null); setExtracted(null) }}
            onDone={(saved) => { refresh(); setExtracted(null); setForm(saved) }} />
        )}

        <Section id="po-list" title={`Order book · ${shown.length}`}>
          <div className="toolbar" style={{ gap: 10 }}>
            <SearchBox value={query} onChange={setQuery}
              placeholder="Search PO no, supplier, item…" />
            <FilterChips value={status} onChange={setStatus} options={[
              ['all', 'All', rows.length, 'Every order'],
              ['draft', 'Draft', count('draft'), PO_STATUS_HINT.draft],
              ['pending', 'Pending', count('pending'), PO_STATUS_HINT.pending],
              ['confirmed', 'Confirmed', count('confirmed'), PO_STATUS_HINT.confirmed],
              ['cancelled', 'Cancelled', count('cancelled'), PO_STATUS_HINT.cancelled],
            ]} />
          </div>

          {rows.length === 0 && <div className="empty" style={{ marginTop: 24 }}>
            No purchase orders yet. Click “New order” to raise the first one —
            goods are booked in against a confirmed order.</div>}
          {rows.length > 0 && shown.length === 0 && <div className="empty" style={{ marginTop: 24 }}>
            Nothing matches. Try “All” or clear the search.</div>}

          {shown.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="items">
                <thead><tr>
                  <th style={{ width: 110 }}>PO No</th>
                  <th style={{ width: 96 }}>Date</th>
                  <th>Supplier</th>
                  <th style={{ width: 130 }}>Item</th>
                  <th style={{ width: 60, textAlign: 'right' }}>Lines</th>
                  <th style={{ width: 100, textAlign: 'right' }}>Total</th>
                  <th style={{ width: 96 }}>Status</th>
                  <th style={{ width: 260 }}>Actions</th>
                </tr></thead>
                <tbody>
                  {page.slice.map((r) => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openEdit(r)}>
                      <td><b>{r.po_no}</b></td>
                      <td>{readableDate(r.po_date)}</td>
                      <td>{r.supplier_name || <span className="small">—</span>}</td>
                      <td>{r.item || <span className="small">—</span>}</td>
                      <td style={{ textAlign: 'right' }}>{r.line_count}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.total)}</td>
                      <td><span className={'badge ' + r.status}>{r.status}</span></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="rowacts">
                        {/* Only the moves this order can actually make. A button
                            that is always drawn and sometimes refused teaches
                            people to expect errors. */}
                        {r.status === 'draft' && <button className="btn" disabled={busy}
                          style={{ padding: '2px 8px' }}
                          onClick={() => move(r, 'pending')}>Send</button>}
                        {(r.status === 'draft' || r.status === 'pending') && (
                          <button className="btn primary" disabled={busy}
                            style={{ padding: '2px 8px' }}
                            title={r.blockers?.length ? 'Needs ' + r.blockers.join(', ') : 'Agreed — allow goods against it'}
                            onClick={() => move(r, 'confirmed')}>Confirm</button>
                        )}
                        {/* Not offered once goods are booked in against it: the
                            consignment on the register points at this order, and
                            the server refuses for that reason. Drawing the
                            button anyway and letting it fail is how people learn
                            to expect errors. */}
                        {r.status !== 'cancelled' && !r.linked_lr_count && (
                          <button className="btn" disabled={busy}
                            style={{ padding: '2px 8px' }}
                            onClick={() => move(r, 'cancelled')}>Cancel</button>
                        )}
                        {!!r.linked_lr_count && r.status !== 'cancelled' && (
                          <span className="small" title="A consignment has been booked in against this order">
                            {r.linked_lr_count} consignment{r.linked_lr_count === 1 ? '' : 's'}</span>
                        )}
                        {/* Edit and delete as icons, on every row, always in the
                            same place. An order that can no longer be changed
                            offers a VIEW instead of an edit, and a delete the
                            server would refuse is drawn greyed — pressing it says
                            why rather than failing. */}
                        <span className="rowacts-icons">
                          {(r.editable ?? (r.status === 'draft' || r.status === 'pending')) ? (
                            <button className="rowact" onClick={() => openEdit(r)}
                              title={`Edit ${r.po_no}`} aria-label={`Edit ${r.po_no}`}>
                              <Icon name="pencil" size={15} /></button>
                          ) : (
                            <button className="rowact" onClick={() => openEdit(r)}
                              title={`View ${r.po_no} — a ${r.status} order cannot be edited`}
                              aria-label={`View ${r.po_no}`}>
                              <Icon name="eye" size={15} /></button>
                          )}
                          <button className={'rowact danger' + (cannotDelete(r) ? ' off' : '')}
                            aria-disabled={cannotDelete(r) ? 'true' : undefined}
                            onClick={(e) => remove(e, r)}
                            title={cannotDelete(r) || `Delete ${r.po_no}`}
                            aria-label={`Delete ${r.po_no}`}>
                            <Icon name="trash" size={15} /></button>
                        </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager {...page} noun="order" />
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}

// ==========================================================================
//  Price Changer — what things sell for, one item or ten thousand
//  ------------------------------------------------------------------------
//  Three panels, in the order the job is actually done: pick the products, say
//  what to do to them, then LOOK AT IT before it happens.
//
//  The preview is the whole screen, not a nicety. A bulk price change is the
//  fastest way in this application to do serious damage: one wrong filter and
//  ten thousand garments are repriced, and the only thing between that and a
//  shop selling below cost is somebody being shown the before and after while
//  they can still say no. So Apply is not reachable until a preview has been
//  run, any edit to the selection throws the preview away, and the button says
//  how many prices it is about to move.
//
//  Cost is shown and never editable. It is what the goods cost, worked out by
//  weighted average from the GRNs that brought them in — see services/pricing.
// ==========================================================================
const PRICE_LABEL = { sale_price: 'Selling price', mrp: 'MRP',
                      sale_discount_pct: 'Discount off MRP (%)' }
const OP_LABEL = { set: 'Set to', percent: 'Change by %', amount: 'Change by INR',
                   discount_off_mrp: 'Set to MRP less %' }
const PRICE_FILTERS = [
  ['category_section', 'Section'], ['category', 'Category'], ['brand', 'Brand'],
  ['color', 'Colour'], ['size', 'Size'], ['material', 'Material'],
]

function PriceChanger({ toast, role }) {
  const [opts, setOpts] = useState(null)
  const [filters, setFilters] = useState({})
  const [text, setText] = useState('')
  const [picked, setPicked] = useState(() => new Set())
  const [list, setList] = useState(null)
  const [field, setField] = useState('sale_price')
  const [op, setOp] = useState('percent')
  const [value, setValue] = useState('')
  const [roundTo, setRoundTo] = useState('')
  const [note, setNote] = useState('')
  const [prev, setPrev] = useState(null)
  const [busy, setBusy] = useState(false)
  const [revisions, setRevisions] = useState([])
  const [open, setOpen] = useState(null)

  // By RANK, not by name — `role === 'superadmin'` locked the Super Boss, who
  // outranks every one of these, out of the screen. See ROLE_RANK.
  const mayChange = atLeast(role, 'admin')

  const loadRevisions = useCallback(() =>
    api.pricingRevisions().then((r) => setRevisions(r.revisions || [])).catch(() => {}), [])
  useEffect(() => {
    api.pricingOptions().then(setOpts)
      .catch((e) => toast(e.detail || 'Could not read the price options', 'err'))
    loadRevisions()
  }, [loadRevisions, toast])

  // Any edit to the selection throws the preview away. Showing a before/after
  // that was computed against a different set of products is the one thing this
  // screen must never do.
  const reselect = (fn) => { setPrev(null); fn() }

  const search = async () => {
    setBusy(true)
    try {
      const r = await api.pricingProducts({ ...filters, q: text, limit: 300 })
      setList(r); setPicked(new Set()); setPrev(null)
    } catch (e) { toast(e.detail || 'Search failed', 'err') }
    finally { setBusy(false) }
  }

  const body = () => ({
    field, operation: op, value: Number(value),
    round_to: roundTo === '' ? null : Number(roundTo),
    filters, text,
    product_ids: picked.size ? [...picked] : null,
    note: note || null,
  })

  const runPreview = async () => {
    if (value === '') { toast('Say what the new price should be', 'warn'); return }
    setBusy(true)
    try { setPrev(await api.pricingPreview(body())) }
    catch (e) { toast(e.detail || 'Could not work that out', 'err'); setPrev(null) }
    finally { setBusy(false) }
  }

  const runApply = async () => {
    if (!prev || !prev.changed) return
    const aimed = Object.values(filters).filter(Boolean).length || text
    const what = picked.size ? picked.size + ' item(s) picked by hand'
      : (aimed ? 'the current selection' : 'EVERY product')
    const ok = window.confirm(
      'Change ' + PRICE_LABEL[field] + ' on ' + prev.changed + ' product(s) — ' + what + '?'
      + '\n\nThis is recorded and can be put back, but the new prices take effect at once.')
    if (!ok) return
    setBusy(true)
    try {
      const rev = await api.pricingApply(body())
      toast(rev.number + ' — ' + rev.product_count + ' price(s) changed', 'ok')
      setPrev(null); setValue(''); setNote('')
      await search(); await loadRevisions()
    } catch (e) { toast(e.detail || 'Could not apply that', 'err') }
    finally { setBusy(false) }
  }

  const revert = async (rev) => {
    if (!window.confirm('Put ' + rev.number + ' back? Every price it changed returns to what it was.')) return
    try {
      await api.pricingRevert(rev.id)
      toast(rev.number + ' put back', 'ok')
      loadRevisions(); setOpen(null)
      if (list) search()
    } catch (e) { toast(e.detail || 'Could not put it back', 'err') }
  }

  const money = (v) => (v == null || v === '' ? '—' : 'INR ' + Number(v).toFixed(2))
  const pick = (id) => reselect(() => setPicked((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  }))

  return (
    <div className="screen">
      <div className="pagehead">
        <h2>Price Changer</h2>
        <span className="small pagesub">
          What things sell for. Every change is recorded and can be put back.</span>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={loadRevisions}>↻ History</button>
      </div>

      <div className="screenbody">
        {!mayChange && (
          <div className="warnbox" style={{ marginBottom: 14 }}>
            <h4>You can look, but not change</h4>
            <div className="small" style={{ color: 'var(--text-2)' }}>
              Changing a price is an admin's decision — it is money, and one bulk
              change moves thousands of them at once.
            </div>
          </div>
        )}

        <Section id="price-pick" title="1 · Which products">
          <div className="mgrid">
            {PRICE_FILTERS.map(([key, label]) => (
              <div className="field" key={key}>
                <label>{label}</label>
                <select value={filters[key] || ''}
                  onChange={(e) => reselect(() => setFilters((f) => ({ ...f, [key]: e.target.value })))}>
                  <option value="">any</option>
                  {(opts?.[key] || []).map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            ))}
            <div className="field">
              <label>Supplier</label>
              <select value={filters.supplier_id || ''}
                onChange={(e) => reselect(() => setFilters((f) => ({ ...f, supplier_id: e.target.value })))}>
                <option value="">any</option>
                {(opts?.suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="field wide">
              <label>Search</label>
              <input value={text} placeholder="description, SKU, barcode, design no"
                onChange={(e) => reselect(() => setText(e.target.value))}
                onKeyDown={(e) => { if (e.key === 'Enter') search() }} />
            </div>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn primary" disabled={busy} onClick={search}>Find products</button>
            <button className="btn" onClick={() => reselect(() => {
              setFilters({}); setText(''); setPicked(new Set()); setList(null)
            })}>Clear</button>
            {list && (
              <span className="small" style={{ color: 'var(--text-2)' }}>
                {list.total} matching
                {list.shown < list.total ? ' · showing the first ' + list.shown : ''}
                {picked.size ? ' · ' + picked.size + ' picked by hand' : ''}
              </span>
            )}
          </div>

          {list && (
            <div className="tablewrap" style={{ marginTop: 10, maxHeight: '38vh' }}>
              <table className="grid">
                <thead><tr>
                  <th style={{ width: 34 }}></th><th>Item</th><th>Attributes</th>
                  <th className="num">Stock</th><th className="num">Cost</th>
                  <th className="num">MRP</th><th className="num">Sells at</th>
                  <th className="num">Disc %</th>
                </tr></thead>
                <tbody>
                  {list.products.map((p) => (
                    <tr key={p.id}>
                      <td><input type="checkbox" checked={picked.has(p.id)}
                        onChange={() => pick(p.id)} /></td>
                      <td>{p.description}<br /><span className="small mono">{p.sku}</span></td>
                      <td className="small">{[p.category, p.brand, p.size, p.color, p.material]
                        .filter(Boolean).join(' · ')}</td>
                      <td className="num">{p.stock_qty}</td>
                      <td className="num">{money(p.avg_cost)}</td>
                      <td className="num">{money(p.mrp)}</td>
                      <td className="num">{money(p.sale_price)}</td>
                      <td className="num">{p.sale_discount_pct == null ? '—' : p.sale_discount_pct}</td>
                    </tr>
                  ))}
                  {!list.products.length && (
                    <tr><td colSpan={8} className="empty">Nothing matches.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <div className="hint" style={{ marginTop: 6 }}>
            Tick rows to change only those. Tick nothing and the change lands on
            every product the filters above match — which is what a bulk change is.
          </div>
        </Section>

        <Section id="price-what" title="2 · What to change">
          <div className="mgrid">
            <div className="field">
              <label>Price</label>
              <select value={field} onChange={(e) => { setField(e.target.value); setPrev(null) }}>
                {(opts?.fields || []).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>How</label>
              <select value={op} onChange={(e) => { setOp(e.target.value); setPrev(null) }}>
                {(opts?.operations || []).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{op === 'percent' || op === 'discount_off_mrp' ? 'Percent' : 'Amount'}</label>
              <input type="number" step="0.01" value={value}
                onChange={(e) => { setValue(e.target.value); setPrev(null) }}
                placeholder={op === 'percent' ? '-20 for 20% off' : ''} />
            </div>
            <div className="field">
              <label>Round to nearest</label>
              <input type="number" step="1" value={roundTo}
                onChange={(e) => { setRoundTo(e.target.value); setPrev(null) }}
                placeholder="blank = exact" />
              <div className="hint">Retail prices are 499, not 487.63.</div>
            </div>
            <div className="field wide">
              <label>Why</label>
              <input value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Festival markdown, cost increase, clearance…" />
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={busy || value === ''}
              onClick={runPreview}>See what this would do</button>
          </div>
        </Section>

        {prev && (
          <Section id="price-preview"
            title={'3 · ' + prev.changed + ' price(s) would change'}>
            {(prev.warnings || []).map((w, i) => (
              <div className="warnbox" key={i} style={{ marginBottom: 10 }}>
                <div className="small">{w}</div>
              </div>
            ))}
            <div className="small" style={{ color: 'var(--text-2)', marginBottom: 8 }}>
              {prev.total} product(s) in the selection · {prev.changed} would move ·
              {' '}{prev.unchanged} already at that price, or with nothing to work from.
            </div>
            <div className="tablewrap" style={{ maxHeight: '40vh' }}>
              <table className="grid">
                <thead><tr>
                  <th>Item</th><th className="num">Cost</th><th className="num">MRP</th>
                  <th className="num">Now</th><th className="num">Becomes</th>
                  <th className="num">Change</th>
                </tr></thead>
                <tbody>
                  {prev.rows.map((r) => {
                    const delta = (r.new == null ? 0 : r.new) - (r.old == null ? 0 : r.old)
                    return (
                      <tr key={r.product_id}>
                        <td>{r.description}<br /><span className="small mono">{r.sku}</span></td>
                        <td className="num">{money(r.avg_cost)}</td>
                        <td className="num">{money(r.mrp)}</td>
                        <td className="num">{r.old == null ? '—' : Number(r.old).toFixed(2)}</td>
                        <td className="num"><b>{Number(r.new).toFixed(2)}</b></td>
                        <td className="num" style={{ color: delta < 0 ? 'var(--danger)' : 'var(--ok)' }}>
                          {delta > 0 ? '+' : ''}{delta.toFixed(2)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn primary" disabled={busy || !mayChange || !prev.changed}
                onClick={runApply}>Apply to {prev.changed} product(s)</button>
              <button className="btn" onClick={() => setPrev(null)}>Cancel</button>
              <span className="small" style={{ color: 'var(--text-2)' }}>
                Nothing has changed yet.</span>
            </div>
          </Section>
        )}

        <Section id="price-history" title="Price changes made">
          <div className="tablewrap">
            <table className="grid">
              <thead><tr>
                <th>Ref</th><th>What</th><th>Which</th><th className="num">Items</th>
                <th>When</th><th>By</th><th>Why</th><th></th>
              </tr></thead>
              <tbody>
                {revisions.map((r) => (
                  <tr key={r.id}>
                    <td><a href="#" onClick={(e) => {
                      e.preventDefault()
                      api.pricingRevision(r.id).then(setOpen).catch(() => {})
                    }}><span className="mono">{r.number}</span></a></td>
                    <td className="small">
                      {PRICE_LABEL[r.field] || r.field} · {OP_LABEL[r.operation] || r.operation} {r.value}
                      {r.round_to ? ' · round ' + r.round_to : ''}</td>
                    <td className="small">{r.scope}</td>
                    <td className="num">{r.product_count}</td>
                    <td className="small">{fmtDate(r.created_at)}</td>
                    <td className="small">{r.created_by || '—'}</td>
                    <td className="small">{r.note || '—'}</td>
                    <td>{r.reverted_at
                      ? <span className="badge cancelled">put back</span>
                      : (mayChange ? <button className="btn" onClick={() => revert(r)}>Put back</button> : null)}</td>
                  </tr>
                ))}
                {!revisions.length && (
                  <tr><td colSpan={8} className="empty">No price changes yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>

        {open && (
          <div className="modal-back" onClick={() => setOpen(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <b>{open.number}</b>
                <span className="badge">{open.product_count} item(s)</span>
                <button className="modal-x" onClick={() => setOpen(null)}>×</button>
              </div>
              <div className="modal-body">
                <div className="small" style={{ color: 'var(--text-2)', marginBottom: 8 }}>
                  {PRICE_LABEL[open.field] || open.field} ·
                  {' '}{OP_LABEL[open.operation] || open.operation} {open.value} ·
                  {' '}{open.scope}{open.note ? ' · ' + open.note : ''}
                </div>
                <div className="tablewrap" style={{ maxHeight: '50vh' }}>
                  <table className="grid">
                    <thead><tr><th>Item</th><th className="num">Was</th><th className="num">Became</th></tr></thead>
                    <tbody>
                      {(open.changes || []).map((c, i) => (
                        <tr key={i}>
                          <td>{c.description}<br /><span className="small mono">{c.sku}</span></td>
                          <td className="num">{c.old == null ? '—' : Number(c.old).toFixed(2)}</td>
                          <td className="num">{Number(c.new).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {open.shown < open.product_count && (
                  <div className="hint">Showing {open.shown} of {open.product_count}.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ==========================================================================
//  Stock Audit — the desk half of a count
//  ------------------------------------------------------------------------
//  The counting happens on a phone at the rack (backend/app/mobile), and this
//  is deliberately NOT a second copy of that screen. A desk answers different
//  questions: what did this count find, what is still missing, and what did the
//  last one say. So the phone gets one big scan button and this gets the
//  register — the running report of §8 and the history of §16.
//
//  It still takes a code, because a desk has a hardware scanner on a cable and
//  a keyboard, and refusing the reading it can already produce would be a
//  screen that watches other people work.
//
//  Nothing here moves stock. See services/stock_audit for why that is a rule.
// ==========================================================================
const AUDIT_TONE = { available: 'ok', not_available: 'danger', unknown: 'warn' }
const AUDIT_BADGE = { available: 'confirmed', not_available: 'cancelled', unknown: 'pending' }

function StockAuditView({ toast }) {
  const [session, setSession] = useState(undefined)   // undefined = not asked yet
  const [past, setPast] = useState([])
  const [viewing, setViewing] = useState(null)        // a closed count being read
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('all')
  const [last, setLast] = useState(null)
  const box = useRef(null)

  const loadPast = useCallback(() => api.auditList().then(setPast).catch(() => {}), [])
  useEffect(() => {
    api.auditCurrent().then(setSession).catch(() => setSession(null))
    loadPast()
  }, [loadPast])

  const shown = viewing || session
  const rows = (shown?.scans || []).filter((s) => filter === 'all' || s.result === filter)

  const start = async () => {
    setBusy(true)
    try {
      const s = await api.auditOpen()
      setSession(s); setViewing(null); loadPast()
      toast(`${s.code} open${s.warehouse ? ' · ' + s.warehouse : ''}`, 'ok')
    } catch (e) { toast(e.detail || 'Could not start a count', 'err') }
    finally { setBusy(false) }
  }
  const finish = async () => {
    if (!session) return
    if (!window.confirm(`Close ${session.code}? Its readings become a record and it takes no more scans.`)) return
    try {
      await api.auditClose(session.id)
      setSession(null); loadPast(); toast('Count closed', 'ok')
    } catch (e) { toast(e.detail || 'Could not close the count', 'err') }
  }
  const submit = async (raw) => {
    const c = (raw ?? code).trim()
    if (!c || !session) return
    setCode('')
    try {
      const r = await api.auditScan(session.id, c)
      setSession(await api.auditGet(session.id))
      setLast({ ...r.scan, duplicate: r.duplicate })
      // A hardware scanner fires one code after another; the box has to be ready
      // for the next without anybody reaching for the mouse.
      box.current?.focus()
    } catch (e) { toast(e.detail || 'That scan could not be recorded', 'err') }
  }
  const drop = async (s) => {
    if (!session) return
    try {
      await api.auditDropScan(session.id, s.id)
      setSession(await api.auditGet(session.id))
      if (last?.id === s.id) setLast(null)
    } catch (e) { toast(e.detail || 'Could not remove that reading', 'err') }
  }

  const t = shown?.totals || {}
  return (
    <div className="screen">
      <div className="pagehead">
        <h2>Warehouse Stock Audit</h2>
        {/* Short enough to survive `.pagesub`, which clips rather than wraps —
            a sentence that ends in an ellipsis says less than a shorter one. */}
        <span className="small pagesub">
          Is it on the shelf? Counting never changes stock.</span>
        <div style={{ flex: 1 }} />
        {session
          ? <button className="btn" onClick={finish}>Close {session.code}</button>
          : <button className="btn primary" disabled={busy} onClick={start}>+ Start a count</button>}
      </div>
      <div className="screenbody">
        {session === undefined && <div className="empty">Reading the register…</div>}

        {session && !viewing && (
          <Section id="audit-scan" title={`${session.code} · counting${session.warehouse ? ' · ' + session.warehouse : ''}`}>
            <div className="row" style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: 1, maxWidth: 420 }}>
                <label>Scan or type a tag</label>
                <input ref={box} value={code} autoFocus
                  placeholder="product QR, piece code, carton label, barcode or SKU"
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
              </div>
              <button className="btn primary" onClick={() => submit()}>Record</button>
            </div>
            {last && (
              // The verdict on the reading just taken, coloured AND worded — the
              // same rule the phone screen keeps, and for the same reason.
              <div className={'warnbox ' + (last.result === 'available' ? 'clean' : '')}
                style={{ marginTop: 14, borderLeft: `4px solid var(--${AUDIT_TONE[last.result]})` }}>
                <h4 style={{ color: `var(--${AUDIT_TONE[last.result]})` }}>
                  {last.result === 'available' ? '🟢' : last.result === 'not_available' ? '🔴' : '🟡'} {last.label}
                  {last.duplicate && <span className="small" style={{ float: 'right' }}>
                    already counted — not counted twice</span>}
                </h4>
                <p className="small" style={{ marginTop: 4 }}>
                  {last.product_name || <span>Nothing matches <code>{last.code}</code>.</span>}
                  {last.sku ? ` · ${last.sku}` : ''}
                  {last.stock_qty != null ? ` · stock ${last.stock_qty}` : ''}
                  {last.location ? ` · at ${last.location}` : ''}
                  {last.result === 'unknown'
                    && ' Product not found — check the physical stock or the product master.'}
                </p>
              </div>
            )}
          </Section>
        )}

        {!session && !viewing && (
          <div className="empty" style={{ marginTop: 24, maxWidth: 560 }}>
            No count in progress. Start one here, or scan from the phone — both
            write to the same register, so a count begun at the rack is finished
            at the desk.
          </div>
        )}

        {shown && (
          <Section id="audit-report"
            title={`${viewing ? viewing.code + ' · closed' : 'Running report'} · ${t.scanned || 0} scanned`}
            actions={viewing
              ? <button className="btn" onClick={() => setViewing(null)}>Back</button>
              : null}>
            <div className="toolbar">
              <FilterChips value={filter} onChange={setFilter} options={[
                ['all', 'All', t.scanned || 0, 'Every reading in this count'],
                ['available', 'Available', t.available || 0, 'Found on the shelf'],
                ['not_available', 'Not available', t.not_available || 0, 'The system holds none here'],
                ['unknown', 'Not found', t.unknown || 0, 'The tag matches no product — a master-data problem, not a shelf one'],
              ]} />
            </div>
            {rows.length === 0
              ? <div className="empty" style={{ marginTop: 20 }}>
                  {t.scanned ? 'Nothing matches that filter.' : 'Nothing counted yet.'}</div>
              : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="items">
                    <thead><tr>
                      <th style={{ width: 180 }}>QR / Code</th>
                      <th>Product</th>
                      <th style={{ width: 120 }}>SKU</th>
                      <th style={{ width: 80, textAlign: 'right' }}>Stock</th>
                      <th style={{ width: 110 }}>Location</th>
                      <th style={{ width: 120 }}>Status</th>
                      <th style={{ width: 90 }}>By</th>
                      {!viewing && <th style={{ width: 34 }}></th>}
                    </tr></thead>
                    <tbody>
                      {rows.map((s) => (
                        <tr key={s.id}>
                          <td><code>{s.code}</code>
                            {(s.times_seen || 1) > 1 && <span className="small"> · seen {s.times_seen}×</span>}</td>
                          <td>{s.product_name || <span className="small">— no product —</span>}</td>
                          <td>{s.sku || <span className="small">—</span>}</td>
                          <td style={{ textAlign: 'right' }}>{s.stock_qty ?? <span className="small">—</span>}</td>
                          <td>{s.location || <span className="small">—</span>}</td>
                          <td><span className={'badge ' + AUDIT_BADGE[s.result]}>{s.label}</span></td>
                          <td className="small">{s.scanned_by || '—'}</td>
                          {!viewing && (
                            <td><button className="rowdel" title="Remove this reading"
                              onClick={() => drop(s)}>×</button></td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Section>
        )}

        <Section id="audit-history" title={`Past counts · ${past.length}`} defaultOpen={!session}>
          {past.length === 0
            ? <div className="empty" style={{ marginTop: 16 }}>No counts recorded yet.</div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table className="items">
                  <thead><tr>
                    <th style={{ width: 110 }}>Count</th>
                    <th style={{ width: 130 }}>Started</th>
                    <th style={{ width: 110 }}>By</th>
                    <th style={{ width: 80, textAlign: 'right' }}>Scanned</th>
                    <th style={{ width: 90, textAlign: 'right' }}>Available</th>
                    <th style={{ width: 110, textAlign: 'right' }}>Not available</th>
                    <th style={{ width: 90 }}>Status</th>
                  </tr></thead>
                  <tbody>
                    {past.map((s) => (
                      <tr key={s.id} style={{ cursor: 'pointer' }}
                        onClick={async () => {
                          try { setViewing(await api.auditGet(s.id)) }
                          catch { toast('Could not open that count', 'err') }
                        }}>
                        <td><b>{s.code}</b></td>
                        {/* fmtDate, not readableDate: started_at is a stored
                            timestamp, and fmtDate is the one display helper that
                            knows a date with a time bolted on is still a date. */}
                        <td>{fmtDate(s.started_at)}</td>
                        <td>{s.started_by || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{s.totals?.scanned ?? 0}</td>
                        <td style={{ textAlign: 'right' }}>{s.totals?.available ?? 0}</td>
                        <td style={{ textAlign: 'right' }}>
                          {(s.totals?.not_available ?? 0) + (s.totals?.unknown ?? 0)}</td>
                        <td><span className={'badge ' + (s.status === 'open' ? 'pending' : 'posted')}>
                          {s.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Section>
      </div>
    </div>
  )
}

// ==========================================================================
//  Physical Stock Audit — counting the warehouse by quantity
//  ------------------------------------------------------------------------
//  The OTHER audit, and the reason both exist is that they answer different
//  questions. The scan-through above asks "is this item on the shelf" and
//  answers one tag at a time. This asks "HOW MANY are there" over a defined set
//  of stock, and ends in a variance that somebody approves and that then
//  corrects the books.
//
//  So it is a grid, not a scan box. A count of a rack is read across — barcode,
//  what it is, how many the books say, how many are there — and compared down.
//  A card per reading would make the one comparison the screen exists for the
//  hardest thing on it.
//
//  THE PANEL ON THE LEFT IS NOT A SEARCH BOX. Nobody counts a warehouse; they
//  count the MENS rack, or one brand, or one supplier's goods. What it is set to
//  when the count is opened IS the count — it is snapshotted onto the document
//  and the variance is only measured inside it — which is why Search (how much
//  would this cover?) and New (start counting it) are two buttons rather than
//  one. See services/physical_audit.
//
//  Nothing here moves stock. The toolbar at the foot walks a count through
//  complete → reviewed → approved, and only then does Apply write real stock
//  movements, carrying the change reason typed beside it.
// ==========================================================================

//: The panel, in the two columns the reference screen puts them in. Declared as
//: data because it is eighteen near-identical fields and writing them out is
//: eighteen chances to bind one to the wrong key — which is a filter that
//: silently stops filtering, the failure this screen can least afford.
//: `[key, label]`, paired across the row; `null` is a field that spans both.
const PSA_FILTER_ROWS = [
  [['product', 'Product'], ['brand', 'Brand']],
  [['colour', 'Colour'], ['material', 'Material']],
  [['pattern', 'Pattern'], ['style', 'Style']],
  [['sleeve', 'Sleeve'], ['fit', 'Fit']],
  [['size', 'Size'], ['type', 'Type']],
  [['section', 'Section'], ['design', 'Design']],
]

//: What each tickbox actually does here, said in full. These are the three
//: controls on the screen whose names come from the reference ERP and whose
//: behaviour is this system's, so the gap between the two belongs on the screen
//: rather than in a note somebody has to be told about.
const PSA_TOGGLES = [
  ['direct_edit', 'Direct Add/Remove',
    'Lets the count take in items found outside its filters, and lets an '
    + 'uncounted row be removed. Off, a count of one rack stays a count of that '
    + 'rack and a stray tag is refused rather than quietly widening it.'],
  ['show_all', 'Show All Rows',
    'Lists every item in the count, including the ones nobody has reached yet. '
    + 'Off, the grid shows only what has actually been counted — which is what '
    + 'you want while working down a rack.'],
  ['remove_sales', 'Remove Sales',
    'Leaves a shortfall alone when at least that much was dispatched from here '
    + 'after the row was counted. The lorry explains the gap, so correcting it '
    + 'would write off goods that are in transit.'],
]

//: Grid column per filter key — the client-side half of PRODUCT_FILTERS in
//: services/physical_audit. Kept here rather than shared with the server's
//: because it maps FILTER KEY to the name the API hands back on a LINE, which is
//: a different mapping from the server's (filter key to Product column) and
//: would be quietly wrong if either were used for the other.
const PRODUCT_FILTER_COLUMNS = {
  section: 'section', brand: 'brand', size: 'size', design: 'design',
  colour: 'colour', product: 'category',
}

// One attribute dropdown on the rail.
//
// AT MODULE LEVEL, NOT INSIDE THE SCREEN. A component declared inside another is
// a NEW component type on every render, so React unmounts the old subtree and
// mounts a fresh one — and a <select> that is remounted loses focus mid-use. The
// screen re-renders on every keystroke in the scan box, which is exactly when
// somebody is least able to afford the rail resetting under them.
function PsaDropdown({ name, label, value, options, onChange, searched }) {
  if (searched) return <PsaSearchField name={name} label={label} value={value} onChange={onChange} />
  const list = options || []
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value || ''} onChange={onChange}
        title={list.length
          ? `Narrow to one ${label.toLowerCase()} — ${list.length} on these shelves`
          : `No ${label.toLowerCase()} is recorded against this warehouse's stock`}>
        <option value="">{list.length ? 'Any' : '— none recorded —'}</option>
        {list.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>
  )
}

// A filter with too many values for a dropdown (design runs to 100,000+ on a
// full store — a <select> that size freezes the page). Typed instead, with the
// matching values this warehouse holds offered as suggestions.
function PsaSearchField({ name, label, value, onChange }) {
  const [hits, setHits] = useState([])
  const q = useDebounced((value || '').trim(), 250)
  useEffect(() => {
    if (!q) { setHits([]); return }
    let live = true
    api.psaSearchOption(name, q).then((r) => { if (live) setHits(Array.isArray(r) ? r : []) })
      .catch(() => { if (live) setHits([]) })
    return () => { live = false }
  }, [name, q])
  const id = `psa-opt-${name}`
  return (
    <div className="field">
      <label>{label}</label>
      <input value={value || ''} onChange={onChange} list={id} placeholder="Any — type to search"
        title={`Narrow to one ${label.toLowerCase()} — type part of it and pick from the list`} />
      <datalist id={id}>
        {hits.map((v) => <option key={v} value={v} />)}
      </datalist>
    </div>
  )
}

const PSA_STATUS_BADGE = {
  counting: 'pending', completed: 'review', reviewed: 'posted',
  approved: 'confirmed', cancelled: 'cancelled',
}
//: The row chips. `pending` deliberately reads "not counted" rather than "0" —
//: see the null-is-not-zero rule the whole module is built on.
const PSA_LINE_BADGE = {
  pending: ['draft', 'not counted'], matched: ['confirmed', 'matches'],
  short: ['cancelled', 'short'], excess: ['review', 'excess'],
}

// One tile of the strip across the top. `sub` is the second figure the
// reference screen shows beside Valid as "n + m".
function PsaTotal({ label, value, sub, tone }) {
  return (
    <div className="psatile">
      <span className="psatile-l">{label}</span>
      <span className={'psatile-v' + (tone ? ' ' + tone : '')}>
        {value}
        {sub != null && <span className="psatile-s"> + {sub}</span>}
      </span>
    </div>
  )
}

function PhysicalAuditView({ toast, role }) {
  const [options, setOptions] = useState(null)
  const [filters, setFilters] = useState({})
  const [audit, setAudit] = useState(undefined)   // undefined = not asked yet
  const [past, setPast] = useState([])
  const [viewing, setViewing] = useState(null)    // a finished count being read
  const [preview, setPreview] = useState(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState(() => new Set())
  const box = useRef(null)
  const file = useRef(null)

  const loadPast = useCallback(
    () => api.psaList().then(setPast).catch(() => {}), [])
  useEffect(() => {
    api.psaOptions().then(setOptions).catch(() => setOptions({}))
    api.psaCurrent().then((a) => { setAudit(a); setReason(a?.change_reason || '') })
      .catch(() => setAudit(null))
    loadPast()
  }, [loadPast])

  const shown = viewing || audit
  const open = !viewing && shown?.status === 'counting'
  const totals = shown?.totals || {}
  // Once a count is open its own filters are the truth about what is being
  // counted; the panel then narrows what is DRAWN, which is a different job. The
  // two are the same control because they are the same question asked before and
  // during — but the screen says which it is doing, under the buttons.
  const live = shown ? (shown.scope || {}) : filters

  const rows = useMemo(() => {
    let list = shown?.lines || []
    // Show All Rows is view state and only view state — never read off the
    // count, which is why the server does not keep it. See OTHER_FILTERS.
    if (!filters.show_all) list = list.filter((l) => l.qty != null)
    Object.entries(PRODUCT_FILTER_COLUMNS).forEach(([key, field]) => {
      const want = filters[key]
      if (want) list = list.filter((l) => (l[field] || '') === want)
    })
    if (filters.barcode) {
      const want = String(filters.barcode).trim().toLowerCase()
      const kind = filters.barcode_type || 'any'
      const hit = (l) => (kind !== 'supplier' && (l.uan || '').toLowerCase() === want)
        || (kind !== 'uan' && (l.barcode || '').toLowerCase() === want)
      list = list.filter(hit)
    }
    if (search) {
      list = list.filter((l) => matches(l, search,
        ['barcode', 'uan', 'product', 'section', 'brand', 'size', 'design']))
    }
    return list
  }, [shown, filters, live, search])
  const paged = usePaged(rows, 100)

  const set = (key) => (e) => {
    const el = e.target
    setFilters((f) => ({ ...f, [key]: el.type === 'checkbox' ? el.checked : el.value }))
    setPreview(null)
  }
  // What the count is narrowed BY. The three tickboxes and the tag-type selector
  // are not narrowings — they change how counting behaves, not what is in scope —
  // so a screen showing "3 filters set" when only they are ticked would be
  // counting the wrong thing out loud.
  const activeFilters = Object.entries(filters).filter(
    ([k, v]) => v !== '' && v != null && v !== false && v !== 'any'
      && !['show_all', 'direct_edit', 'remove_sales', 'barcode_type'].includes(k)).length

  const refresh = async (id) => {
    const fresh = await api.psaGet(id ?? shown.id)
    if (viewing) setViewing(fresh); else setAudit(fresh)
    return fresh
  }
  // A scan, a typed count or a dropped row answers with the one line it touched
  // and the new totals. Folding those in — rather than re-reading the whole sheet
  // after every beep — is what keeps a count of thousands of rows scannable.
  const merge = ({ line, totals: t, dropId }) => {
    const apply = (a) => {
      if (!a) return a
      let lines = a.lines || []
      if (dropId != null) lines = lines.filter((l) => l.id !== dropId)
      if (line) {
        const at = lines.findIndex((l) => l.id === line.id)
        lines = at >= 0 ? lines.map((l, i) => (i === at ? line : l)) : [...lines, line]
      }
      return { ...a, lines, totals: t || a.totals }
    }
    if (viewing) setViewing(apply); else setAudit(apply)
  }

  // --- the toolbar ---------------------------------------------------------
  const doSearch = async () => {
    // With a count open this is a filter on the grid and has already happened as
    // the dropdowns changed. With none, it answers the question that has to be
    // settled BEFORE a document is raised: how much is this?
    if (shown && open) { toast(`${rows.length} of ${shown.lines.length} rows shown`, 'ok'); return }
    setBusy(true)
    try {
      const p = await api.psaPreview(filters)
      setPreview(p)
      toast(`${p.items} item${p.items === 1 ? '' : 's'} · ${p.qty} piece${p.qty === 1 ? '' : 's'}`, 'ok')
    } catch (e) { toast(e.detail || 'Could not read that filter set', 'err') }
    finally { setBusy(false) }
  }

  const doNew = async () => {
    const what = preview ? `${preview.items} items (${preview.qty} pieces)` : 'the filtered stock'
    if (!window.confirm(
      `Open a physical stock audit over ${what}?\n\n`
      + 'The filters as they stand become the count — it is measured only against '
      + 'what they cover. Counting changes no stock by itself.')) return
    setBusy(true)
    try {
      const a = await api.psaOpen(filters)
      setAudit(a); setViewing(null); setReason(''); setPreview(null); loadPast()
      toast(`${a.code} open · ${a.lines.length} rows`, 'ok')
    } catch (e) { toast(e.detail || 'Could not open a count', 'err') }
    finally { setBusy(false) }
  }

  // A handheld's file: `code,qty` per line, and a bare code counts as one. CSV
  // and plain text both, because a scanner's export is whichever its vendor
  // chose and neither is worth refusing over a comma.
  const doUpload = async (f) => {
    if (!f || !shown) return
    setBusy(true)
    try {
      const text = await f.text()
      const parsed = text.split(/\r?\n/).map((line) => line.trim())
        .filter((line) => line && !/^(code|barcode)\s*[,;\t]/i.test(line))
        .map((line) => {
          const [c, q] = line.split(/[,;\t]/)
          return { code: (c || '').trim(), qty: q == null || q === '' ? 1 : Number(q) }
        })
        .filter((r) => r.code && !isNaN(r.qty))
      if (!parsed.length) { toast('That file held no readable codes', 'err'); return }
      const res = await api.psaUpload(shown.id, parsed)
      await refresh()
      const missed = res.unknown_count + res.off_scope_count
      toast(`${res.applied} row${res.applied === 1 ? '' : 's'} taken`
        + (res.added ? ` · ${res.added} added` : '')
        + (missed ? ` · ${missed} could not be placed` : ''), missed ? 'warn' : 'ok')
    } catch (e) { toast(e.detail || 'Could not read that file', 'err') }
    finally { setBusy(false); if (file.current) file.current.value = '' }
  }

  const doSync = async () => {
    setBusy(true)
    try {
      const r = await api.psaSync(shown.id)
      setAudit(r.audit)
      toast(r.refreshed || r.added
        ? `${r.refreshed} figure${r.refreshed === 1 ? '' : 's'} updated · ${r.added} new item${r.added === 1 ? '' : 's'}`
        : 'Already up to date', 'ok')
    } catch (e) { toast(e.detail || 'Could not synchronize', 'err') }
    finally { setBusy(false) }
  }

  // --- counting ------------------------------------------------------------
  const submitCode = async (raw) => {
    const c = (raw ?? code).trim()
    if (!c || !shown) return
    setCode('')
    try {
      const r = await api.psaScan(shown.id, c)
      merge(r)
      if (r.message) toast(r.message, 'warn')
      // A gun fires one code after another; the box has to be ready for the next
      // without anybody reaching for the mouse.
      box.current?.focus()
    } catch (e) { toast(e.detail || 'That tag could not be counted', 'err') }
  }

  const setCount = async (line, value) => {
    try {
      merge(await api.psaCount(shown.id, line.id, value === '' ? null : value))
    } catch (e) { toast(e.detail || 'Could not record that count', 'err') }
  }

  const dropLine = async (line) => {
    try { const r = await api.psaDropLine(shown.id, line.id); merge({ totals: r.totals, dropId: line.id }) }
    catch (e) { toast(e.detail || 'Could not remove that row', 'err') }
  }

  // --- the way through -----------------------------------------------------
  const advance = async (status, question) => {
    if (question && !window.confirm(question)) return
    try {
      await api.psaStatus(shown.id, status)
      const fresh = await refresh()
      loadPast()
      toast(`${fresh.code} is ${status}`, 'ok')
    } catch (e) { toast(e.detail || 'Could not move the count on', 'err') }
  }

  const saveReason = async () => {
    if (!shown || reason === (shown.change_reason || '')) return
    try { await api.psaReason(shown.id, reason) }
    catch { /* typed and not yet saved; Apply sends it again anyway */ }
  }

  const doApply = async () => {
    if (!reason.trim()) {
      toast('Give a change reason first — it goes onto every movement', 'err')
      return
    }
    const t = shown.totals || {}
    if (!window.confirm(
      `Correct stock from ${shown.code}?\n\n`
      + `${t.variance_lines} row${t.variance_lines === 1 ? '' : 's'} disagree with the books. `
      + `This writes real stock movements and cannot be run twice.\n\n`
      + `Reason: ${reason.trim()}`)) return
    setBusy(true)
    try {
      const r = await api.psaApply(shown.id, reason.trim())
      await refresh(); loadPast()
      const held = r.skipped_issued + r.skipped_no_product
      toast(`${r.moved} line${r.moved === 1 ? '' : 's'} corrected`
        + (r.uncounted ? ` · ${r.uncounted} never counted, left alone` : '')
        + (held ? ` · ${held} held back` : ''), 'ok')
    } catch (e) { toast(e.detail || 'Could not correct stock', 'err') }
    finally { setBusy(false) }
  }

  return (
    <div className="screen">
      <div className="pagehead">
        <h2>Physical Stock Audit</h2>
        <span className="small pagesub">
          How many are there, against how many the books say.</span>
        <div style={{ flex: 1 }} />
        <button className="btn" disabled={busy} onClick={doSearch}
          title={open
            ? 'Apply the panel to what the grid shows'
            : 'How much stock would these filters cover? Nothing is created.'}>
          ⌕ Search</button>
        <button className="btn primary" disabled={busy || open} onClick={doNew}
          title={open
            ? `${audit.code} is already being counted here — finish or cancel it first`
            : 'Open a count over the filters on the left'}>
          + New</button>
        <button className="btn" disabled={busy || !open} onClick={() => file.current?.click()}
          title={open
            ? 'Take counts off a handheld scanner’s file (code, qty per line). Figures replace, so the same file twice is safe.'
            : 'Open a count first'}>
          ⭱ Upload</button>
        <input ref={file} type="file" accept=".csv,.txt,text/csv,text/plain" hidden
          onChange={(e) => doUpload(e.target.files?.[0])} />
        <button className="btn" disabled={busy || !open} onClick={doSync}
          title={open
            ? 'Re-read the books for rows nobody has counted, and take in stock received since'
            : 'Open a count first'}>
          ⟳ Synchronize</button>
      </div>

      <div className="body">
        <Sidebar id="psa-filters" label="Filters" width={340}>
          <div className="head"><h3>
            {shown ? 'Narrow the grid' : 'What to count'}
            {activeFilters > 0 && <span className="badge pending">{activeFilters}</span>}
          </h3></div>
          <div className="psafilters">
            <p className="small psanote">
              {shown
                ? <>These narrow what the grid <b>shows</b>. What <b>{shown.code}</b> covers
                  was fixed when it was opened.</>
                : <>Nobody counts a warehouse. Set what is being counted — these
                  become the count and the variance is measured only inside them.</>}
            </p>

            <div className="row">
              <div className="field">
                <label>Search From</label>
                <select value="warehouse" disabled
                  title="A count is of one building's racks. The warehouse is the one you are working inside — switch it in the header to count another.">
                  <option value="warehouse">{shown?.warehouse || 'This warehouse'}</option>
                </select>
              </div>
              <div className="field">
                <label>Barcode Type</label>
                <select value={filters.barcode_type || 'any'} onChange={set('barcode_type')}
                  title="Which tag the scan box expects. Any accepts all of them — our QR, a per-piece code, the supplier's barcode or the SKU — which is what a mixed rack needs.">
                  <option value="any">Any tag</option>
                  <option value="uan">Our QR / UAN</option>
                  <option value="supplier">Supplier barcode</option>
                </select>
              </div>
            </div>

            <div className="row">
              <div className="field">
                <label>Company</label>
                <select value={filters.company || ''} onChange={set('company')}
                  title="The trading entity. A count is taken inside one warehouse, which already belongs to one company, so this rarely narrows anything further.">
                  <option value="">Any</option>
                  {(options?.company || []).map((c) =>
                    <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Location</label>
                <select value={filters.location || ''} onChange={set('location')}
                  title="The rack a carton was put away on. Many installs record nothing here, and then the list is empty rather than wrong.">
                  <option value="">{(options?.location || []).length ? 'Any' : '— none recorded —'}</option>
                  {(options?.location || []).map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            </div>

            <div className="field">
              <label>Supplier</label>
              <select value={filters.supplier || ''} onChange={set('supplier')}
                title="Count one supplier's goods — what a claim against them usually starts as">
                <option value="">Any</option>
                {(options?.supplier || []).map((s) =>
                  <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>

            {PSA_FILTER_ROWS.map((pair, i) => (
              <div className="row" key={i}>
                {pair.map(([k, label]) => (
                  <PsaDropdown key={k} name={k} label={label} value={filters[k]}
                    options={options?.[k]} onChange={set(k)}
                    searched={!!options && options[k] === null} />
                ))}
              </div>
            ))}

            <div className="field">
              <label>Barcode</label>
              <input value={filters.barcode || ''} onChange={set('barcode')}
                placeholder="one exact tag"
                title="Count a single item — its supplier barcode or its UAN" />
            </div>

            {PSA_TOGGLES.map(([k, label, why]) => (
              <label className="psacheck" key={k} title={why}>
                <span>{label}</span>
                <input type="checkbox" checked={!!filters[k]} onChange={set(k)} />
              </label>
            ))}
            {/* Two of the three change what the SERVER does, and it reads them off
                the count rather than off this panel — so once a count is open,
                ticking them here changes nothing and the screen has to say so
                instead of looking broken. */}
            {shown && (filters.direct_edit !== !!live.direct_edit
              || filters.remove_sales !== !!live.remove_sales) && (
              <p className="small psanote warn">
                Direct Add/Remove and Remove Sales were fixed when {shown.code} was
                opened ({live.direct_edit ? 'on' : 'off'} / {live.remove_sales ? 'on' : 'off'}).
                Changing them here affects the next count.
              </p>
            )}

            <div className="filterfoot" style={{ padding: '10px 0 0' }}>
              <span className="small" style={{ color: 'var(--muted)' }}>
                {preview
                  ? `${preview.items} items · ${preview.qty} pieces`
                  : activeFilters ? `${activeFilters} filter${activeFilters === 1 ? '' : 's'} set`
                    : 'Everything in this warehouse'}
              </span>
              <div style={{ flex: 1 }} />
              <button className="btn" disabled={!Object.values(filters).some(
                (v) => v !== '' && v != null && v !== false && v !== 'any')}
                onClick={() => { setFilters({}); setPreview(null) }}
                title={activeFilters ? 'Remove every filter' : 'Nothing to clear'}>
                Clear all</button>
            </div>
          </div>
        </Sidebar>

        <div className="screenbody tight">
          {audit === undefined && <div className="empty">Reading the register…</div>}

          {shown && (
            <>
              <div className="psastrip">
                <PsaTotal label="Available" value={money(totals.available)} />
                <PsaTotal label="Uploaded" value={money(totals.uploaded)} tone="ok" />
                <PsaTotal label="Valid" value={totals.valid ?? 0}
                  sub={totals.variance_lines ?? 0} />
                <PsaTotal label="Missing" value={money(totals.missing)}
                  tone={totals.missing > 0 ? 'danger' : ''} />
                <div style={{ flex: 1 }} />
                <div className="psaid">
                  <b>{shown.code}</b>
                  <span className={'badge ' + (PSA_STATUS_BADGE[shown.status] || 'draft')}>
                    {shown.status}</span>
                  {shown.applied_at && <span className="badge posted" title={
                    `Stock corrected ${fmtDate(shown.applied_at)} by ${shown.applied_by || 'someone'}`}>
                    applied</span>}
                </div>
              </div>

              {/* What the four figures mean, said once on the screen rather than
                  left for somebody to infer from a number that looks wrong. */}
              <p className="small psalegend">
                <b>Available</b> what the books say · <b>Uploaded</b> what has been
                counted · <b>Valid</b> rows that agree + rows that do not ·
                <b> Missing</b> pieces expected and not found.
                {totals.pending_lines > 0 && <> {totals.pending_lines} row
                  {totals.pending_lines === 1 ? '' : 's'} not counted yet
                  {!(filters.show_all) && <> — tick <b>Show All Rows</b> to see them</>}.</>}
                {totals.off_scope > 0 && <> {totals.off_scope} found off-scope.</>}
              </p>

              <div className="toolbar">
                {open && (
                  <div className="field psascan">
                    <input ref={box} value={code} autoFocus
                      placeholder="Scan or type a tag — each read adds one"
                      onChange={(e) => setCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitCode() }}
                      title="A QR, a per-piece code, a supplier barcode or a UAN. Scanning ADDS one; typing into a row's Count box states a total." />
                  </div>
                )}
                <SearchBox value={search} onChange={setSearch}
                  placeholder="Search these rows…" style={{ maxWidth: 240 }} />
                <div style={{ flex: 1 }} />
                {viewing && <button className="btn" onClick={() => setViewing(null)}>
                  Back to the open count</button>}
              </div>

              <div className="psagrid">
                <table className="items">
                  <thead><tr>
                    <th style={{ width: 30 }}>
                      <input type="checkbox" title="Select every row shown"
                        checked={rows.length > 0 && sel.size === rows.length}
                        onChange={(e) => setSel(e.target.checked
                          ? new Set(rows.map((l) => l.id)) : new Set())} /></th>
                    <th style={{ width: 54 }}>Action</th>
                    <th style={{ width: 130 }}>Barcode</th>
                    <th style={{ width: 110 }}>UAN</th>
                    <th>Product</th>
                    <th style={{ width: 90 }}>Section</th>
                    <th style={{ width: 90 }}>Brand</th>
                    <th style={{ width: 70 }}>Size</th>
                    <th style={{ width: 90 }}>Design</th>
                    <th style={{ width: 60, textAlign: 'right' }} title="How many times a tag for this row was read">Count</th>
                    <th style={{ width: 76, textAlign: 'right' }} title="What was actually on the shelf">Qty</th>
                    <th style={{ width: 70, textAlign: 'right' }} title="What the books said when this row was counted">Stock</th>
                    <th style={{ width: 90, textAlign: 'right' }}>Cost Price</th>
                    <th style={{ width: 90, textAlign: 'right' }}>Net Price</th>
                    <th style={{ width: 96 }}>Status</th>
                  </tr></thead>
                  <tbody>
                    {paged.slice.map((l) => (
                      <tr key={l.id} className={sel.has(l.id) ? 'sel' : ''}>
                        <td><input type="checkbox" checked={sel.has(l.id)}
                          onChange={(e) => setSel((s) => {
                            const next = new Set(s)
                            e.target.checked ? next.add(l.id) : next.delete(l.id)
                            return next
                          })} /></td>
                        <td>
                          {open && l.qty != null && (
                            <button className="rowdel" title="Clear this count — back to never counted, which is not the same as zero"
                              onClick={() => setCount(l, '')}>⌫</button>
                          )}
                          {open && l.qty == null && live.direct_edit && (
                            <button className="rowdel" title="Take this row off the count"
                              onClick={() => dropLine(l)}>×</button>
                          )}
                        </td>
                        <td><code>{l.barcode || '—'}</code></td>
                        <td><code>{l.uan || '—'}</code></td>
                        <td title={l.location ? 'Put away at ' + l.location : undefined}>
                          {l.product}
                          {l.source !== 'opened' && (
                            <span className="small" title="Not in the filtered set — found and taken onto the count"> · off-scope</span>
                          )}
                        </td>
                        <td>{l.section || '—'}</td>
                        <td>{l.brand || '—'}</td>
                        <td>{l.size || '—'}</td>
                        <td>{l.design || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{l.count || ''}</td>
                        <td className="num">
                          {open
                            ? <input type="number" min="0" step="1"
                              defaultValue={l.qty ?? ''} key={l.id + ':' + l.qty}
                              placeholder="—"
                              title="What is on the shelf. Empty means nobody has counted it yet — which is not zero."
                              onBlur={(e) => {
                                const v = e.target.value
                                if (v === (l.qty == null ? '' : String(l.qty))) return
                                setCount(l, v)
                              }}
                              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }} />
                            : (l.qty ?? <span className="small">—</span>)}
                        </td>
                        <td style={{ textAlign: 'right' }}>{l.stock}</td>
                        <td style={{ textAlign: 'right' }}>{money(l.cost_price)}</td>
                        <td style={{ textAlign: 'right' }}>{money(l.net_price)}</td>
                        <td>
                          <span className={'badge ' + PSA_LINE_BADGE[l.status][0]}>
                            {PSA_LINE_BADGE[l.status][1]}
                          </span>
                          {l.difference ? <span className="small psadiff">
                            {l.difference > 0 ? '+' : ''}{l.difference}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && (
                  <div className="empty" style={{ margin: 30 }}>
                    {shown.lines.length === 0 ? 'This count has no rows.'
                      : filters.show_all
                        ? 'Nothing matches those filters.'
                        : 'Nothing counted yet. Scan a tag, type into a row, or tick '
                          + 'Show All Rows to work down the whole list.'}
                  </div>
                )}
              </div>
              <Pager {...paged} noun="row" />

              {/* The foot of the screen: why the books are being changed, and the
                  steps between counting and changing them. Laid out in the order
                  they happen, left to right, so what comes next is where the eye
                  already is. */}
              <div className="psafoot">
                <div className="field psareason">
                  <label>Change Reason</label>
                  <input value={reason} onChange={(e) => setReason(e.target.value)}
                    onBlur={saveReason} disabled={!!shown.applied_at}
                    placeholder="Why the books are being corrected"
                    title="Goes onto every stock movement this count writes. An adjustment nobody can explain later is one nobody can defend." />
                </div>
                <div style={{ flex: 1 }} />
                {shown.status === 'counting' && (
                  <button className="btn" onClick={() => advance('completed',
                    `Finish counting ${shown.code}? It stops taking counts and goes for review.`)}>
                    Complete</button>
                )}
                {shown.status === 'completed' && (<>
                  <button className="btn" onClick={() => advance('counting')}
                    title="Go back and count more">Re-open</button>
                  <button className="btn" onClick={() => advance('reviewed')}>
                    Reviewed</button>
                </>)}
                {shown.status === 'reviewed' && (<>
                  <button className="btn" onClick={() => advance('completed')}>Back</button>
                  <button className="btn primary" onClick={() => advance('approved',
                    `Approve ${shown.code}? Approving does not move stock — Apply does.`)}>
                    Approve</button>
                </>)}
                {shown.can_apply && (
                  <button className="btn primary" disabled={busy || !atLeast(role, 'admin')}
                    onClick={doApply}
                    title={atLeast(role, 'admin')
                      ? 'Write the variance into the ledger, once, with the reason above'
                      : 'Correcting stock needs admin access — you are signed in as ' + role}>
                    Apply to stock</button>
                )}
                {['counting', 'completed', 'reviewed'].includes(shown.status) && (
                  <button className="btn" onClick={() => advance('cancelled',
                    `Cancel ${shown.code}? Its readings are kept but it can never correct stock.`)}>
                    Cancel</button>
                )}
              </div>
            </>
          )}

          {audit === null && !viewing && (
            <div className="empty" style={{ marginTop: 24, maxWidth: 620 }}>
              No count in progress. Set the filters on the left to say what is being
              counted, press <b>Search</b> to see how much that covers, then
              <b> New</b> to open the count.
            </div>
          )}

          <Section id="psa-history" title={`Past counts · ${past.length}`}
            defaultOpen={!audit}>
            {past.length === 0
              ? <div className="empty" style={{ marginTop: 16 }}>No counts recorded yet.</div>
              : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="items">
                    <thead><tr>
                      <th style={{ width: 110 }}>Count</th>
                      <th style={{ width: 130 }}>Started</th>
                      <th style={{ width: 110 }}>By</th>
                      <th style={{ width: 70, textAlign: 'right' }}>Rows</th>
                      <th style={{ width: 90, textAlign: 'right' }}>Counted</th>
                      <th style={{ width: 90, textAlign: 'right' }}>Missing</th>
                      <th style={{ width: 100 }}>Status</th>
                      <th>Reason</th>
                    </tr></thead>
                    <tbody>
                      {past.map((a) => (
                        <tr key={a.id} style={{ cursor: 'pointer' }}
                          title="Open this count"
                          onClick={async () => {
                            try {
                              const full = await api.psaGet(a.id)
                              if (full.status === 'counting') { setViewing(null); setAudit(full) }
                              else setViewing(full)
                              setReason(full.change_reason || '')
                            } catch { toast('Could not open that count', 'err') }
                          }}>
                          <td><b>{a.code}</b></td>
                          <td>{fmtDate(a.started_at)}</td>
                          <td>{a.started_by || '—'}</td>
                          <td style={{ textAlign: 'right' }}>{a.totals?.lines ?? 0}</td>
                          <td style={{ textAlign: 'right' }}>{a.totals?.counted_lines ?? 0}</td>
                          <td style={{ textAlign: 'right' }}>{money(a.totals?.missing)}</td>
                          <td>
                            <span className={'badge ' + (PSA_STATUS_BADGE[a.status] || 'draft')}>
                              {a.status}</span>
                            {a.applied_at && <span className="badge posted"> applied</span>}
                          </td>
                          <td className="small">{a.change_reason || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Section>
        </div>
      </div>
    </div>
  )
}


// Find a saved invoice — by its number, its supplier or its GRN number.
//
// The Documents list on the left holds only what was uploaded or keyed in here.
// Invoices that came in any other way — every receipt migrated from the old
// system — were never documents, so they are not on that list, and the screen
// read as though they had been lost. They are the GRNs: every one carries its
// invoice number, supplier, date and amount. This searches all of them, a page
// at a time, and the LR register beside them (a consignment names its invoice
// too). Opening one goes to its GRN.
const NO_INVOICE_FILTERS = { date_from: '', date_to: '', invoice_no: '', supplier: '', grn_no: '' }

function InvoiceFinder({ onOpenGrn }) {
  const [q, setQ] = useState('')
  const qd = useDebounced(q)
  // one filter per field, each narrowing further; typed ones wait for a pause
  const [f, setF] = useState(NO_INVOICE_FILTERS)
  const fd = useDebounced(f)
  const setField = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
  const anyFilter = Object.values(f).some((v) => v.trim()) || q.trim()
  const grnPage = useServerPaged(({ limit, offset }) =>
    api.purchasesPage({ limit, offset, q: qd, status: 'all', ...fd }),
  `inv|${qd}|${JSON.stringify(fd)}`, 25)
  const [lr, setLr] = useState(null)             // LR entries naming it, when searching
  const lrText = (fd.invoice_no || qd).trim()
  useEffect(() => {
    if (!lrText && !fd.supplier.trim()) { setLr(null); return }
    let live = true
    api.lrSearch({ q: lrText, supplier: fd.supplier.trim(), limit: 50 })
      .then((r) => { if (live) setLr(r) }).catch(() => {})
    return () => { live = false }
  }, [lrText, fd.supplier])
  const described = [
    qd.trim() && `matching “${qd.trim()}”`,
    fd.invoice_no.trim() && `invoice no “${fd.invoice_no.trim()}”`,
    fd.supplier.trim() && `supplier “${fd.supplier.trim()}”`,
    fd.grn_no.trim() && `GRN “${fd.grn_no.trim()}”`,
    (fd.date_from || fd.date_to) && `dated ${fd.date_from ? fmtDate(fd.date_from) : 'the start'} to ${fd.date_to ? fmtDate(fd.date_to) : 'today'}`,
  ].filter(Boolean).join(', ')
  return (
    <div className="editor" style={{ flex: 1, overflow: 'auto' }}>
      <h2 style={{ marginTop: 0 }}>Find a saved invoice</h2>
      <div className="small" style={{ color: 'var(--muted)', margin: '-6px 0 12px' }}>
        Every invoice booked in as a GRN — including those brought over from the old system.
        Search by invoice number, supplier or GRN number; open one to see its lines.
      </div>
      <SearchBox value={q} onChange={setQ} style={{ maxWidth: 440 }}
        placeholder="Quick search — invoice number, supplier or GRN no…" />
      <div className="invfilters" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', margin: '12px 0 4px' }}>
        <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>Invoice date from
          <input type="date" value={f.date_from} onChange={setField('date_from')} max={f.date_to || undefined} /></label>
        <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>to
          <input type="date" value={f.date_to} onChange={setField('date_to')} min={f.date_from || undefined} /></label>
        <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>Invoice number
          <input value={f.invoice_no} onChange={setField('invoice_no')} placeholder="e.g. 40610" style={{ width: 130 }} /></label>
        <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>Supplier name
          <input value={f.supplier} onChange={setField('supplier')} placeholder="e.g. Ramraj" style={{ width: 200 }} /></label>
        <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>GRN number
          <input value={f.grn_no} onChange={setField('grn_no')} placeholder="e.g. GRN15180" style={{ width: 130 }} /></label>
        <button className="btn" disabled={!anyFilter} onClick={() => { setF(NO_INVOICE_FILTERS); setQ('') }}
          title="Clear the search and every filter">Clear filters</button>
      </div>
      <div className="small" style={{ margin: '10px 0' }}>
        {grnPage.loading ? 'Searching…'
          : `${grnPage.total.toLocaleString('en-IN')} invoice${grnPage.total === 1 ? '' : 's'}`
            + (described ? ` ${described}` : ' saved') + ', newest first'}
      </div>
      {!grnPage.loading && grnPage.total === 0 && (
        <div className="empty" style={{ marginTop: 20 }}>No saved invoice matches. Try part of the number, or the supplier's name.</div>
      )}
      {grnPage.rows.length > 0 && (
        <div className="tablewrap">
          <table className="items">
            <thead><tr><th>Invoice no</th><th>Invoice date</th><th>Supplier</th><th>GRN</th>
              <th>Status</th><th style={{ textAlign: 'right' }}>Amount</th><th></th></tr></thead>
            <tbody>{grnPage.rows.map((p) => (
              <tr key={p.id} className="doc-row" style={{ cursor: 'pointer' }} onClick={() => onOpenGrn(p.id)}
                title="Open this invoice's GRN">
                <td className="mono">{p.invoice_number || '—'}</td>
                <td>{fmtDate(p.invoice_date)}</td>
                <td>{p.supplier_name || '—'}</td>
                <td className="mono">{p.grn_no || '#' + p.id}</td>
                <td><span className={'badge ' + (p.status === 'posted' ? 'confirmed' : 'uploaded')}>{p.status}</span></td>
                <td style={{ textAlign: 'right' }}>₹ {money(p.grand_total)}</td>
                <td><button className="btn" style={{ padding: '2px 10px' }}>Open →</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <Pager {...grnPage} noun="invoice" />
      {lr && lr.count > 0 && (
        <div style={{ marginTop: 22 }}>
          <h4 style={{ margin: '0 0 6px' }}>In the LR register · {lr.count.toLocaleString('en-IN')}
            {lr.shown < lr.count ? ` (first ${lr.shown})` : ''}</h4>
          <div className="small" style={{ color: 'var(--muted)', marginBottom: 8 }}>
            Consignments whose LR, invoice number or supplier matches — open LR Entry to work with them.</div>
          <div className="tablewrap">
            <table className="items">
              <thead><tr><th>Received</th><th>LR entry</th><th>LR no</th><th>Invoice no</th>
                <th>Supplier</th><th>Transport</th><th style={{ textAlign: 'right' }}>Pieces</th></tr></thead>
              <tbody>{lr.rows.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDate(e.recv_date)}</td><td className="mono">{e.lr_entry_no || '—'}</td>
                  <td className="mono">{e.lr_no || '—'}</td><td className="mono">{e.inv_no || '—'}</td>
                  <td>{e.supplier_name || '—'}</td><td>{e.transport || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{e.qty ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function LREntryView({ toast }) {
  const [rows, setRows] = useState([])
  const [docId, setDocId] = useState(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // The saved register, a page at a time from the server — all of it. Fetched
  // whole it stopped at the newest 500, and a register of tens of thousands
  // could not reach the rest.
  const savedPage = useServerPaged(({ limit, offset }) => api.lrPage({ limit, offset }), 'lr', 25)
  const refresh = savedPage.reload
  // A consignment scanned on the warehouse phone is written to this same
  // register, and the person who scanned it is on a dock, not at this desk — so
  // the desk must not have to reload the page to learn a lorry arrived. Polled
  // while the tab is on screen, and again the moment it comes back to the front.
  // Only `saved` is replaced: an open form, a search result and a half-typed
  // freight cell all live in their own state and are left alone.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') refresh().catch(() => {}) }
    const t = setInterval(tick, 15000)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick) }
  }, [refresh])

  // --- manual entry, dropdown masters and search ---
  const [form, setForm] = useState(null)         // null = closed, {} = new, row = edit
  const [opts, setOpts] = useState({})           // keyed dropdown lists
  const [lists, setLists] = useState({})         // masters with their own tables
  const loadOpts = useCallback(() => {
    api.masterOptions().then(setOpts).catch(() => {})
    // The open orders come back as whole rows, not names: the form stores an id
    // and shows a number, and a picker built on names alone could not tell two
    // orders to the same supplier apart. `poOpen` returns only CONFIRMED ones,
    // which is the same set the server will accept — so the form cannot offer a
    // choice the save would then refuse.
    Promise.all([api.listSuppliers(), api.agents(), api.transports(),
                 api.poOpen().catch(() => [])])
      .then(([s, a, t, po]) => setLists({
        suppliers: s.map((x) => x.name).filter(Boolean),
        agents: a.map((x) => x.name).filter(Boolean),
        transports: t.map((x) => x.name).filter(Boolean),
        purchase_orders: po,
      })).catch(() => {})
  }, [])
  useEffect(() => { loadOpts() }, [loadOpts])

  const [searching, setSearching] = useState(false)   // search panel open
  const [found, setFound] = useState(null)       // search results, null = not filtered
  // the register, and the rows just read off a page — both grow without limit,
  // and both are read a screenful at a time
  // 25, matching the invoice's line-items table rather than the 50 this had:
  // the register is a wide table and the pager stays hidden below 25 rows
  // anyway, so a page of 50 meant the control appeared only past 51 entries.
  // Search results are paged here; the unfiltered register by the server.
  const foundPage = usePaged(found ? found.rows : [], 25)
  const listPage = found ? foundPage : savedPage
  const shownCount = found ? found.rows.length : savedPage.total
  const extractPage = usePaged(rows, 50)
  const openNew = () => { setForm({}); setRows([]) }
  const openEdit = async (r) => {
    try { setForm(await api.lrGet(r.id)) } catch { toast('Could not open that entry', 'err') }
  }
  const afterSave = (_row, keepOpen) => {
    refresh()
    setFound(null)          // the saved row may not match the active filter — show the full list
    if (!keepOpen) setForm(null)
  }
  const removeEntry = async (r) => {
    if (!window.confirm(`Delete entry ${r.lr_entry_no || '#' + r.id} (${r.supplier_name || 'no supplier'})?`)) return
    try { await api.lrDelete(r.id); toast('Entry deleted', 'ok'); setForm(null); setFound(null); refresh() }
    catch (e) { toast(e.detail || 'Delete failed', 'err') }
  }

  const [dup, setDup] = useState(null)
  const onFile = async (e) => {
    const file = e.target.files[0]; if (!file) return
    setBusy(true); setNote('Reading register…')
    try {
      const r = await api.lrExtract(file)
      setRows(r.rows || []); setDocId(r.document_id); setNote(r.note || ''); setDup(r.duplicates || null)
      const d = r.duplicates
      if (d && (d.duplicates > 0 || d.doubtful > 0))
        toast(`Read ${d.total} rows · ${d.duplicates} duplicate, ${d.doubtful} doubtful`, 'ok')
      else
        toast(`Read ${r.rows?.length || 0} rows (${r.provider})`, 'ok')
    // err.detail is the sentence the server sent ("File storage: blob storage
    // refused the upload: HTTP 400 — …"); err.message is only the status code.
    // Showing the code alone turned every distinct failure into "Extract failed:
    // 500", which is the same toast whatever went wrong.
    } catch (err) { toast('Extract failed: ' + (err.detail || err.message), 'err'); setNote('') }
    setBusy(false); e.target.value = ''
  }
  const isExact = (r) => r._status === 'duplicate'         // excluded from save
  const isDoubtful = (r) => r._status === 'doubtful'       // kept, needs approval
  const upd = (i, k, v) => { const c = rows.map(x => ({ ...x })); c[i][k] = v; setRows(c) }
  const del = (i) => setRows(rows.filter((_, j) => j !== i))
  const save = async () => {
    if (!rows.length) { toast('Nothing to save', 'err'); return }
    // send new + (approved) doubtful rows; exact duplicates are dropped, and the server re-checks
    const clean = rows.filter(r => !isExact(r))
    if (!clean.length) { toast('All rows are exact duplicates — nothing new to save', 'err'); return }
    const r = await api.lrSave(docId, clean)
    const skipMsg = r.skipped_duplicates ? ` · ${r.skipped_duplicates} exact duplicate(s) skipped` : ''
    toast(`✓ Saved ${r.saved} LR entries${skipMsg} · masters updated`, 'ok')
    setRows([]); setNote(''); setDup(null); refresh()
  }
  // --- freight settlement on saved rows (Paid/ToPay · Freight · Cash/Chq) ---
  const [pending, setPending] = useState({})            // `${id}:${field}` → in-progress value
  const cellKey = (r, k) => `${r.id}:${k}`
  const cellVal = (r, k) => pending[cellKey(r, k)] ?? r[k] ?? ''
  const drop = (key) => setPending((p) => { const c = { ...p }; delete c[key]; return c })
  const commitCell = async (r, k) => {
    const key = cellKey(r, k)
    const raw = pending[key]
    if (raw === undefined || String(raw) === String(r[k] ?? '')) { drop(key); return }
    let val = raw === '' ? null : raw
    if (k === 'freight_amount' && val !== null) {
      if (isNaN(Number(val))) { toast('Freight must be a number', 'err'); drop(key); return }
      val = Number(val)
    }
    try {
      const upd = await api.lrUpdate(r.id, { [k]: val })
      // the register page is the server's — re-read it; a search result is ours
      refresh()
      if (found) setFound((f) => f && { ...f, rows: f.rows.map((x) => (x.id === upd.id ? upd : x)) })
      drop(key)
    } catch (err) { toast('Could not save: ' + (err.detail || err.message), 'err'); drop(key) }
  }

  const toSave = rows.filter(r => !isExact(r))
  const nDoubtful = rows.filter(isDoubtful).length
  const qtySum = toSave.reduce((s, x) => s + (+x.qty || 0), 0)
  return (
    <div className="screen">
      {/* the subtitle yields before any control does — a clipped button is a
          control someone cannot reach, a clipped sentence is only a shorter one */}
      <div className="pagehead">
        <h2>LR Entry</h2>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => setSearching((s) => !s)}
          title="Find entries by LR / invoice number, supplier, date, rack…">🔍 Search</button>
        <button className="btn" onClick={openNew}>📄 New entry</button>
        <label className="btn primary uploadbtn">{busy ? 'Reading…' : 'Import LR image / PDF'}
          <input type="file" accept="image/*,.pdf" onChange={onFile} disabled={busy} /></label>
      </div>
      <div className="screenbody">
        {form !== null && (
          <LREntryForm editing={form.id ? form : null} opts={opts} lists={lists}
            onDone={afterSave} onCancel={() => setForm(null)} toast={toast} reloadOpts={loadOpts} />
        )}
        {searching && (
          <LRSearchPanel toast={toast} lists={lists}
            onResults={setFound} onClear={() => setFound(null)} />
        )}
        {found && (
          <div className="warnbox clean" style={{ marginBottom: 14 }}>
            <h4 style={{ border: 'none', margin: 0 }}>
              {found.count} matching entr{found.count === 1 ? 'y' : 'ies'}
              {found.shown < found.count ? ` (showing ${found.shown})` : ''} · Σ pieces <b>{found.totals.qty}</b>
              {' · '}Σ bundles <b>{found.totals.bundle}</b>{' · '}Σ boxes <b>{found.totals.boxes}</b>
              {' · '}Σ goods value <b>₹ {money(found.totals.amount)}</b>
              {' · '}Σ freight <b>₹ {money(found.totals.freight_amount)}</b>
              {/* what the transporters are owed — freight plus the charge lines
                  under it, which is the figure a payment run actually needs */}
              {' · '}Σ transport charges <b>₹ {money(found.totals.freight_total)}</b>
            </h4>
          </div>
        )}
        {note && <div className="warnbox" style={{ marginBottom: 14 }}><h4 style={{ border: 'none', margin: 0, color: 'var(--muted)' }}>{note}</h4></div>}
        {dup && (dup.duplicates > 0 || dup.doubtful > 0) && (
          <div className="warnbox" style={{ marginBottom: 14, borderColor: 'var(--warn)' }}>
            <h4 style={{ border: 'none', margin: 0 }}>
              {dup.duplicates > 0 && <>🚫 {dup.duplicates} exact duplicate{dup.duplicates > 1 ? 's' : ''} (identical to an existing row) — skipped. </>}
              {dup.doubtful > 0 && <>⚠ {dup.doubtful} doubtful row{dup.doubtful > 1 ? 's' : ''} — same LR/Invoice but other values differ; the changed cells are highlighted, please verify before saving. </>}
              {dup.new} new row{dup.new === 1 ? '' : 's'}.
            </h4>
          </div>
        )}
        {rows.length === 0 && !savedPage.loading && savedPage.total === 0 && !found && form === null && (
          <div className="empty" style={{ marginTop: 40 }}>
            Import an LR register page to auto-extract its rows, or press <b>New entry</b> to key one in.
          </div>
        )}
        {rows.length > 0 && (
          <>
            <Section id="lr.extracted" title="Extracted rows — review & save">
              <div className="tablewrap">
                <table className="items" style={{ minWidth: 1560 }}>
                  <thead><tr><th style={{ minWidth: 70 }}>Status</th>{LR_COLS.map(([k, l, w]) => <th key={k} style={{ minWidth: w }}>{l}</th>)}<th></th></tr></thead>
                  <tbody>{extractPage.slice.map((r) => {
                    const i = rows.indexOf(r)
                    return (
                    <tr key={i} style={isExact(r) ? { background: 'var(--danger-bg)', opacity: 0.6 }
                      : isDoubtful(r) ? { background: 'var(--warn-bg)' } : undefined}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600 }}>
                        {isExact(r) ? <span style={{ color: 'var(--danger)' }} title="Identical to an existing row — will be skipped">🚫 duplicate</span>
                          : isDoubtful(r) ? <span style={{ color: 'var(--warn)' }}
                              title={'Same LR/Invoice, but these differ from the saved row:\n' +
                                (r._diffs || []).map(f => `${f}: saved “${r._conflict_with?.[f] ?? ''}” vs this “${r[f] ?? ''}”`).join('\n')}>⚠ verify</span>
                          : <span style={{ color: 'var(--ok)' }}>new</span>}
                        {/* a reading is not the page. When the register was written
                            in Tamil the row says so, and every translated cell can
                            be hovered to see exactly what the clerk wrote. */}
                        {r.source_language && (
                          <div style={{ color: 'var(--muted)', fontWeight: 400, marginTop: 3 }}
                            title={`Read in ${r.source_language} and translated to English:\n`
                              + Object.entries(r.original_values || {})
                                .map(([f, v]) => `${f}: ${v}`).join('\n')}>
                            🌐 {r.source_language}</div>
                        )}
                      </td>
                      {LR_COLS.map(([k]) => {
                        const changed = isDoubtful(r) && (r._diffs || []).includes(k)
                        const orig = r.original_values?.[k]
                        const charges = Object.entries(r.freight_charges || {})
                        return <td key={k} style={changed ? { background: 'var(--warn-line)' } : undefined}
                          title={changed ? `Saved row has: ${r._conflict_with?.[k] ?? '(blank)'}`
                            : orig ? `On the page (${r.source_language || 'original'}): ${orig}`
                            : k === 'freight_total' && charges.length
                              ? `Freight ${r.freight_amount ?? 0}\n`
                                + charges.map(([n, v]) => `${n} ${v}`).join('\n')
                              : undefined}>
                          {/* vision reads a register page's dates in whatever the page
                              used; the picker both corrects them and normalises them */}
                          {LR_DATE_COLS.has(k)
                            ? <DateField inline value={r[k]} onChange={(v) => upd(i, k, v)} />
                            : LR_READONLY_COLS.has(k)
                              /* the charge lines as the LR printed them. Read, not
                                 typed: the total beside them is the editable figure,
                                 and two ways to change one number is one too many */
                              ? <div className="cellsub" style={{ whiteSpace: 'normal', lineHeight: 1.5 }}>
                                  {charges.length
                                    ? charges.map(([n, v]) => `${n} ${v}`).join(' · ')
                                    : <span style={{ color: 'var(--muted)' }}>—</span>}</div>
                              : <input value={r[k] ?? ''} onChange={(e) => upd(i, k, e.target.value)} />}
                          {orig && <div className="cellsub" style={{ direction: 'ltr' }}>🌐 {orig}</div>}
                          {/* the page's own total is kept even when the lines
                              disagree with it — but never silently */}
                          {k === 'freight_total' && r.freight_note && (
                            <div className="cellsub" style={{ color: 'var(--warn)', whiteSpace: 'normal' }}>
                              ⚠ {r.freight_note}</div>)}</td>
                    })}<td><button className="btn" style={{ padding: '2px 7px' }} onClick={() => del(i)}>×</button></td></tr>
                    )
                  })}</tbody>
                </table>
              </div>
              <Pager {...extractPage} noun="read row" />
              {/* the totals are of EVERY row, not the page — a Σ that counted
                  only what is on screen would drop as you paged through it */}
              <div className="items-foot"><span>{toSave.length} to save{nDoubtful ? ` (incl. ${nDoubtful} to verify)` : ''}{rows.length !== toSave.length ? ` · ${rows.length - toSave.length} exact dup skipped` : ''}</span><span>Σ qty <b>{qtySum}</b></span>
                <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={save}>Save {toSave.length} Entr{toSave.length === 1 ? 'y' : 'ies'}</button></div>
            </Section>
          </>
        )}
        {shownCount > 0 && (
          <Section id="lr.saved" title={`${found ? 'Search results' : 'Saved LR entries'} · ${shownCount.toLocaleString('en-IN')}`} summary={`${shownCount.toLocaleString('en-IN')} row(s)`}>
            <div className="tablewrap">
              <table className="items reg">
                <thead><tr>
                  <th style={{ width: 66 }}>Invoice</th>
                  {LR_REG_COLS.map((c) => <th key={c.k} style={{ width: c.w }}
                    className={c.num ? 'num' : undefined}>{c.h}</th>)}
                  <th style={{ width: 96 }}>Received</th><th style={{ width: 44 }}>Files</th>
                  {/* actions last: the row reads left-to-right as data, and what
                      you can DO with it sits at the end where the eye finishes */}
                  <th style={{ width: 62 }}></th>
                </tr></thead>
                <tbody>{listPage.slice.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontSize: 11, fontWeight: 600 }}>
                      {r.mismatches && r.mismatches.length
                        ? <span style={{ color: 'var(--warn)' }} title={r.mismatches.map(m => `${m.field}: register ${m.register} vs invoice ${m.invoice}`).join('\n')}>⚠ conflict</span>
                        : r.matched ? <span style={{ color: 'var(--ok)' }}>✓ linked</span>
                        : <span style={{ color: 'var(--muted)' }}>pending</span>}
                    </td>
                    {LR_REG_COLS.map((c) => {
                      const k = c.k
                      const m = r.mismatches && r.mismatches.find(x => x.field === k)
                      const cls = (c.num ? 'num ' : '') + (c.mono ? 'mono' : '')
                      if (c.edit) return (
                        <td key={k} className={cls}
                          title={k === 'freight_total' && Object.keys(r.freight_charges || {}).length
                            ? 'The transporter’s G. TOTAL — editable.\n'
                              + `Freight ${r.freight_amount ?? 0}\n`
                              + Object.entries(r.freight_charges).map(([n, v]) => `${n} ${v}`).join('\n')
                            : 'Freight settlement — editable; saves when you leave the cell'}>
                          <input value={cellVal(r, k)}
                            onChange={(e) => setPending({ ...pending, [cellKey(r, k)]: e.target.value })}
                            onBlur={() => commitCell(r, k)}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }} /></td>
                      )
                      if (k === 'lr_entry_no') return (
                        <td key={k} className={cls}
                          title={r.entry_source === 'manual' ? 'Keyed in on the form' : 'Read off an imported register page'}>
                          {r.lr_entry_no || '—'}{' '}
                          <span style={{ color: 'var(--muted)' }}>{r.entry_source === 'manual' ? '✎' : '⬇'}</span></td>
                      )
                      // "2 / 1" — bundles and boxes are one fact about the packaging
                      const val = c.pair
                        ? `${r[k] ?? '—'} / ${r[c.pair] ?? '—'}`
                        : LR_DATE_COLS.has(k) ? fmtDate(r[k], '')
                        : (r[k] ?? '')
                      // what the page said, when it wasn't English — kept against
                      // the row so a reading can always be checked against it
                      const orig = r.original_values?.[k]
                      return (
                        <td key={k} className={cls}
                          style={m ? { background: 'var(--warn-bg)' } : undefined}
                          title={m ? `Register: ${m.register}\nInvoice: ${m.invoice}`
                            : orig ? `On the page (${r.source_language || 'original'}): ${orig}` : undefined}>
                          <div className="cellmain">{val}{m ? ' ⚠' : ''}{orig ? ' 🌐' : ''}</div>
                          {c.sub && r[c.sub]
                            ? <div className="cellsub">
                                {LR_DATE_COLS.has(c.sub) ? fmtDate(r[c.sub], '') : r[c.sub]}</div>
                            : null}
                        </td>
                      )
                    })}
                    {/* set by whoever takes the packages in, from the phone app */}
                    <td>{r.received_by
                      ? <span title="Recorded in the warehouse phone app">✓ {r.received_by}</span>
                      : <span style={{ color: 'var(--muted)' }} title="Nobody has taken this consignment in on the phone app yet">—</span>}</td>
                    <td style={{ textAlign: 'center' }}>{r.attachments?.length
                      ? <span title={r.attachments.map(a => `${a.doc_type}: ${a.filename}`).join('\n')}>📎 {r.attachments.length}</span>
                      : ''}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button className="iconbtn" onClick={() => openEdit(r)}
                        aria-label="Edit entry" title="Edit this entry">✎</button>
                      <button className="iconbtn danger" onClick={() => removeEntry(r)}
                        aria-label="Delete entry"
                        title={r.matched ? 'Linked to an invoice — unlink before deleting' : 'Delete this entry'}>🗑</button>
                    </td>{/* end row */}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Pager {...listPage} noun="entry" nouns="entries" />
          </Section>
        )}
        {found && found.rows.length === 0 && (
          <div className="empty" style={{ marginTop: 20 }}>No entries match those filters.</div>
        )}
      </div>
    </div>
  )
}

// ---------- masters (categories / agents / transports / dropdown lists) ----------
// The keyed lists behind the LR Entry form. FIXED ones are vocabulary the app
// owns — shown, but not editable, because a typo there would become a new "mode"
// of transport. The rest fill themselves from what is typed on the form.
const OPTION_TABS = [
  ['purchase_manager', 'Purchase Managers', 'Who owns the buy behind a consignment.'],
  ['lr_mode', 'LR Modes', 'How a consignment travelled. Fixed list.', 1],
  ['auto_transfer_location', 'Transfer Locations', 'Onward branch, or NONE to keep the goods here.', 1],
  ['attachment_type', 'Attachment Types', 'What a file pinned to an LR entry is. Fixed list.', 1],
]

function OptionList({ kind, title, blurb, fixed, values, reload, toast }) {
  const [adding, setAdding] = useState('')
  const add = async () => {
    const v = adding.trim(); if (!v) return
    try { await api.addMasterOption(kind, v); setAdding(''); reload(); toast(`Added “${v}”`, 'ok') }
    catch (e) { toast(e.detail || 'Could not add', 'err') }
  }
  const drop = async (v) => {
    if (!window.confirm(`Remove “${v}” from ${title}? Entries already using it keep it.`)) return
    try { await api.deleteMasterOption(kind, v); reload() }
    catch (e) { toast(e.detail || 'Could not remove', 'err') }
  }
  return (
    <>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {!fixed && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, maxWidth: 420 }}>
          <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={`Add to ${title}…`}
            onKeyDown={(e) => { if (e.key === 'Enter') add() }}
            style={{ flex: 1, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }} />
          <button className="btn primary" onClick={add}>Add</button>
        </div>
      )}
      {values.length === 0 && <div className="empty">Nothing in this list yet.</div>}
      {values.map((v) => (
        <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '11px 14px', marginBottom: 7, maxWidth: 420 }}>
          <span style={{ flex: 1 }}>{v}</span>
          {fixed
            ? <span className="small" style={{ color: 'var(--muted)' }}>fixed</span>
            : <button className="btn" style={{ padding: '2px 8px' }} onClick={() => drop(v)}>×</button>}
        </div>
      ))}
    </>
  )
}

// ---------- unit types: what a dozen becomes ----------
// Two lists that answer one question between them. The TYPES say how many
// individual items are in one of a unit — a pair is 2, a dozen is 12 — and the
// dozen→pieces conversion is arithmetic over exactly those numbers. The RULES say
// which type a given product IS, read off its description, so nobody re-picks
// "pillow cover = pair" on every receipt.
//
// Neither is retroactive, and the screen says so: a product freezes its own
// factor the day it is created, because stock on a shelf was counted under the
// rule that was in force when it arrived.
function UnitTypes({ toast }) {
  const [data, setData] = useState({ types: [], rules: [] })
  const [adding, setAdding] = useState({ code: '', name: '', pieces: '2', aliases: '' })
  const [rule, setRule] = useState({ pattern: '', unit_type: 'PAIR' })
  const [edit, setEdit] = useState({})              // code -> in-progress pieces
  const load = useCallback(() => api.unitTypes().then(setData).catch(() => {}), [])
  useEffect(() => { load() }, [load])

  const addType = async () => {
    const code = adding.code.trim().toUpperCase()
    if (!code) return
    try {
      await api.addUnitType({ code, name: adding.name.trim() || code,
        pieces: +adding.pieces || 1,
        aliases: adding.aliases.split(',').map(s => s.trim()).filter(Boolean) })
      setAdding({ code: '', name: '', pieces: '2', aliases: '' }); load()
      toast(`✓ ${code} added`, 'ok')
    } catch (e) { toast(e.detail || 'Could not add the unit', 'err') }
  }
  const savePieces = async (t) => {
    const v = +edit[t.code]
    setEdit((p) => { const c = { ...p }; delete c[t.code]; return c })
    if (!v || v === t.pieces) return
    try { await api.editUnitType(t.code, { pieces: v }); load(); toast(`✓ 1 ${t.code} = ${v} piece(s)`, 'ok') }
    catch (e) { toast(e.detail || 'Could not change it', 'err') }
  }
  const dropType = async (t) => {
    if (!window.confirm(`Remove the unit ${t.code}?\n\nRefused if any product is counted in it.`)) return
    try { await api.deleteUnitType(t.code); load() }
    catch (e) { toast(e.detail || 'Could not remove it', 'err') }
  }
  const addRule = async () => {
    const pattern = rule.pattern.trim()
    if (!pattern) return
    try {
      await api.addUnitRule({ pattern, unit_type: rule.unit_type, scope: 'keyword' })
      setRule({ ...rule, pattern: '' }); load()
      toast(`✓ “${pattern}” is counted in ${rule.unit_type}`, 'ok')
    } catch (e) { toast(e.detail || 'Could not add the rule', 'err') }
  }
  const dropRule = async (r) => {
    try { await api.deleteUnitRule(r.id); load() }
    catch (e) { toast(e.detail || 'Could not remove it', 'err') }
  }
  const box = { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8 }
  const inp = { background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }
  return (
    <>
      <h2 style={{ marginTop: 0 }}>Unit Types</h2>
      <div style={{ display: 'flex', gap: 8, margin: '14px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={adding.code} onChange={(e) => setAdding({ ...adding, code: e.target.value })}
          placeholder="CODE" style={{ ...inp, width: 110, textTransform: 'uppercase' }} />
        <input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })}
          placeholder="Name" style={{ ...inp, width: 150 }} />
        <input value={adding.pieces} onChange={(e) => setAdding({ ...adding, pieces: e.target.value })}
          placeholder="pieces" style={{ ...inp, width: 90 }} title="How many individual items are in one of these" />
        <input value={adding.aliases} onChange={(e) => setAdding({ ...adding, aliases: e.target.value })}
          placeholder="Aliases on invoices, comma separated" style={{ ...inp, flex: 1, minWidth: 220 }} />
        <button className="btn primary" onClick={addType}>Add unit</button>
      </div>
      <table className="items" style={{ maxWidth: 860 }}>
        <thead><tr><th style={{ width: 120 }}>Code</th><th>Name</th>
          <th style={{ width: 130, textAlign: 'right' }} title="Individual items in one of these">Pieces in one</th>
          <th>Printed on invoices as</th><th style={{ width: 80 }}></th></tr></thead>
        <tbody>
          {(data.types || []).map((t) => (
            <tr key={t.code}>
              <td className="mono"><b>{t.code}</b>{!t.countable && (
                <span className="badge review" style={{ marginLeft: 6 }} title="Measured, not counted — no piece labels">measured</span>)}</td>
              <td>{t.name}</td>
              <td className="num"><input value={edit[t.code] ?? t.pieces}
                onChange={(e) => setEdit({ ...edit, [t.code]: e.target.value })}
                onBlur={() => savePieces(t)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }} /></td>
              <td className="mono small" style={{ color: 'var(--muted)' }}>{(t.aliases || []).join(', ') || '—'}</td>
              <td>{t.is_seed
                ? <span className="small" style={{ color: 'var(--muted)' }}>built in</span>
                : <button className="btn" style={{ padding: '2px 8px' }} onClick={() => dropType(t)}>×</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 28 }}>Which unit a product is</h2>
      <div style={{ display: 'flex', gap: 8, margin: '14px 0', maxWidth: 620 }}>
        <input value={rule.pattern} onChange={(e) => setRule({ ...rule, pattern: e.target.value })}
          placeholder="wording in the description, e.g. pillow cover"
          onKeyDown={(e) => { if (e.key === 'Enter') addRule() }} style={{ ...inp, flex: 1 }} />
        <select value={rule.unit_type} onChange={(e) => setRule({ ...rule, unit_type: e.target.value })} style={inp}>
          {(data.types || []).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
        </select>
        <button className="btn primary" onClick={addRule}>Add rule</button>
      </div>
      {(data.rules || []).map((r) => (
        <div key={r.id} style={{ ...box, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 7, maxWidth: 620 }}>
          <span style={{ flex: 1 }}>“{r.pattern}”{r.scope === 'category' ? ' (category)' : ''}</span>
          <span className="mono">{r.unit_type}</span>
          <span className="small" style={{ color: 'var(--muted)' }}>{r.source}{r.hits ? ` · ${r.hits}×` : ''}</span>
          <button className="btn" style={{ padding: '2px 8px' }} onClick={() => dropRule(r)}>×</button>
        </div>
      ))}
    </>
  )
}

// ==========================================================================
//  The ERP masters — one renderer for all seventeen
//  ------------------------------------------------------------------------
//  Product, Brand, Tax, Item, Supplier, Trade Agreement, Agent, Tailor,
//  Transport, Configuration, Product Attributes, Attribute Filter, Employee,
//  Employee Incharge, HR Configuration, Salary Management, Employee In/Out.
//
//  None of them is written here. Each arrives as a DEFINITION from the server —
//  its groups, its fields, their types, which are mandatory, and every dropdown
//  already resolved — and this renders whatever it is handed. A field added to
//  the definition appears here with no change to this file, and the * it wears
//  is the same `req` flag the API refuses to save without, so the form and the
//  server can never disagree about what is required.
// ==========================================================================
// A checkbox is one word and a box. Given a field cell of its own — label above,
// box below — seven of them leave a section mostly white space with the controls
// scattered across it, which is what these forms looked like. They flow in a
// single dense row at the foot of their section instead, where a tick is next to
// its own name and the eye can run along them.
// ---------- voice into a form ----------
// One recogniser, driven two ways: a mic on a single field, and a mic that fills
// the whole record from one sentence. The rules for holding a microphone open are
// the same either way, so they live here rather than in each button.
//
// Language is shared with the Reports ask bar (same localStorage key): whoever
// set it to Tamil there meant it here too.
function useSpeechInput({ onFinal, onInterim }) {
  const [listening, setListening] = useState(false)
  const [err, setErr] = useState('')
  const [lang, setLangState] = useState(() => {
    try { return localStorage.getItem('essa_voice_lang') || 'en-IN' } catch { return 'en-IN' }
  })
  const rec = useRef(null)
  const blocked = voiceBlockedBecause()
  const setLang = (l) => {
    setLangState(l)
    try { localStorage.setItem('essa_voice_lang', l) } catch { /* private mode */ }
  }
  // a recogniser still holding the mic after this screen is gone is both a stuck
  // mic light and a callback firing into an unmounted component
  useEffect(() => () => { try { rec.current?.abort() } catch { /* already gone */ } }, [])

  const stop = () => { try { rec.current?.stop() } catch { /* not started */ } }
  const start = () => {
    if (blocked || listening) return
    setErr('')
    const r = new SpeechRec()
    rec.current = r
    r.lang = lang
    r.interimResults = true
    r.continuous = false            // one field, or one sentence, per press
    r.maxAlternatives = 1
    r.onresult = (e) => {
      let interim = '', final = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript
        if (e.results[i].isFinal) final += chunk; else interim += chunk
      }
      if (interim && onInterim) onInterim(interim)
      if (final) { setListening(false); onFinal(final.trim()) }
    }
    r.onerror = (e) => {
      setErr({
        'not-allowed': 'microphone permission was refused — allow it in the address bar',
        'service-not-allowed': 'the browser blocked speech recognition on this page',
        'no-speech': 'nothing was heard — try again, closer to the microphone',
        'audio-capture': 'no microphone was found',
        network: 'speech recognition could not reach the network',
        aborted: '',
      }[e.error] || `speech recognition failed (${e.error})`)
      setListening(false)
    }
    r.onend = () => setListening(false)
    try { r.start(); setListening(true) } catch { setErr('could not start the microphone') }
  }
  return { listening, err, start, stop, lang, setLang, blocked }
}

//: Tamil is transcribed as Tamil, and a master record has to be English — its
//: labels, its dropdown vocabularies and every search that will later look for
//: the row. So anything that is not English English goes to the server to be
//: understood and translated in one step (services/voice_form.py).
const isEnglish = (lang) => String(lang || '').toLowerCase().startsWith('en')

// The mic on one box. Hidden until the field is hovered or focused — thirty
// always-visible mics on a Product Master is thirty things to look past.
function FieldMic({ f, master, onValue, toast }) {
  const [busy, setBusy] = useState(false)
  const heardRef = useRef('')
  const take = async (text, lang) => {
    if (isEnglish(lang)) { onValue(coerceSpoken(f, text)); return }
    // Tamil: the box would otherwise end up holding "பில்லோ", and nobody finds
    // that product again by typing "pillow"
    heardRef.current = text
    setBusy(true)
    try {
      const r = await api.voiceFill(master, text, [f.key], lang)
      const got = r.fills?.[f.key]
      if (got !== undefined && got !== null) onValue(got)
      else if (r.reason === 'no-key') {
        onValue(text)
        toast('No vision/AI key is set, so Tamil cannot be translated — the Tamil words were kept', 'err')
      } else {
        onValue(text)
        toast(`Kept what was heard — “${text}” could not be placed in ${f.label}`, 'err')
      }
    } catch {
      onValue(text)
      toast('Translation failed — the Tamil words were kept so nothing is lost', 'err')
    }
    setBusy(false)
  }
  const { listening, err, start, stop, blocked, lang } = useSpeechInput({
    onFinal: (text) => take(text, lang),
  })
  if (blocked) return null            // the form still types; see the Dictate hint
  return (
    <button type="button" className={'fieldmic' + (listening ? ' on' : '') + (busy ? ' busy' : '')}
      onClick={() => (listening ? stop() : start())}
      title={err || (busy ? `Translating “${heardRef.current}”…`
        : listening ? 'Listening — say the value'
        : `Speak the ${f.label}${isEnglish(lang) ? '' : ' (Tamil is translated to English)'}`)}>
      {busy ? '…' : listening ? '⏹' : '🎤'}
    </button>
  )
}

// One sentence, several boxes. The form's own labels are the grammar — see
// voicefill.js — so the example offered here is built from this master's first
// few fields rather than written out for one of them.
function MasterDictate({ def, data, onFills, toast }) {
  const [heard, setHeard] = useState(null)
  const [busy, setBusy] = useState(false)
  // Nine labels repeat across the Employee master's two address blocks, so a
  // bare "City" in the filled list would not say which one moved.
  const shown = (f) => (f._dup ? `${f._group} · ${f.label}` : f.label)

  const take = async (text, spokenLang) => {
    if (isEnglish(spokenLang)) {
      const { fills, preamble } = parseDictation(def, text)
      if (fills.length) {
        setHeard({ text, filled: fills.map((x) => shown(x.field)), preamble })
        onFills(fills)
        toast(`✓ Filled ${fills.length} field${fills.length === 1 ? '' : 's'} by voice`, 'ok')
        return
      }
      // nothing matched a label. Rather than stop at "not understood", let the
      // server try — it also handles English phrased the way a person phrases it
    }
    setHeard({ text, working: true })
    setBusy(true)
    try {
      const targets = dictationTargets(def)
      // A form that is not a master record sends its OWN fields — see
      // api.voiceFillForm. Everything after this line is identical for both,
      // which is the point: one dictation control, one set of behaviours.
      const r = def.plainForm
        ? await api.voiceFillForm(
            targets.map((f) => ({ key: f.key, label: f.label, type: f.type,
                                  options: f.options })),
            text, { label: def.label, language: spokenLang })
        : await api.voiceFill(def.key, text, null, spokenLang)
      const fills = Object.entries(r.fills || {})
        .map(([key, value]) => ({ field: targets.find((f) => f.key === key), value }))
        .filter((x) => x.field)
      setHeard({ text, english: r.english, filled: fills.map((x) => shown(x.field)),
        preamble: r.unused, dropped: r.dropped, reason: r.reason })
      if (fills.length) {
        onFills(fills)
        toast(`✓ Filled ${fills.length} field${fills.length === 1 ? '' : 's'} by voice`, 'ok')
      } else if (r.reason === 'no-key') {
        toast('Tamil needs the vision/AI key — set it from “vision” in the header', 'err')
      } else {
        toast('Nothing in that could be placed on this form', 'err')
      }
    } catch {
      setHeard({ text, reason: 'the server could not be reached' })
      toast('Could not reach the server to understand that', 'err')
    }
    setBusy(false)
  }

  const { listening, err, start, stop, lang, setLang, blocked } =
    useSpeechInput({
      onFinal: (text) => take(text, lang),
      onInterim: (t) => setHeard({ text: t, interim: true }),
    })

  const sample = useMemo(() => {
    const fs = (def.groups || []).flatMap((g) => g.fields || [])
      .filter((f) => f.type !== 'check' && f.type !== 'date').slice(0, 3)
    const say = (f) => `${f.label.replace(/\s*\(.*\)$/, ' $&').replace(/[()]/g, '')} ${
      f.options?.length ? f.options[0] : f.type === 'num' || f.type === 'money' ? '10' : '…'}`
    return fs.map(say).join(', ')
  }, [def])

  if (blocked) {
    return (
      <span className="small" style={{ color: 'var(--muted)' }} title={blocked}>
        🎤 voice off — {blocked}
      </span>
    )
  }
  return (
    <>
      <span className="asklangs" title="Which language to listen for">
        {VOICE_LANGS.map(([l, short, full]) => (
          <button key={l} className={'asklang' + (lang === l ? ' on' : '')} title={`Listen for ${full}`}
            disabled={listening} onClick={() => setLang(l)}>{short}</button>
        ))}
      </span>
      <button className={'btn dictate' + (listening ? ' on' : '')} disabled={busy}
        onClick={() => (listening ? stop() : start())}
        title={isEnglish(lang)
          ? `Say the field name then its value, several in one breath — e.g. “${sample}”`
          : 'Speak in Tamil — it is understood and the form is filled in English'}>
        {busy ? '⏳ Understanding…' : listening ? '⏹ Listening…' : '🎤 Dictate'}
      </button>
      {(heard || err) && (
        <div className="heardstrip">
          {err && <span className="hwhy">{err}</span>}
          {heard && <>
            <b>heard</b> “{heard.text}”
            {/* what it was understood to MEAN, shown whenever that differs from
                what was said — a Tamil sentence filling English boxes has to be
                checkable, or it is a translation nobody can audit */}
            {heard.english && heard.english !== heard.text
              ? <> · <b>in English</b> “{heard.english}”</> : null}
            {heard.working ? <> · understanding…</> : null}
            {heard.filled?.length ? <> · <b>filled</b> {heard.filled.join(', ')}</> : null}
            {heard.dropped?.length
              ? <span className="hwhy"> · not a listed option, left alone: {heard.dropped.join(', ')}</span>
              : null}
            {heard.preamble && !heard.interim && !heard.working
              ? <span className="hwhy"> · not understood: “{heard.preamble}”</span> : null}
            {heard.reason === 'no-key'
              ? <span className="hwhy"> · Tamil needs the vision/AI key — set it from “vision” in the header</span>
              : heard.reason
                ? <span className="hwhy"> · {heard.reason}</span>
                : (!heard.interim && !heard.working && !heard.filled?.length && isEnglish(lang))
                  ? <span className="hwhy"> · say a field name first, e.g. “{sample}”</span> : null}
          </>}
        </div>
      )}
    </>
  )
}

function MasterCheck({ f, value, onChange }) {
  return (
    <label className="mcheck" title={f.help || f.label}>
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(f.key, e.target.checked)} />
      <span>{f.label}</span>
    </label>
  )
}

function MasterField({ f, value, onChange, master, toast }) {
  const set = (v) => onChange(f.key, v)
  const common = { value: value ?? '', onChange: (e) => set(e.target.value) }
  // A date is picked, not dictated — a misheard digit in a date is a wrong date
  // that looks right, and the picker is faster anyway.
  const mic = f.type !== 'date' && (
    <FieldMic f={f} master={master} toast={toast} onValue={(v) => set(
      // a description is added to; a one-line box is replaced, because a
      // mishearing there is re-dictated rather than edited
      f.type === 'textarea' && value ? `${value} ${v}`.trim() : v)} />
  )
  return (
    <div className={'field' + (mic ? ' hasmic' : '')} style={f.wide ? { gridColumn: '1 / -1' } : null}>
      <label>{f.label}{f.req ? ' *' : ''}</label>
      {mic}
      {f.type === 'textarea' ? <textarea rows={3} {...common} />
        : f.type === 'date' ? <DateField inline value={value} onChange={set} />
        : f.type === 'multiselect' ? (
          // a plain multi-select scrolls a 300-brand list into a 4-line box;
          // comma-separated text with the vocabulary behind it stays typeable
          <>
            <input list={'mopt-' + f.key} {...common}
              placeholder="type to pick, comma-separated for several" />
            <datalist id={'mopt-' + f.key}>
              {(f.options || []).map((o) => <option key={o} value={o} />)}
            </datalist>
          </>
        ) : f.options ? (
          <>
            <input list={'mopt-' + f.key} {...common} placeholder="type to search…" />
            <datalist id={'mopt-' + f.key}>
              {(f.options || []).map((o) => <option key={o} value={o} />)}
            </datalist>
          </>
        ) : <input type={f.type === 'num' || f.type === 'money' ? 'number' : 'text'}
              step="any" {...common} />}
      {f.help && f.type !== 'check' && <div className="srcnote" style={{ color: 'var(--muted)' }}>{f.help}</div>}
    </div>
  )
}

//: a child table (Tailor's works, Transport's city rates, Brand's B2B margins)
function MasterGrid({ grid, rows, onChange }) {
  const upd = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  return (
    <div className="section" style={{ marginTop: 14 }}>
      <h4>{grid.title}</h4>
      <div className="tablewrap">
      <table className="items">
        <thead><tr>{grid.columns.map((c) => <th key={c.key}>{c.label}</th>)}<th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {grid.columns.map((c) => (
                <td key={c.key} className={c.type === 'num' || c.type === 'money' ? 'num' : ''}>
                  <input list={c.options ? `g-${grid.key}-${c.key}` : undefined}
                    value={r[c.key] ?? ''} onChange={(e) => upd(i, c.key, e.target.value)} />
                  {c.options && (
                    <datalist id={`g-${grid.key}-${c.key}`}>
                      {c.options.map((o) => <option key={o} value={o} />)}
                    </datalist>
                  )}
                </td>
              ))}
              <td><button className="btn" style={{ padding: '2px 7px' }}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="items-foot">
        <span>{rows.length} row(s)</span>
        <button className="btn" style={{ marginLeft: 'auto', padding: '3px 10px' }}
          onClick={() => onChange([...rows, {}])}>+ add row</button>
      </div>
    </div>
  )
}

//: Product's Purchase Entry Attributes — which attributes a purchase entry asks
//: for, and how hard it asks
function MasterMatrix({ matrix, value, onChange }) {
  const get = (row, col) => !!(value?.[row]?.[col])
  const set = (row, col, on) => onChange({ ...value, [row]: { ...(value?.[row] || {}), [col]: on } })
  return (
    <div className="section" style={{ marginTop: 14 }}>
      <h4>{matrix.title}</h4>
      {matrix.help && <div className="calchint">{matrix.help}</div>}
      <table className="items" style={{ maxWidth: 560 }}>
        <thead><tr><th>Name</th>
          {matrix.columns.map((c) => <th key={c} style={{ width: 70, textAlign: 'center' }}>{c}</th>)}
        </tr></thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={row}>
              <td className="mono" style={{ fontSize: 11 }}>{row}</td>
              {matrix.columns.map((c) => (
                <td key={c} style={{ textAlign: 'center' }}>
                  <input type="checkbox" checked={get(row, c)}
                    onChange={(e) => set(row, c, e.target.checked)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MasterScreen({ mkey, onBack, toast }) {
  const [def, setDef] = useState(null)
  const [list, setList] = useState([])
  const [total, setTotal] = useState(0)            // matches in the database; list is capped
  const [q, setQ] = useState('')
  const [form, setForm] = useState(null)          // null = list, {} = new, {id} = edit
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api.masterRecords(mkey, q).then((r) => {
    setList(r.records); setTotal(r.total ?? r.records.length)
  }), [mkey, q])
  const recPage = usePaged(list, 50)
  useEffect(() => { api.masterDefinition(mkey).then(setDef); setForm(null) }, [mkey])
  useEffect(() => { load() }, [load])
  // a settings master is one row, not a list — open it straight away
  useEffect(() => {
    if (def?.singleton && form === null) setForm(list[0] ? { ...list[0] } : {})
  }, [def, list])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!def) return <div className="empty">Loading…</div>
  const data = form?.data || {}
  const setField = (k, v) => setForm({ ...form, data: { ...data, [k]: v } })
  // Several fields at once, from one dictated sentence. Applied in a single
  // setForm — field by field, each would be computed against the same stale
  // `data` and only the last one would survive.
  const applyFills = (fills) => {
    const next = { ...data }
    fills.forEach(({ field, value }) => {
      next[field.key] = field.type === 'date' ? (toISODate(value) || value) : value
    })
    setForm({ ...form, data: next })
  }
  const blank = () => {
    const d = {}
    def.groups.forEach((g) => g.fields.forEach((f) => { if (f.default !== undefined) d[f.key] = f.default }))
    setForm({ data: d, grids: {}, matrix: {} })
  }
  const save = async () => {
    setBusy(true)
    try {
      const body = { data, grids: form.grids || {}, matrix: form.matrix || {} }
      const r = form.id ? await api.masterUpdate(mkey, form.id, body)
        : await api.masterCreate(mkey, body)
      toast(`✓ ${def.label} saved — ${r.name || r.code || '#' + r.id}`, 'ok')
      await load()
      if (!def.singleton) setForm(null); else setForm({ ...r })
    } catch (e) { toast(e.detail || 'Could not save', 'err') }
    setBusy(false)
  }
  const remove = async (r) => {
    if (!window.confirm(`Delete ${def.label} “${r.name || r.code || r.id}”?`)) return
    try { await api.masterDelete(mkey, r.id); toast('Deleted', 'ok'); setForm(null); load() }
    catch (e) { toast(e.detail || 'Could not delete', 'err') }
  }

  return (
    <div className="screen">
      <div className="pagehead">
        <button className="btn" onClick={onBack}>‹ Masters</button>
        <h2>{def.label}</h2>
        <span className="small pagesub">{def.sub}</span>
        <div style={{ flex: 1 }} />
        {!def.singleton && form === null && (
          <button className="btn primary" onClick={blank}>📄 New {def.label}</button>
        )}
        {/* Voice sits with the form's own actions, not in a settings screen: it
            is how this record gets filled in, and it is offered at the moment
            somebody is looking at 30 empty boxes. */}
        {form !== null && (
          <MasterDictate def={def} data={data} toast={toast} onFills={applyFills} />
        )}
        {form !== null && !def.singleton && (
          <button className="btn" onClick={() => setForm(null)}>✕ Close</button>
        )}
      </div>

      <div className="screenbody">
      {form !== null ? (
        <>
          {/* Inputs in a responsive grid — three or four columns on a wide screen
              rather than two enormous ones — then the section's checkboxes in a
              dense row beneath a rule. Every section then has the same shape:
              things you type, then things you tick. */}
          {def.groups.map((g) => {
            const checks = g.fields.filter((f) => f.type === 'check')
            const typed = g.fields.filter((f) => f.type !== 'check')
            return (
              <div className="section" key={g.title}>
                <h4>{g.title}</h4>
                {typed.length > 0 && (
                  <div className="mgrid">
                    {typed.map((f) => (
                      <MasterField key={f.key} f={f} value={data[f.key]} onChange={setField}
                        master={mkey} toast={toast} />
                    ))}
                  </div>
                )}
                {checks.length > 0 && (
                  <div className={'mchecks' + (typed.length ? '' : ' bare')}>
                    {checks.map((f) => (
                      <MasterCheck key={f.key} f={f} value={data[f.key]} onChange={setField} />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {(def.grids || []).map((grid) => (
            <MasterGrid key={grid.key} grid={grid} rows={form.grids?.[grid.key] || []}
              onChange={(rows) => setForm({ ...form, grids: { ...(form.grids || {}), [grid.key]: rows } })} />
          ))}
          {def.matrix && (
            <MasterMatrix matrix={def.matrix} value={form.matrix || {}}
              onChange={(m) => setForm({ ...form, matrix: m })} />
          )}
          <div style={{ display: 'flex', gap: 8, margin: '16px 0 30px' }}>
            <div style={{ flex: 1 }} />
            {form.id && <button className="btn" onClick={() => remove(form)}>Delete</button>}
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : `Save ${def.label}`}</button>
          </div>
        </>
      ) : (
        <>
          <SearchBox value={q} onChange={setQ} placeholder={`Search ${def.label}…`} style={{ maxWidth: 320 }} />
          <div className="small" style={{ margin: '10px 0', color: 'var(--muted)' }}>
            {total > list.length
              ? <>Showing the newest {list.length} of {total.toLocaleString()} record(s) — search to narrow</>
              : <>{list.length} record(s)</>} · {def.groups.reduce((n, g) => n + g.fields.length, 0)} fields,
            {' '}{def.groups.reduce((n, g) => n + g.fields.filter((f) => f.req).length, 0)} mandatory
          </div>
          {list.length === 0 && <div className="empty" style={{ marginTop: 30 }}>
            Nothing in {def.label} yet — press <b>New {def.label}</b>.</div>}
          {recPage.slice.map((r) => (
            <div key={r.id} className="doc-row" onClick={() => setForm({ ...r })}
              style={{ background: 'var(--panel)', border: '1px solid var(--line)',
                borderRadius: 8, padding: '11px 14px', marginBottom: 7, maxWidth: 720 }}>
              <div className="t">{r.name || r.code || '#' + r.id}</div>
              <div className="m">
                {r.code && <span className="mono">{r.code}</span>}
                {!r.active && <span className="badge review">inactive</span>}
                <span style={{ marginLeft: 'auto' }}>
                  {Object.values(r.data || {}).filter((v) => v !== '' && v != null).length} field(s) filled</span>
              </div>
            </div>
          ))}
          <Pager {...recPage} noun="record" style={{ maxWidth: 720 }} />
        </>
      )}
      </div>
    </div>
  )
}

// The masters this app already RUNS on, as opposed to the seventeen it now also
// carries. These are not reference data: a category decides how a product is
// classified at GRN, a unit type decides whether a billed dozen becomes twelve
// pieces or six pairs, and agents and transporters fill themselves from what the
// extractor reads off documents. They keep their own editors — a keyed list and
// a conversion table are not a form — and the hub opens them like anything else.
const BUILTIN_MASTERS = [
  ['categories', 'Product Categories', 'Category Master', '▦',
    'From GRN PRODUCT DETAILS.xlsx — what every product is classified as'],
  ['units', 'Unit Types', 'Unit & Conversion Master', '⚖',
    'Pieces in a dozen, pieces in a pair — what a billed dozen becomes on the shelf'],
  ['agents', 'Agents', 'Agent Master', '👤',
    'Fills itself from the agent named on invoices and LR pages'],
  ['transports', 'Transporters', 'Transport Master', '🚚',
    'Fills itself from the transporter named on invoices and LR pages'],
  ...OPTION_TABS.map(([k, label, blurb, fixed]) =>
    [k, label, fixed ? 'Fixed list' : 'Open list', '▤', blurb]),
]

//: the frame a built-in master opens in, so every master — generic or bespoke —
//: comes back to the hub the same way
function MasterPane({ title, sub, onBack, children }) {
  return (
    <div className="screen">
      {/* The band, not a heading floating inside the scroll area. A master used
          to draw its title with the page header's padding and border stripped
          off, so opening one from the hub swapped a full-width white bar for
          bare text — the same screen furniture appearing and disappearing as
          you moved between modules. */}
      <div className="pagehead">
        <button className="btn" onClick={onBack}>‹ Masters</button>
        <h2>{title}</h2>
        {sub && <span className="small pagesub">{sub}</span>}
      </div>
      <div className="screenbody">{children}</div>
    </div>
  )
}

function MasterCard({ n, icon, label, sub, meta, note, flag, onClick }) {
  return (
    <button className="mastercard" onClick={onClick} title={note || meta}>
      <span className="mc-icon">{icon}</span>
      <span className="mc-body">
        <b>{label}</b>
        <span className="mc-sub">{sub}</span>
        {meta && <span className="mc-meta">{meta}</span>}
      </span>
      <span className="mc-n">{n}</span>
      {flag && <span className="mc-flag" title={flag}>⚠</span>}
    </button>
  )
}

// ONE hub for every master. It used to be two places — a sidebar listing the
// eight this app runs on, and a card grid of the seventeen from the ERP — so
// "the masters" meant a different screen depending on which one you were after,
// and the sidebar list gave no clue what any of them held. Now they are one
// grid, in two labelled groups, because the difference between them is real and
// worth stating: the first seventeen are reference data, the last eight are
// wired into extraction, GRN and labelling and are working right now.
function Masters({ toast }) {
  const [open, setOpen] = useState(null)      // null = hub, else {kind, key}
  const [erp, setErp] = useState([])
  const [cats, setCats] = useState(null)
  const [agents, setAgents] = useState([])
  const [transports, setTransports] = useState([])
  const [opts, setOpts] = useState({})
  const [q, setQ] = useState('')
  const [section, setSection] = useState('')
  const loadOpts = useCallback(() => api.masterOptions().then(setOpts).catch(() => {}), [])
  useEffect(() => {
    api.masterList().then(setErp).catch(() => {})
    api.categories().then(setCats).catch(() => {})
    api.agents().then(setAgents).catch(() => {})
    api.transports().then(setTransports).catch(() => {})
    loadOpts()
  }, [loadOpts])

  // Computed before any branch: a hook cannot be called conditionally, and the
  // 686-code category master is exactly the list that needs paging.
  const catShown = cats ? cats.items.filter((c) =>
    (!section || c.section === section)
    && (!q || c.name.toLowerCase().includes(q.toLowerCase()))) : []
  const catPage = usePaged(catShown, 100)

  // one of the seventeen — the generic renderer handles all of them
  if (open?.kind === 'erp') {
    return <MasterScreen mkey={open.key} onBack={() => setOpen(null)} toast={toast} />
  }

  const back = () => setOpen(null)
  const meta = BUILTIN_MASTERS.find(([k]) => k === open?.key)
  if (open?.kind === 'builtin') {
    const [key, label, sub, , note] = meta
    if (key === 'categories') {
      const shown = catShown
      return (
        <MasterPane title={label} sub={`${cats ? cats.count : 0} codes`} onBack={back}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={section} onChange={(e) => setSection(e.target.value)}
              style={{ background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px' }}>
              <option value="">All sections</option>
              {(cats?.sections || []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <SearchBox value={q} onChange={setQ} placeholder="Search category…" style={{ width: 240 }} />
            <span className="small" style={{ color: 'var(--muted)' }}>{shown.length} shown</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(230px, 100%), 1fr))', gap: 8 }}>
            {catPage.slice.map((c) => (
              <div key={c.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px' }}>
                <span className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>{c.section}</span>
                <div>{c.name}</div>
              </div>
            ))}
          </div>
          <Pager {...catPage} noun="category" nouns="categories" />
        </MasterPane>
      )
    }
    if (key === 'units') {
      return <MasterPane title={label} sub={sub} onBack={back}><UnitTypes toast={toast} /></MasterPane>
    }
    if (key === 'agents' || key === 'transports') {
      const rows = key === 'agents' ? agents : transports
      return (
        <MasterPane title={label} sub={`${rows.length} on record`} onBack={back}>
          {rows.length === 0 && <div className="empty" style={{ marginTop: 24 }}>None yet.</div>}
          {rows.map((r) => (
            <div key={r.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '11px 14px', marginBottom: 7, maxWidth: 520 }}>
              {r.name}{r.phone ? ' · ' + r.phone : ''}</div>
          ))}
        </MasterPane>
      )
    }
    // a keyed dropdown list (purchase managers, LR modes, transfer locations…)
    const tab = OPTION_TABS.find(([k]) => k === key)
    return (
      <MasterPane title={label} sub={sub} onBack={back}>
        <OptionList kind={tab[0]} title={tab[1]} blurb={tab[2]} fixed={tab[3]}
          values={opts[tab[0]] || []} reload={loadOpts} toast={toast} />
      </MasterPane>
    )
  }

  const builtinCount = (k) => k === 'categories' ? (cats?.count ?? 0)
    : k === 'agents' ? agents.length
    : k === 'transports' ? transports.length
    : (opts[k] || []).length
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(258px, 100%), 1fr))', gap: 10 }

  return (
    <div className="screen">
      <div className="pagehead">
        <h2>Masters</h2>
        <div className="pagesub small">
          The reference data the warehouse runs on, and the lists this app fills for itself
        </div>
      </div>
      <div className="screenbody">
      <h5 className="masterhead" style={{ marginTop: 0 }}>ERP masters</h5>
      <div style={grid}>
        {erp.map((m, i) => (
          <MasterCard key={m.key} n={m.count || i + 1} icon={m.icon} label={m.label} sub={m.sub}
            meta={`${m.fields} fields · ${m.required} required`
              + (m.grids.length ? ` · ${m.grids.length} grid` : '')
              + (m.has_matrix ? ' · matrix' : '')}
            note={m.note}
            flag={m.unverified ? 'Fields inferred — no screenshot supplied' : null}
            onClick={() => setOpen({ kind: 'erp', key: m.key })} />
        ))}
      </div>

      <h5 className="masterhead">In use by this app</h5>
      <div style={grid}>
        {BUILTIN_MASTERS.map(([key, label, sub, icon, note]) => (
          <MasterCard key={key} n={builtinCount(key) || '—'} icon={icon} label={label}
            sub={sub} note={note}
            onClick={() => setOpen({ kind: 'builtin', key })} />
        ))}
      </div>
      </div>
    </div>
  )
}

// ==========================================================================
//  Label Designer · QR / Label Printing
//  ------------------------------------------------------------------------
//  Two screens, on purpose, because two different people use them.
//
//  A template is a LAYOUT: "product_name sits at 2mm/6mm in 8pt bold, the QR is
//  a 20mm square at 28mm/12mm". It holds field REFERENCES and never a product's
//  values. That is what lets one template print the whole warehouse, and what
//  makes a corrected price appear on the next sticker without anyone reopening
//  the designer. Designing is occasional and careful; printing is daily and in
//  a hurry, and putting them on one screen would mean the daily job walks past
//  every control of the careful one.
//
//  Millimetres throughout, because a label is cut to a physical size and the
//  person checking the output holds a ruler against it. `PX_PER_MM` is a zoom
//  factor on the screen only — nothing is ever stored in pixels.
// ==========================================================================

//: pt → screen px at a given zoom. A font size is in points because that is
//: what a font size is; everything else on a label is in millimetres.
const ptPx = (pt, px) => (pt / 72) * 25.4 * px
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
//: Positions snap to a half-millimetre. Free-floating decimals look identical on
//: screen and produce labels whose rows are a hair out of line across a sheet.
const snap = (v) => Math.round(v * 2) / 2

// One label, drawn from a template and a set of values. The same component is
// the designer's canvas and the printing screen's proof, so what someone
// designs is literally what the other screen shows them before they print.
// `interactive` is what separates the two.
function LabelSurface({ tpl, values, symbols, px, selId, onSelect, onChange,
                       interactive, specs, innerRef, onBegin }) {
  const els = [...(tpl.elements || [])].sort((a, b) => a.z - b.z)
  // Typing directly on the label. Local to the canvas because it is a gesture,
  // not a property: it starts on a double-click, ends on Enter or a click
  // elsewhere, and only then does anything reach the draft.
  const [editing, setEditing] = useState(null)   // {id, value}
  // The same thing in a ref, because Escape has to be able to cancel the edit
  // BEFORE the blur that closing the box provokes — a cancel that a stray blur
  // can still commit is not a cancel.
  const editRef = useRef(null)
  const begin = onBegin || (() => {})

  // What a text box currently reads — the same expression the printer uses, so
  // what is typed over is exactly what would have printed.
  const shownText = (e) => (
    (e.use_text || e.field === 'custom_text') ? (e.text || '') : (values[e.field] ?? ''))

  const startEdit = (ev, el, spec) => {
    if (!interactive || el.locked) return
    if (!['text', 'static'].includes(spec.kind)) return
    ev.preventDefault(); ev.stopPropagation()
    onSelect(el.id)
    const start = { id: el.id, value: String(shownText(el)) }
    editRef.current = start; setEditing(start)
  }

  const commitEdit = (keep) => {
    const ed = editRef.current
    editRef.current = null
    setEditing(null)
    if (!ed || !keep) return
    const el = els.find((x) => x.id === ed.id)
    if (!el || String(shownText(el)) === ed.value) return
    // Emptying a field's box is how you give the product's own value back —
    // otherwise a mistyped override would be a blank line with no visible cause.
    onChange(el.id, el.field === 'custom_text'
      ? { text: ed.value }
      : { text: ed.value, use_text: ed.value !== '' })
  }

  // Selecting is separate from dragging, because a LOCKED element must still be
  // selectable — the properties panel is the only place its lock can be undone,
  // and an element you cannot select is one you cannot unlock.
  const pick = (ev, el) => {
    if (!interactive) return
    ev.stopPropagation()
    if (editing && editing.id === el.id) return   // clicking inside the editor
    onSelect(el.id)
    if (!el.locked) drag(ev, el, 'move')
  }

  const drag = (ev, el, mode) => {
    if (!interactive || el.locked) return
    ev.preventDefault(); ev.stopPropagation()
    onSelect(el.id)
    const x0 = ev.clientX, y0 = ev.clientY
    const o = { x: el.x, y: el.y, w: el.w, h: el.h }
    const square = specs[el.field]?.kind === 'qr'
    // One history entry for the whole gesture, taken on the first millimetre
    // that actually moves: an undo that walks back through every frame of a drag
    // is unusable, and a click that selects a box is not an edit to undo.
    let opened = false
    const move = (e) => {
      if (!opened) { opened = true; begin() }
      const dx = (e.clientX - x0) / px, dy = (e.clientY - y0) / px
      if (mode === 'move') {
        onChange(el.id, { x: snap(clamp(o.x + dx, 0, tpl.width_mm - o.w)),
                          y: snap(clamp(o.y + dy, 0, tpl.height_mm - o.h)) },
                 { silent: true })
      } else {
        let w = snap(clamp(o.w + dx, 1, tpl.width_mm - o.x))
        let h = snap(clamp(o.h + dy, 0.3, tpl.height_mm - o.y))
        // a QR is square by definition — a stretched symbol is an unreadable one
        if (square) { w = h = Math.min(w, h) }
        onChange(el.id, { w, h }, { silent: true })
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="lsurface" ref={innerRef}
      style={{ width: tpl.width_mm * px, height: tpl.height_mm * px,
               border: tpl.border ? '1px solid #000' : '1px dashed #ccc',
               fontFamily: tpl.font }}
      onPointerDown={() => { if (!interactive) return; commitEdit(true); onSelect(null) }}>
      {els.map((e) => {
        const spec = specs[e.field]
        if (!spec) return null
        const sel = interactive && selId === e.id
        const box = {
          position: 'absolute', left: e.x * px, top: e.y * px,
          width: e.w * px, height: e.h * px, zIndex: e.z,
          opacity: e.visible === false ? (interactive ? 0.28 : 0) : 1,
          outline: sel ? '1.5px solid var(--brand)' : (e.border ? '.5px solid #000' : 'none'),
          cursor: interactive ? (e.locked ? 'not-allowed' : 'move') : 'default',
        }
        let inner
        if (spec.kind === 'qr') {
          inner = <div className="lqr" style={{ width: '100%', height: '100%', background: '#fff' }}
            dangerouslySetInnerHTML={{ __html: symbols.qr_svg || '' }} />
        } else if (spec.kind === 'barcode') {
          inner = <div className="lqr" style={{ width: '100%', height: '100%', background: '#fff' }}
            dangerouslySetInnerHTML={{ __html: symbols.barcode_svg || '' }} />
        } else if (spec.kind === 'line') {
          inner = <div style={{ width: '100%', height: '100%', background: e.color || '#000' }} />
        } else if (spec.kind === 'image') {
          inner = e.src
            ? <img src={e.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <span className="lph">logo</span>
        } else {
          const raw = shownText(e)
          const txt = `${e.prefix || ''}${e.uppercase ? String(raw).toUpperCase() : raw}${e.suffix || ''}`
          const type = {
            display: 'block', width: '100%', height: '100%',
            fontFamily: e.font || tpl.font, fontSize: ptPx(e.size, px),
            lineHeight: `${e.h * px}px`, fontWeight: e.bold ? 700 : 400,
            fontStyle: e.italic ? 'italic' : 'normal',
            textAlign: e.align || 'left', color: e.color || '#000',
          }
          inner = editing && editing.id === e.id ? (
            // eslint-disable-next-line jsx-a11y/no-autofocus
            <input className="ltextin" autoFocus value={editing.value}
              style={{ ...type, textTransform: e.uppercase ? 'uppercase' : 'none' }}
              onChange={(ev) => {
                const next = { id: e.id, value: ev.target.value }
                editRef.current = next; setEditing(next)
              }}
              onPointerDown={(ev) => ev.stopPropagation()}
              onBlur={() => commitEdit(true)}
              onKeyDown={(ev) => {
                ev.stopPropagation()          // arrow keys move the caret, not the box
                if (ev.key === 'Enter') { ev.preventDefault(); commitEdit(true) }
                if (ev.key === 'Escape') { ev.preventDefault(); commitEdit(false) }
              }} />
          ) : (
            <span style={{ ...type, overflow: 'hidden', whiteSpace: 'nowrap',
                           textOverflow: 'ellipsis' }}>
              {txt === '' ? (interactive ? <span className="lph">{spec.label}</span> : '') : txt}
            </span>
          )
        }
        return (
          <div key={e.id} style={box}
            title={interactive ? `${spec.label}${e.locked ? ' · locked' : ''}`
              + (['text', 'static'].includes(spec.kind) && !e.locked ? ' · double-click to type over it' : '')
              : undefined}
            onDoubleClick={(ev) => startEdit(ev, e, spec)}
            onPointerDown={(ev) => pick(ev, e)}>
            {inner}
            {sel && !e.locked && (
              <span className="lhandle" onPointerDown={(ev) => drag(ev, e, 'resize')}
                title="Drag to resize" />
            )}
            {sel && e.locked && <span className="llock" title="Locked — unlock it in Properties to move it">🔒</span>}
            {/* A line that has stopped following the product prints the same
                words on every garment. That is sometimes exactly right and
                sometimes a mistake nobody would spot on screen — so it is
                marked on the canvas, not just in the panel. */}
            {interactive && e.use_text && !(editing && editing.id === e.id) && (
              <span className="lfixed" title={`Fixed text — this box no longer shows the product's ${spec.label}. Clear it to get the live value back.`}>✎</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

//: Zoom steps, in screen pixels per millimetre. 8 shows a 50mm label at 400px,
//: which is about the size it prints at on a normal monitor.
const ZOOMS = [4, 6, 8, 11, 15]

//: The stock sizes the server offers, if it is old enough not to offer any.
//: Typing a size always works, so this is a convenience and never a constraint.
const FALLBACK_SIZES = [
  { key: '50x35', w: 50, h: 35, label: '50 × 35 — standard garment tag' },
  { key: '100x150', w: 100, h: 150, label: '100 × 150 — shipping' },
]

// The label's own size — a control, not a number buried three panels away.
// Presets are the roll someone actually loaded; the two boxes are for the die
// that is not on the list. Both go through one `onResize`, so a preset and a
// typed size do exactly the same thing to the design.
function SizeBox({ draft, sizes, scaleOn, onScaleOn, onResize, column }) {
  // Held as text while it is being typed. Clamping "1" to 10 the instant it is
  // typed makes "100" impossible to enter — so the numbers are taken on Enter
  // or when the box is left, and clamped then.
  const [w, setW] = useState(String(draft.width_mm))
  const [h, setH] = useState(String(draft.height_mm))
  useEffect(() => { setW(String(draft.width_mm)); setH(String(draft.height_mm)) },
    [draft.width_mm, draft.height_mm])
  const list = (sizes && sizes.length) ? sizes : FALLBACK_SIZES
  const here = `${+draft.width_mm}x${+draft.height_mm}`
  const preset = list.find((s) => `${s.w}x${s.h}` === here)
  return (
    <div className={'lsize' + (column ? ' col' : '')}>
      <select value={preset ? preset.key : ''} title="The label stock this design is cut to"
        onChange={(e) => {
          const s = list.find((x) => x.key === e.target.value)
          if (s) onResize(s.w, s.h)
        }}>
        <option value="">{preset ? 'Custom size…' : `Custom · ${draft.width_mm} × ${draft.height_mm} mm`}</option>
        {list.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <div className="mm">
        <input type="number" step="0.5" min="10" max="300" value={w} title="Width in millimetres"
          onChange={(e) => setW(e.target.value)}
          onBlur={() => onResize(parseFloat(w), parseFloat(h))}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }} />
        <span>×</span>
        <input type="number" step="0.5" min="10" max="300" value={h} title="Height in millimetres"
          onChange={(e) => setH(e.target.value)}
          onBlur={() => onResize(parseFloat(w), parseFloat(h))}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }} />
        <span>mm</span>
        <button className="btn" title="Turn the label on its side"
          onClick={() => onResize(draft.height_mm, draft.width_mm)}>⇄</button>
      </div>
      <label className="chk" title="On: the whole design grows or shrinks with the label, type included — a 50mm design becomes the same design at 100mm. Off: the fields keep their millimetre positions and only the ones hanging over the new edge are pulled back in.">
        <input type="checkbox" checked={scaleOn} onChange={(e) => onScaleOn(e.target.checked)} />
        {' '}Scale the design with the label
      </label>
    </div>
  )
}

function LabelDesigner({ toast, role }) {
  const [cat, setCat] = useState(null)            // the field catalogue
  const [templates, setTemplates] = useState([])
  const [draft, setDraft] = useState(null)        // the template being edited
  const [dirty, setDirty] = useState(false)
  const [selId, setSelId] = useState(null)
  const [px, setPx] = useState(8)
  const [preview, setPreview] = useState(null)    // {values, qr_svg, barcode_svg, source}
  const [products, setProducts] = useState([])
  const [previewId, setPreviewId] = useState('')  // which product the canvas shows
  const [qrNote, setQrNote] = useState('')
  const [err, setErr] = useState('')              // why the screen is empty
  const [scaleOn, setScaleOn] = useState(true)    // resize the design with the label
  const surfRef = useRef(null)                    // the label itself, for drop coords
  const canvRef = useRef(null)                    // the scroll area, for Fit
  // Element ids only have to be unique within one template, and they are what
  // selection and every edit key off — so they are minted from a counter rather
  // than from the clock, which two adds in the same millisecond would collide on.
  const seq = useRef(0)
  const newId = () => `e${Date.now().toString(36)}${(seq.current += 1)}`

  const specs = useMemo(() => {
    const m = {}; (cat?.fields || []).forEach((f) => { m[f.key] = f }); return m
  }, [cat])

  // ---- undo / redo -------------------------------------------------------
  // The whole draft is the unit of history. It is a few kilobytes of JSON, every
  // edit already builds a new object rather than mutating the old one, and a
  // stack of snapshots cannot drift out of step with the document the way a
  // stack of inverse-operations can. Entries are pushed BEFORE a change lands,
  // by whoever makes it — so what an undo restores is a state that was on screen.
  const hist = useRef({ past: [], future: [], tag: null, at: 0 })
  const [histN, setHistN] = useState([0, 0])      // [undoable, redoable], for the buttons
  const draftRef = useRef(null)
  useEffect(() => { draftRef.current = draft })

  const resetHistory = () => {
    hist.current = { past: [], future: [], tag: null, at: 0 }
    setHistN([0, 0])
  }
  //: `tag` coalesces a run of edits of the same kind into one step: dragging a
  //: box across the label is one thing that happened, not sixty, and typing a
  //: font size is one thing, not four. A different tag, or a pause, starts a new
  //: entry. Untagged edits — adding, deleting, aligning — always get their own.
  const push = (tag) => {
    const h = hist.current, d = draftRef.current
    if (!d) return
    const now = Date.now()
    if (tag && h.tag === tag && now - h.at < 900) { h.at = now; return }
    if (h.past[h.past.length - 1] === d) { h.at = now; return }   // nothing moved since
    h.past.push(d)
    if (h.past.length > 80) h.past.shift()        // 80 steps back is further than anyone goes
    h.future = []; h.tag = tag || null; h.at = now
    setHistN([h.past.length, 0])
  }
  const step = (back) => {
    const h = hist.current, d = draftRef.current
    const from = back ? h.past : h.future
    const to = back ? h.future : h.past
    if (!from.length || !d) return
    to.push(d)
    const next = from.pop()
    h.tag = null
    draftRef.current = next
    setDraft(next); setDirty(true)
    // the element that was selected may not exist in the state being restored
    setSelId((s) => (next.elements.some((e) => e.id === s) ? s : null))
    setHistN([h.past.length, h.future.length])
  }
  const undo = () => step(true)
  const redo = () => step(false)

  const loadTemplates = useCallback(() => api.labelTemplates().then(setTemplates), [])
  // Deliberately once, on mount. `toast` is re-created on every render of the
  // app shell, so listing it here would re-run this on every render — and since
  // the failure path reports an error, a server that 404s these routes would
  // re-render, re-fetch, re-fail and shout forever.
  useEffect(() => {
    api.labelFields().then(setCat).catch((e) => setErr(
      (e.status === 404 || e.status === 405)
        ? 'restart'
        : `The field catalogue could not be read (${e.message || 'the request failed'}).`))
    loadTemplates().catch(() => {})
    api.listProducts({ held: 1 }).then(setProducts).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTemplates])

  // the values the canvas draws. Re-fetched when the chosen product changes,
  // because the whole point of previewing against real stock is seeing a real
  // description overflow its box before a roll of stickers proves it
  useEffect(() => {
    api.labelPreviewValues(previewId || undefined).then(setPreview).catch(() => {})
  }, [previewId])

  const sel = draft?.elements.find((e) => e.id === selId) || null

  // The QR's size is the one property whose mistake is invisible on screen: a
  // symbol scaled down to fit still looks like a QR and only stops working once
  // it is on a garment. Keyed on the WIDTH alone, so a drag re-checks when the
  // size settles rather than on every frame of it.
  const qrW = draft?.elements.find((e) => specs[e.field]?.kind === 'qr')?.w
  useEffect(() => {
    if (qrW == null) { setQrNote(''); return undefined }
    let live = true
    api.labelQrCheck(qrW, previewId || undefined)
      .then((r) => { if (live) setQrNote(r.warning || '') }).catch(() => {})
    return () => { live = false }
  }, [qrW, previewId])

  //: Every mutator takes the same optional third argument: `{silent}` while a
  //: gesture is still running (the gesture pushed its own entry when it began),
  //: `{tag}` for a run of keystrokes that is really one edit.
  const edit = (patch, opt) => {
    if (!opt?.silent) push(opt?.tag)
    setDraft((d) => ({ ...d, ...patch })); setDirty(true)
  }
  const editEl = (id, patch, opt) => {
    if (!opt?.silent) push(opt?.tag)
    setDraft((d) => ({ ...d, elements: d.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))
    setDirty(true)
  }

  // Changing the label's size. Two jobs, and which one is wanted is the whole
  // reason for the tick-box: someone who bought a bigger roll wants the SAME
  // design, bigger — someone correcting 50×35 to 50×40 wants the design left
  // exactly where it is. Either way nothing may end up over the edge, because
  // the server clamps on save and a design that silently moves between the
  // screen and the sticker is worse than one that moves while you watch.
  const resizeLabel = (w0, h0) => {
    const lo = cat?.min_mm || 10, hi = cat?.max_mm || 300
    const w = clamp(+w0 || draft.width_mm, lo, hi)
    const h = clamp(+h0 || draft.height_mm, lo, hi)
    if (w === draft.width_mm && h === draft.height_mm) return
    push('size')
    const r2 = (v) => Math.round(v * 100) / 100
    setDraft((d) => {
      const sx = w / d.width_mm, sy = h / d.height_mm
      const k = Math.min(sx, sy)                  // type scales by the smaller of the two
      const els = d.elements.map((e) => {
        const n = scaleOn
          ? { ...e, x: r2(e.x * sx), y: r2(e.y * sy), w: r2(e.w * sx), h: r2(e.h * sy),
              size: Math.round(clamp(e.size * k, 3, 72) * 2) / 2 }
          : { ...e }
        if (specs[e.field]?.kind === 'qr') { n.w = n.h = Math.min(n.w, n.h) }
        n.w = clamp(n.w, 0.5, w); n.h = clamp(n.h, 0.2, h)
        n.x = snap(clamp(n.x, 0, w - n.w)); n.y = snap(clamp(n.y, 0, h - n.h))
        return n
      })
      return { ...d, width_mm: w, height_mm: h, elements: els }
    })
    setDirty(true)
  }

  // Zoom until the whole label is in view. Once any size is designable this is
  // the only zoom control that keeps working — a 100 × 150 shipping label at
  // "100%" is taller than the screen.
  const fitZoom = () => {
    const box = canvRef.current
    if (!box || !draft) return
    const z = Math.min((box.clientWidth - 70) / draft.width_mm,
                       (box.clientHeight - 130) / draft.height_mm)
    setPx(clamp(Math.round(z * 2) / 2, 1, 20))
  }

  const addField = (key, at) => {
    const spec = specs[key]; if (!spec || !draft) return
    push()
    const w = Math.min(spec.w || 20, draft.width_mm)
    const h = Math.min(spec.h || 4, draft.height_mm)
    const id = newId()
    const el = {
      id, field: key, w, h,
      x: snap(clamp(at ? at.x - w / 2 : 2, 0, draft.width_mm - w)),
      y: snap(clamp(at ? at.y - h / 2 : 2, 0, draft.height_mm - h)),
      size: spec.size || 8, bold: !!spec.bold, italic: false,
      align: spec.align || 'left', font: '', color: '#000000',
      prefix: '', suffix: '', uppercase: false, border: false,
      visible: true, locked: false, text: '', src: '',
      z: (draft.elements.reduce((m, e) => Math.max(m, e.z), 0) || 0) + 1,
    }
    setDraft((d) => ({ ...d, elements: [...d.elements, el] }))
    setSelId(id); setDirty(true)
  }
  const removeEl = (id) => {
    push()
    setDraft((d) => ({ ...d, elements: d.elements.filter((e) => e.id !== id) }))
    setSelId(null); setDirty(true)
  }
  const dupEl = (el) => {
    push()
    const id = newId()
    const copy = { ...el, id, x: snap(clamp(el.x + 2, 0, draft.width_mm - el.w)),
      y: snap(clamp(el.y + 2, 0, draft.height_mm - el.h)), locked: false,
      z: (draft.elements.reduce((m, e) => Math.max(m, e.z), 0) || 0) + 1 }
    setDraft((d) => ({ ...d, elements: [...d.elements, copy] }))
    setSelId(id); setDirty(true)
  }
  // z is re-numbered on every save, so "forward" only has to end up above the
  // element it was below — swapping with the neighbour is exactly that
  const restack = (el, dir) => {
    const ordered = [...draft.elements].sort((a, b) => a.z - b.z)
    const i = ordered.findIndex((e) => e.id === el.id)
    const j = i + dir
    if (j < 0 || j >= ordered.length) return
    push()
    const a = ordered[i].z, b = ordered[j].z
    setDraft((d) => ({ ...d, elements: d.elements.map((e) =>
      e.id === ordered[i].id ? { ...e, z: b } : e.id === ordered[j].id ? { ...e, z: a } : e) }))
    setDirty(true)
  }
  const align = (how) => {
    if (!sel) return
    const p = { left: { x: 0 }, right: { x: snap(draft.width_mm - sel.w) },
      hcentre: { x: snap((draft.width_mm - sel.w) / 2) }, top: { y: 0 },
      bottom: { y: snap(draft.height_mm - sel.h) },
      vcentre: { y: snap((draft.height_mm - sel.h) / 2) } }[how]
    if (p) editEl(sel.id, p)
  }

  // arrow keys nudge, Delete removes — a mm of precision is not a mouse's job
  useEffect(() => {
    if (!draft || !selId) return
    const onKey = (e) => {
      const t = e.target.tagName
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return
      const el = draft.elements.find((x) => x.id === selId)
      if (!el || el.locked) return
      const step = e.shiftKey ? 1 : 0.5
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
      if (d) {
        e.preventDefault()
        // a held-down arrow key is one nudge that went too far, not thirty
        editEl(el.id, { x: snap(clamp(el.x + d[0], 0, draft.width_mm - el.w)),
                        y: snap(clamp(el.y + d[1], 0, draft.height_mm - el.h)) },
               { tag: `nudge:${el.id}` })
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); removeEl(el.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Ctrl-Z / Ctrl-Y anywhere on the screen — except inside a text box, where the
  // browser's own undo is the one the person means.
  useEffect(() => {
    if (!draft) return undefined
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const t = e.target.tagName
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const newTemplate = () => {
    setDraft({ id: null, name: '', description: '', width_mm: 50, height_mm: 35,
      padding_mm: 2, border: true, target: 'product',
      font: 'Arial, Helvetica, sans-serif', elements: [], active: true, is_default: false })
    setSelId(null); setDirty(true); resetHistory()
  }
  // History belongs to the template on the bench. Carrying it across a Close
  // would let an undo pull one template's layout into another one.
  const openTemplate = (t) => {
    setDraft({ ...t, elements: [...(t.elements || [])] })
    setSelId(null); setDirty(false); resetHistory()
  }
  const save = async () => {
    if (!draft.name.trim()) { toast('Give the template a name first', 'err'); return }
    try {
      const body = { ...draft, created_by: role || 'admin' }
      const saved = draft.id ? await api.saveLabelTemplate(draft.id, body)
        : await api.createLabelTemplate(body)
      setDraft({ ...saved, elements: [...(saved.elements || [])] })
      setDirty(false); await loadTemplates()
      toast('✓ Template saved', 'ok')
    } catch (e) { toast(e.detail || 'Could not save the template', 'err') }
  }
  const act = async (fn, ok) => {
    try { await fn(); await loadTemplates(); toast(ok, 'ok') }
    catch (e) { toast(e.detail || 'That did not work', 'err') }
  }
  const close = () => {
    if (dirty && !window.confirm('Close without saving? The changes to this layout will be lost.')) return
    setDraft(null); setSelId(null); setDirty(false); resetHistory()
  }

  // A screen that says "loading…" forever is the one thing this must not do: the
  // usual reason it cannot load is a backend still running the code from before
  // these routes existed, which is a restart rather than a fault — and the
  // person looking at the blank screen is the person who can do it.
  if (err) return (
    <div className="screen scrolls">
      <div className="pagehead"><h2>Label Designer</h2></div>
      <div className="screenbody">
        <div className="warnbox" style={{ maxWidth: 620 }}>
          <h4>{err === 'restart' ? 'The server needs restarting' : 'Label Designer could not start'}</h4>
          <div className="small" style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
            {err === 'restart' ? <>
              This page was loaded from disk, but the routes it calls are registered when
              Python starts — and this server was started before Label Designer existed,
              so it answers <code>/api/labels/…</code> with 404. Stop the ESSA server
              (Ctrl-C in the run window), start it again with <code>run.bat</code>, and
              reload this page.
            </> : err}
          </div>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => window.location.reload()}>
            ↻ Reload</button>
        </div>
      </div>
    </div>
  )
  if (!cat) return <div className="body"><div className="empty" style={{ marginTop: 100 }}>Loading the label fields…</div></div>

  // ---- the template list ----
  if (!draft) return (
    <div className="screen scrolls">
      <div className="pagehead">
        <h2>Label Designer</h2>
        {/* the subtitle used to be what pushed the actions to the right edge —
            without one, the spacer has to do it explicitly */}
        <div style={{ flex: 1 }} />
        <button className="btn primary" onClick={newTemplate}>+ New template</button>
      </div>
      <div className="screenbody">
        {templates.length === 0 && <div className="empty" style={{ marginTop: 60 }}>
          No templates yet.</div>}
        <div className="tplgrid">
          {templates.map((t) => (
            <div key={t.id} className={'tplcard' + (t.active ? '' : ' off')}>
              <div className="tplthumb">
                {/* fits the card in BOTH directions — bounding only the width
                    let a 150mm-tall shipping label make a 500px-tall card */}
                <LabelSurface tpl={t} values={cat.sample}
                  px={Math.min(3.4, 170 / t.width_mm, 150 / t.height_mm)}
                  symbols={{ qr_svg: preview?.qr_svg, barcode_svg: preview?.barcode_svg }}
                  specs={specs} interactive={false} selId={null}
                  onSelect={() => {}} onChange={() => {}} />
              </div>
              <div className="tplbody">
                <div className="nm">{t.name}
                  {t.is_default && <span className="badge confirmed" title="What the printing screen opens on">default</span>}
                  {!t.active && <span className="badge">inactive</span>}
                </div>
                <div className="small" style={{ color: 'var(--muted)' }}>
                  {t.width_mm}×{t.height_mm} mm · {(t.elements || []).length} field(s) ·
                  {t.target === 'unit' ? ' per-piece' : ' per-SKU'}
                </div>
                {t.description && <div className="small" style={{ color: 'var(--text-2)' }}>{t.description}</div>}
                <div className="tplacts">
                  <button className="btn" onClick={() => openTemplate(t)}>Edit</button>
                  <button className="btn" onClick={() => act(() => api.duplicateLabelTemplate(t.id), '✓ Duplicated')}>Duplicate</button>
                  {!t.is_default && <button className="btn" onClick={() => act(() => api.setDefaultLabelTemplate(t.id), '✓ Default template set')}>Make default</button>}
                  <button className="btn" onClick={() => act(() => api.setLabelTemplateActive(t.id, !t.active), t.active ? '✓ Deactivated' : '✓ Activated')}>
                    {t.active ? 'Deactivate' : 'Activate'}</button>
                  <a className="btn" href={api.labelPreviewUrl(t.id, previewId || undefined, 6)} target="_blank" rel="noreferrer">Print proof</a>
                  {!t.is_default && <button className="btn danger" onClick={() => {
                    if (window.confirm(`Delete “${t.name}”? Labels already printed from it are unaffected.`)) act(() => api.deleteLabelTemplate(t.id), '✓ Deleted')
                  }}>Delete</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  // ---- the builder ----
  const groups = cat.groups.map((g) => [g, cat.fields.filter((f) => f.group === g)])
  const used = new Set(draft.elements.map((e) => e.field))
  // measured against the LABEL, not the scroll area it sits in — the drop lands
  // where the cursor is on the sticker, which is the whole promise of dragging it
  const onDrop = (ev) => {
    ev.preventDefault()
    const key = ev.dataTransfer.getData('text/label-field')
    if (!key) return
    const r = surfRef.current?.getBoundingClientRect()
    addField(key, r ? { x: (ev.clientX - r.left) / px, y: (ev.clientY - r.top) / px } : null)
  }

  return (
    <div className="body ldesign">
      {/* LEFT — the palette */}
      <div className="lpanel">
        <div className="head"><h3>Available information</h3></div>
        <div className="list">
          {groups.map(([g, fs]) => (
            <div key={g} className="lgroup">
              <h5>{g}</h5>
              {fs.map((f) => (
                <button key={f.key} className={'lfield' + (used.has(f.key) ? ' used' : '')}
                  draggable onDragStart={(e) => e.dataTransfer.setData('text/label-field', f.key)}
                  onClick={() => addField(f.key)}
                  title={f.hint || `Add ${f.label} to the label`}>
                  <span className="nm">{f.label}</span>
                  <span className="kd">{f.kind === 'text' ? 'field' : f.kind}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* CENTRE — the canvas */}
      <div className="lcanvaswrap">
        <div className="toolbar ltoolbar">
          <input value={draft.name} onChange={(e) => edit({ name: e.target.value }, { tag: 'name' })}
            placeholder="Template name" style={{ width: 196, fontWeight: 600 }} />
          <div className="segbar">
            <button className="seg" onClick={undo} disabled={!histN[0]}
              title="Undo (Ctrl-Z)">↶</button>
            <button className="seg" onClick={redo} disabled={!histN[1]}
              title="Redo (Ctrl-Y)">↷</button>
          </div>
          <SizeBox draft={draft} sizes={cat.sizes} scaleOn={scaleOn}
            onScaleOn={setScaleOn} onResize={resizeLabel} />
          <div className="segbar">
            {ZOOMS.map((z) => (
              <button key={z} className={'seg' + (px === z ? ' on' : '')} onClick={() => setPx(z)}
                title={`${z} screen pixels per millimetre`}>{z === 8 ? '100%' : `${Math.round(z / 8 * 100)}%`}</button>
            ))}
            <button className="seg" onClick={fitZoom} title="Zoom until the whole label is in view">Fit</button>
          </div>
          <div className="spacer" />
          <select value={previewId} onChange={(e) => setPreviewId(e.target.value)}
            style={{ width: 200 }} title="Draw the canvas with a real product's data">
            <option value="">Sample data</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {(p.name || p.description)?.slice(0, 40)}</option>)}
          </select>
          <button className="btn" onClick={close}>Close</button>
          <button className="btn primary" onClick={save} disabled={!dirty}>
            {dirty ? 'Save template' : 'Saved'}</button>
        </div>

        <div className="lcanvas" ref={canvRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          {preview && (
            <LabelSurface tpl={draft} values={preview.values} symbols={preview}
              px={px} selId={selId} onSelect={setSelId} onChange={editEl}
              onBegin={push} interactive specs={specs} innerRef={surfRef} />
          )}
          {draft.elements.length === 0 && (
            <div className="small" style={{ marginTop: 16, color: 'var(--muted)' }}>
              Empty label — drag a field from the left.
            </div>
          )}
          {qrNote && <div className="warnbox" style={{ marginTop: 18, maxWidth: 520 }}>
            <h4>The QR may not scan at this size</h4>
            <div className="small" style={{ color: 'var(--text-2)' }}>{qrNote}</div>
          </div>}
        </div>
      </div>

      {/* RIGHT — properties */}
      <div className="lprops">
        {!sel && (
          <>
            <div className="head"><h3>Label properties</h3></div>
            <div className="lform">
              <div className="field"><label>Description</label>
                <input value={draft.description || ''} placeholder="What this template is for"
                  onChange={(e) => edit({ description: e.target.value }, { tag: 'desc' })} /></div>
              <div className="field"><label>Label size</label>
                <SizeBox draft={draft} sizes={cat.sizes} scaleOn={scaleOn}
                  onScaleOn={setScaleOn} onResize={resizeLabel} column />
              </div>
              <div className="field"><label>Prints one label per</label>
                <select value={draft.target} onChange={(e) => edit({ target: e.target.value })}
                  title="A per-SKU label carries the product's QR; a per-piece label carries that garment's own code">
                  <option value="product">SKU (product QR)</option>
                  <option value="unit">Piece (each garment's own code)</option>
                </select></div>
              <div className="field"><label>Default font</label>
                <select value={draft.font} onChange={(e) => edit({ font: e.target.value })}>
                  {cat.fonts.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select></div>
              <label className="chk"><input type="checkbox" checked={!!draft.border}
                onChange={(e) => edit({ border: e.target.checked })} /> Print a border round the label</label>
              <label className="chk"><input type="checkbox" checked={!!draft.active}
                onChange={(e) => edit({ active: e.target.checked })} /> Active (offered when printing)</label>
              {/* Ticking makes this one the default; there is no un-ticking,
                  because a warehouse with no default template has nothing for
                  the printing screen to open on. Another template taking the
                  title is how this one loses it. */}
              <label className="chk" title={draft.is_default
                ? 'Already the default — make another template the default to change it'
                : 'The template QR / Label Printing opens on'}>
                <input type="checkbox" checked={!!draft.is_default} disabled={!!draft.is_default}
                  onChange={(e) => edit({ is_default: e.target.checked })} /> Default template</label>
            </div>
          </>
        )}
        {sel && (
          <>
            <div className="head"><h3>{specs[sel.field]?.label}</h3></div>
            <div className="lform">
              <div className="row2">
                <div className="field"><label>X (mm)</label>
                  <input type="number" step="0.5" value={sel.x} disabled={sel.locked}
                    onChange={(e) => editEl(sel.id, { x: clamp(+e.target.value || 0, 0, draft.width_mm - sel.w) }, { tag: `x:${sel.id}` })} /></div>
                <div className="field"><label>Y (mm)</label>
                  <input type="number" step="0.5" value={sel.y} disabled={sel.locked}
                    onChange={(e) => editEl(sel.id, { y: clamp(+e.target.value || 0, 0, draft.height_mm - sel.h) }, { tag: `y:${sel.id}` })} /></div>
              </div>
              <div className="row2">
                <div className="field"><label>{specs[sel.field]?.kind === 'qr' ? 'QR size (mm)' : 'Width (mm)'}</label>
                  <input type="number" step="0.5" value={sel.w} disabled={sel.locked}
                    onChange={(e) => {
                      const w = clamp(+e.target.value || 1, 0.5, draft.width_mm - sel.x)
                      editEl(sel.id, specs[sel.field]?.kind === 'qr' ? { w, h: w } : { w }, { tag: `w:${sel.id}` })
                    }} /></div>
                <div className="field"><label>Height (mm)</label>
                  <input type="number" step="0.5" value={sel.h}
                    disabled={sel.locked || specs[sel.field]?.kind === 'qr'}
                    onChange={(e) => editEl(sel.id, { h: clamp(+e.target.value || 1, 0.2, draft.height_mm - sel.y) }, { tag: `h:${sel.id}` })} /></div>
              </div>
              <div className="lalign">
                <span className="small">Align on label</span>
                <div>
                  {[['left', '⇤'], ['hcentre', '↔'], ['right', '⇥'], ['top', '⇡'], ['vcentre', '↕'], ['bottom', '⇣']].map(([k, g]) => (
                    <button key={k} className="btn" disabled={sel.locked} onClick={() => align(k)} title={k}>{g}</button>
                  ))}
                </div>
              </div>

              {['text', 'static'].includes(specs[sel.field]?.kind) && <>
                {/* Words. A template normally holds a REFERENCE — "whatever this
                    product's colour is" — and that is what makes one template
                    print the whole warehouse. Typing over a box (here, or by
                    double-clicking it on the label) breaks that link for that
                    one box, on purpose and visibly: some lines really are the
                    same on every garment, and a care instruction is not a
                    column in the products table. */}
                {sel.field === 'custom_text' ? (
                  <div className="field"><label>Text</label>
                    <input value={sel.text || ''} placeholder="What this line should say"
                      onChange={(e) => editEl(sel.id, { text: e.target.value }, { tag: `t:${sel.id}` })} /></div>
                ) : <>
                  <label className="chk" title="Off: this box prints whatever the product says, and a corrected value reaches the next label on its own. On: it prints these words on every label, whatever the product says.">
                    <input type="checkbox" checked={!!sel.use_text}
                      onChange={(e) => editEl(sel.id, e.target.checked
                        ? { use_text: true, text: sel.text || String(preview?.values?.[sel.field] ?? '') }
                        : { use_text: false })} />
                    {' '}Fixed text instead of the {specs[sel.field]?.label?.toLowerCase()}
                  </label>
                  {sel.use_text && (
                    <div className="field">
                      <input value={sel.text || ''} placeholder="What this line should say"
                        onChange={(e) => editEl(sel.id, { text: e.target.value }, { tag: `t:${sel.id}` })} />
                      <span className="small" style={{ color: 'var(--warn)' }}>
                        Printed on every label.
                      </span>
                    </div>
                  )}
                </>}
                <div className="field"><label>Font</label>
                  <select value={sel.font || ''} onChange={(e) => editEl(sel.id, { font: e.target.value })}>
                    <option value="">Template default</option>
                    {cat.fonts.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select></div>
                <div className="row2">
                  <div className="field"><label>Font size (pt)</label>
                    <input type="number" step="0.5" value={sel.size}
                      onChange={(e) => editEl(sel.id, { size: clamp(+e.target.value || 8, 3, 72) }, { tag: `s:${sel.id}` })} /></div>
                  <div className="field"><label>Text align</label>
                    <select value={sel.align} onChange={(e) => editEl(sel.id, { align: e.target.value })}>
                      {cat.aligns.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select></div>
                </div>
                <div className="row2">
                  <div className="field"><label>Prefix</label>
                    <input value={sel.prefix || ''} placeholder="Size: "
                      onChange={(e) => editEl(sel.id, { prefix: e.target.value }, { tag: `p:${sel.id}` })} /></div>
                  <div className="field"><label>Suffix</label>
                    <input value={sel.suffix || ''} placeholder="% OFF"
                      onChange={(e) => editEl(sel.id, { suffix: e.target.value }, { tag: `f:${sel.id}` })} /></div>
                </div>
                <label className="chk"><input type="checkbox" checked={!!sel.bold}
                  onChange={(e) => editEl(sel.id, { bold: e.target.checked })} /> Bold</label>
                <label className="chk"><input type="checkbox" checked={!!sel.italic}
                  onChange={(e) => editEl(sel.id, { italic: e.target.checked })} /> Italic</label>
                <label className="chk"><input type="checkbox" checked={!!sel.uppercase}
                  onChange={(e) => editEl(sel.id, { uppercase: e.target.checked })} /> UPPERCASE</label>
              </>}

              {specs[sel.field]?.kind === 'image' && (
                <div className="field"><label>Image</label>
                  <input type="file" accept="image/*" onChange={(e) => {
                    const f = e.target.files[0]; if (!f) return
                    if (f.size > 400 * 1024) { toast('Use an image under 400 KB — it is stored inside the template', 'err'); return }
                    const rd = new FileReader()
                    rd.onload = () => editEl(sel.id, { src: rd.result })
                    rd.readAsDataURL(f)
                  }} />
                </div>
              )}

              <div className="row2">
                <div className="field"><label>Colour</label>
                  <input type="color" value={sel.color || '#000000'}
                    onChange={(e) => editEl(sel.id, { color: e.target.value }, { tag: `c:${sel.id}` })} /></div>
                <div className="field"><label>Layer</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn" onClick={() => restack(sel, 1)} title="Bring forward">▲</button>
                    <button className="btn" onClick={() => restack(sel, -1)} title="Send backward">▼</button>
                  </div></div>
              </div>
              <label className="chk"><input type="checkbox" checked={!!sel.border}
                onChange={(e) => editEl(sel.id, { border: e.target.checked })} /> Box border</label>
              <label className="chk"><input type="checkbox" checked={sel.visible !== false}
                onChange={(e) => editEl(sel.id, { visible: e.target.checked })} /> Visible</label>
              <label className="chk" title="Locked fields cannot be moved or resized by accident — the QR and the SKU are worth locking once they are right">
                <input type="checkbox" checked={!!sel.locked}
                  onChange={(e) => editEl(sel.id, { locked: e.target.checked })} /> 🔒 Lock this field</label>

              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button className="btn" onClick={() => dupEl(sel)}>Duplicate</button>
                <button className="btn danger" disabled={sel.locked} onClick={() => removeEl(sel.id)}>Remove</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ==========================================================================
//  QR / Label Printing — the daily screen
//  ------------------------------------------------------------------------
//  Pick stock, pick a template, check the proof, print. Nothing here can change
//  a design, which is the point: the person doing this is holding a roll of
//  stickers, not deciding what a label looks like.
// ==========================================================================
function LabelPrinting({ toast }) {
  const [templates, setTemplates] = useState([])
  const [tplId, setTplId] = useState(0)
  const [products, setProducts] = useState([])
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState({})        // {product_id: qty}
  const [preview, setPreview] = useState(null)
  const [cat, setCat] = useState(null)

  useEffect(() => {
    api.labelFields().then(setCat).catch(() => {})
    api.labelTemplates().then((ts) => {
      const live = ts.filter((t) => t.active)
      setTemplates(live)
      const def = live.find((t) => t.is_default) || live[0]
      if (def) setTplId(def.id)
    }).catch((e) => toast(
      e.status === 404
        ? 'This server was started before Label Printing existed — restart the ESSA server and reload.'
        : 'Could not load the templates', 'err'))
    api.listProducts({ held: 1 }).then(setProducts).catch(() => {})
    // once, on mount — see the same note in LabelDesigner: `toast` changes
    // identity every render, and this effect's failure path raises one
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tpl = templates.find((t) => t.id === tplId) || null
  const perPiece = tpl?.target === 'unit'

  const specs = useMemo(() => {
    const m = {}; (cat?.fields || []).forEach((f) => { m[f.key] = f }); return m
  }, [cat])

  // The proof is drawn to FIT the panel it sits in, not at a fixed zoom. It used
  // to render at 8 px/mm whatever the template was: a 50mm label came out 400px
  // wide inside a 300px column and lost both its edges to the scrollbar, and a
  // 100 × 150 shipping label was a corner of itself. The panel is a fixed column
  // and templates are any size between 10 and 300mm, so the only stable answer
  // is to measure the box and scale to it — never magnifying past 8 px/mm, which
  // is roughly life size on a normal monitor.
  const proofRef = useRef(null)
  const [proofW, setProofW] = useState(0)
  useEffect(() => {
    const el = proofRef.current
    if (!el) return undefined
    setProofW(el.clientWidth)
    // once, on mount: the box is always rendered, and re-observing on every
    // render would tear the observer down and build it again for nothing
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((es) => setProofW(es[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  //: 12px of room for the box's own padding, so the label never sits edge to edge
  const proofPx = (tpl && proofW)
    ? Math.max(0.6, Math.min(8, (proofW - 12) / tpl.width_mm))
    : 8

  const visible = products.filter((p) => matches(p, q, ['sku', 'description', 'size', 'color', 'category', 'supplier_name', 'barcode']))
  const page = usePaged(visible, 50)
  const ids = Object.keys(picked).map(Number)
  // a per-piece run prints one label per garment, so its count is the live piece
  // codes, not a quantity anybody types
  const total = ids.reduce((n, id) => {
    const p = products.find((x) => x.id === id)
    return n + (perPiece ? (p?.live_units || 0) : (+picked[id] || 0))
  }, 0)

  const defaultQty = (p) => Math.max(1, Math.round(p.stock_qty || 1))

  // The last row clicked, so shift-click can select the run between it and the
  // next one. A whole delivery of one design is thirty consecutive rows — six
  // sizes across five colours, all wanting labels — and ticking those one at a
  // time is where this screen actually costs somebody their morning.
  const lastClicked = useRef(null)

  const toggle = (p, shiftKey = false) => {
    const rows = page.slice
    const here = rows.findIndex((r) => r.id === p.id)

    if (shiftKey && lastClicked.current != null) {
      const from = rows.findIndex((r) => r.id === lastClicked.current)
      if (from >= 0 && here >= 0) {
        const [a, b] = from < here ? [from, here] : [here, from]
        // The run takes the state the ANCHOR row is about to have, so
        // shift-clicking always does one thing to the whole range rather than
        // inverting each row and leaving a stripe of the ones already on.
        const turningOn = picked[p.id] == null
        setPicked((sel) => {
          const n = { ...sel }
          for (let i = a; i <= b; i++) {
            const r = rows[i]
            if (turningOn) n[r.id] = n[r.id] ?? defaultQty(r)
            else delete n[r.id]
          }
          return n
        })
        lastClicked.current = p.id
        return
      }
    }

    lastClicked.current = p.id
    setPicked((sel) => {
      const n = { ...sel }
      if (n[p.id] != null) delete n[p.id]
      else n[p.id] = defaultQty(p)
      return n
    })
  }

  // Everything on THIS page, not every row the filter matched. A search for
  // "Cherry" can be four hundred products across sixteen pages, and a tick box
  // that quietly selected all of them is how somebody prints four hundred
  // labels meaning to print twenty. The count beside it says which it is.
  const pageIds = page.slice.map((r) => r.id)
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => picked[id] != null)
  const someOnPage = pageIds.some((id) => picked[id] != null)
  const toggleAllOnPage = () => setPicked((sel) => {
    const n = { ...sel }
    if (allOnPage) pageIds.forEach((id) => delete n[id])
    else page.slice.forEach((r) => { n[r.id] = n[r.id] ?? defaultQty(r) })
    return n
  })

  const allMatching = visible.length > 0 && visible.every((r) => picked[r.id] != null)
  const selectAllMatching = () => setPicked((sel) => {
    const n = { ...sel }
    visible.forEach((r) => { n[r.id] = n[r.id] ?? defaultQty(r) })
    return n
  })

  const setQty = (id, v) => setPicked((s) => ({ ...s, [id]: Math.max(1, Math.min(+v || 1, 2000)) }))

  // The proof is drawn from one of the selected products rather than from sample
  // data, because a label that comes out wrong is usually wrong about a
  // product's data — a description too long for its box, a missing MRP — and
  // that is invisible against a sample record that has every field filled.
  useEffect(() => {
    const first = ids[0]
    api.labelPreviewValues(first || undefined).then(setPreview).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids[0]])

  const blocked = ids.map((id) => products.find((p) => p.id === id))
    .filter((p) => p && p.can_print === false)

  const doPrint = () => {
    if (!tpl) { toast('Choose a template first', 'err'); return }
    if (!ids.length) { toast('Select at least one product', 'err'); return }
    if (blocked.length) {
      toast(`${blocked[0].sku}: ${blocked[0].print_block}`, 'err'); return
    }
    const url = perPiece
      ? api.labelPrintUrl(tpl.id, [], { unitProducts: ids })
      : api.labelPrintUrl(tpl.id, ids.map((id) => ({ id, qty: picked[id] })))
    window.open(url, '_blank')
  }

  return (
    <div className="screen scrolls">
      <div className="pagehead">
        <h2>QR / Label Printing</h2>
      </div>
      <div className="lprintwrap">
        <div>
          <div className="toolbar">
            {/* supplier was always searchable here — it just never said so */}
            <SearchBox value={q} onChange={setQ} placeholder="Search product / SKU / size / colour / supplier…"
              style={{ width: 320 }} />
            <div className="field" style={{ width: 280, margin: 0 }}><label>Template</label>
              <select value={tplId} onChange={(e) => setTplId(+e.target.value)}>
                {templates.length === 0 && <option value={0}>No active template</option>}
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}{t.is_default ? ' — default' : ''} ({t.width_mm}×{t.height_mm} mm)
                  </option>
                ))}
              </select></div>
            <div className="spacer" />
            {/* Everything the search matched, across every page — the thing you
                want after filtering to one supplier or one design. Separate
                from the header tick box, and it says the number, because
                "select all" meaning four hundred rows when the screen shows
                fifty is how the wrong run gets printed. */}
            {visible.length > page.slice.length && (
              <button className="btn" onClick={selectAllMatching}
                disabled={allMatching}
                title={`Select every product the current search matched (${visible.length})`}>
                Select all {visible.length}{q ? ' matching' : ''}
              </button>
            )}
            <button className="btn" onClick={() => setPicked({})} disabled={!ids.length}>Clear selection</button>
          </div>

          {perPiece && <div className="infobox" style={{ marginBottom: 12 }}>
            <b>{tpl.name}</b> prints one label per garment, each carrying that piece's own
            code — so the quantity is the number of piece codes the SKU has, not a number
            you choose.
          </div>}

          <div className="tablewrap">
          <table className="items">
            <thead><tr>
              <th style={{ width: 34 }}>
                {/* Indeterminate when only part of the page is selected, so the
                    box shows the three states it actually has rather than
                    reading as "none" whenever it is not all. */}
                <input type="checkbox" checked={allOnPage}
                  ref={(el) => { if (el) el.indeterminate = someOnPage && !allOnPage }}
                  onChange={toggleAllOnPage} disabled={!page.slice.length}
                  title={allOnPage ? 'Clear the products on this page'
                    : `Select all ${page.slice.length} products on this page`} />
              </th><th>SKU</th><th>Product</th>
              <th>Size</th><th>Colour</th>
              {/* Who it came from — on screen only, to tell two identical-looking
                  rows apart before printing a hundred tags of the wrong one. It
                  is NOT a label field: what prints is whatever the template lays
                  out, and no template is touched by this column. */}
              <th>Supplier</th>
              <th style={{ textAlign: 'right' }}>Stock</th>
              <th style={{ textAlign: 'right', width: 110 }}>{perPiece ? 'Pieces' : 'Labels'}</th>
            </tr></thead>
            <tbody>
              {page.slice.map((p) => {
                const on = picked[p.id] != null
                return (
                  <tr key={p.id} className={on ? 'sel' : ''}
                    style={p.can_print === false ? { color: 'var(--muted)' } : undefined}>
                    {/* onClick, not onChange: the modifier keys are on the mouse
                        event and a change event has none, so shift-click has to
                        be read here. */}
                    <td><input type="checkbox" checked={on} readOnly
                      onClick={(e) => toggle(p, e.shiftKey)}
                      title={p.can_print === false ? p.print_block
                        : 'Select for printing — shift-click to take a run of rows'} /></td>
                    <td className="mono">{p.sku || '—'}</td>
                    <td>{p.name || p.description}
                      {p.can_print === false && <span className="badge needs_review" style={{ marginLeft: 6 }}
                        title={p.print_block}>cannot print</span>}</td>
                    <td>{p.size || '—'}</td>
                    <td>{p.color || '—'}</td>
                    <td title={p.supplier_name ? `Received from ${p.supplier_name}` : 'No supplier recorded against this item'}>
                      {p.supplier_name || '—'}</td>
                    <td className="num">{p.stock_qty}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!on ? '—' : perPiece ? (p.live_units || 0)
                        : <input type="number" min="1" value={picked[p.id]} style={{ width: 78 }}
                            onChange={(e) => setQty(p.id, e.target.value)} />}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
          <Pager {...page} noun="product" />
        </div>

        <div className="lprintside">
          <div className="section">
            <h4>Preview
              {tpl && (
                <span className="proofsize">
                  {tpl.width_mm} × {tpl.height_mm} mm
                  {proofPx < 7.9 ? ` · shown at ${Math.round((proofPx / 8) * 100)}%` : ''}
                </span>
              )}
            </h4>
            <div className="small" style={{ color: 'var(--muted)', margin: '-4px 0 10px' }}>
              {ids.length ? `${preview?.values?.sku || 'A selected product'}, in the chosen template.`
                : 'Sample data — select a product to see its own.'}
            </div>
            <div className="lproof" ref={proofRef}>
              {tpl && preview && cat
                ? <LabelSurface tpl={tpl} values={preview.values} symbols={preview} px={proofPx}
                    specs={specs} interactive={false} selId={null}
                    onSelect={() => {}} onChange={() => {}} />
                : <div className="small">Nothing to preview yet.</div>}
            </div>
            <div className="items-foot" style={{ marginTop: 12 }}>
              <span>Selected <b>{ids.length}</b> product{ids.length === 1 ? '' : 's'}</span>
              <span>Labels <b>{total}</b></span>
            </div>
            {blocked.length > 0 && <div className="warnbox" style={{ marginTop: 12 }}>
              <h4>{blocked.length} selected product(s) cannot be printed</h4>
              <div className="small" style={{ color: 'var(--text-2)' }}>{blocked[0].print_block}</div>
            </div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <a className="btn" href={tpl ? api.labelPreviewUrl(tpl.id, ids[0], 6) : '#'}
                target="_blank" rel="noreferrer"
                onClick={(e) => { if (!tpl) e.preventDefault() }}
                title="Open a full sheet of six, exactly as it will print">Preview sheet</a>
              <button className="btn primary" onClick={doPrint} disabled={!total}>
                🖨 Print {total || ''} label{total === 1 ? '' : 's'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ==========================================================================
//  Notifications
//  ------------------------------------------------------------------------
//  The dashboard already says what is waiting on someone — but only to whoever
//  opens the dashboard. This is the same queues, carried: a bell that counts
//  what has not been seen, a panel that opens the screen which clears it, and a
//  roster of who is meant to be watching.
//
//  Read means read AT A NUMBER. Acknowledging "4 drafts" stores 4; a fifth makes
//  it unread again, a third leaves it quiet. That is what makes a bell you can
//  clear and still trust — see services/notifications.py.
// ==========================================================================

const NOTIF_LEVEL = {
  critical: { dot: '🔥', label: 'Critical', tone: 'crit' },
  warn: { dot: '🔴', label: 'Needs attention', tone: 'warn' },
  info: { dot: '🟠', label: 'For information', tone: 'info' },
}

// One notice, wherever it is shown — the bell panel and the dashboard section
// render the same row, so a notice never says two different things in two places.
function NoticeRow({ n, onOpen, onRead, onMute, compact }) {
  return (
    <div className={'notice' + (n.unread ? ' unread' : '')}>
      <span className="ndot" title={NOTIF_LEVEL[n.level]?.label}>{n.dot}</span>
      <div className="nbody">
        <div className="ntitle">{n.title}</div>
        <div className="nsub">{n.body}</div>
        <div className="nmeta">
          {n.waiting ? <>waiting {n.waiting}</> : null}
          {n.read_by ? <> · read by {n.read_by}</> : null}
        </div>
      </div>
      <div className="nacts">
        <button className="btn" onClick={() => onOpen(n)} title="Open the screen that clears this">Open</button>
        {!compact && n.unread && (
          <button className="btn" onClick={() => onRead(n)} title="Acknowledge it at this count — it comes back if it grows">Mark read</button>
        )}
        {!compact && onMute && (
          <button className="btn" onClick={() => onMute(n)} title="Silence this queue until it is unmuted">Mute</button>
        )}
      </div>
    </div>
  )
}

// The bell. Polls only the four counts — the feed is read when the panel is
// actually opened, because the full pass walks every queue in the warehouse.
//
// The button and the panel are deliberately two components: the bell belongs on
// the chrome, and the panel must NOT be a child of it. Everything under .topbar
// is styled for a dark brown bar — `.topbar .btn:not(.primary)` paints buttons
// transparent with near-white text — so a white panel rendered inside the header
// comes out with invisible buttons. Overlays in this app live at the app root
// (see how VisionSettings and ScanningOverlay are mounted), and `tick` is what
// lets the badge re-read itself after the panel marks something read.
function NotificationBell({ onOpen, tick }) {
  const [counts, setCounts] = useState(null)
  const [err, setErr] = useState('')

  const poll = useCallback(() => api.notificationCount().then((c) => { setCounts(c); setErr('') })
    .catch((e) => setErr(e.status === 404 ? 'restart' : '')), [])
  useEffect(() => { poll() }, [poll, tick])
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') poll() }, 60000)
    document.addEventListener('visibilitychange', poll)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', poll) }
  }, [poll])

  const unread = counts?.unread || 0
  return (
    <button className={'bell' + (unread ? ' has' : '')} onClick={onOpen}
      title={err === 'restart'
        ? 'The server is running code from before notifications existed — restart it'
        : unread ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications — nothing unread'}>
      <Icon name="bell" size={18} />{unread > 0 && <span className={'bellcount' + (counts.critical ? ' crit' : '')}>{unread}</span>}
    </button>
  )
}

function NotificationPanel({ go, user, toast, onClose, onChanged }) {
  const [feed, setFeed] = useState(null)
  const [tab, setTab] = useState('inbox')
  const [err, setErr] = useState('')
  useEffect(() => {
    api.notifications().then(setFeed)
      .catch((e) => setErr(e.status === 404 ? 'restart' : 'failed'))
  }, [])
  const apply = (f) => f.then((r) => { setFeed(r); onChanged() })
    .catch(() => toast('Could not save that', 'err'))

  return (
    <div className="piece-wrap" onClick={onClose}>
      <div className="piece-card notifpanel" onClick={(e) => e.stopPropagation()}>
        <div className="piece-head">
          <b>🔔 Notifications</b>
          <div className="segbar" style={{ marginLeft: 12 }}>
            <button className={'seg' + (tab === 'inbox' ? ' on' : '')} onClick={() => setTab('inbox')}>Inbox</button>
            <button className={'seg' + (tab === 'people' ? ' on' : '')} onClick={() => setTab('people')}
              title="Who is meant to be watching these, and on what number">People</button>
          </div>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}
            title="Close">✕</button>
        </div>
        <div className="piece-body" style={{ maxHeight: '68vh', overflow: 'auto' }}>
          {err && <div className="warnbox" style={{ marginBottom: 12 }}>
            <h4>{err === 'restart' ? 'Notifications need a restart' : 'The queues could not be read'}</h4>
            <div className="small" style={{ color: 'var(--text-2)' }}>
              {err === 'restart'
                ? 'The server is still running the code from before this existed. Stop it in the run window (Ctrl-C) and start run.bat again.'
                : 'Nothing was returned. Refresh, or check the run window for an error.'}</div></div>}

          {tab === 'inbox' && !err && (!feed ? <div className="empty">Reading the queues…</div> : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                <span className="small" style={{ color: 'var(--text-2)' }}>
                  {feed.counts.total
                    ? <>{feed.counts.total} open · <b>{feed.counts.unread}</b> unread</>
                    : 'Nothing is waiting — every queue in the warehouse is clear.'}
                </span>
                {feed.counts.unread > 0 && <button className="btn" style={{ marginLeft: 'auto' }}
                  onClick={() => apply(api.notificationsReadAll(user))}>Mark all read</button>}
              </div>
              {feed.notices.map((n) => (
                <NoticeRow key={n.key} n={n}
                  onOpen={(x) => { onClose(); go(x.module) }}
                  onRead={(x) => apply(api.notificationsRead([x.key], user))}
                  onMute={(x) => apply(api.notificationMute(x.key, true, user))} />
              ))}
              {!feed.notices.length && <div className="empty" style={{ marginTop: 20 }}>
                Nothing open. Notices appear here the moment a queue stops being empty.</div>}
              <MutedList onChanged={(r) => { setFeed(r); onChanged() }} user={user} />
            </>
          ))}

          {tab === 'people' && <RecipientList toast={toast} />}
        </div>
      </div>
    </div>
  )
}

// Muted queues, listed where they were muted from. A silence nobody can find is
// a silence nobody can undo, and this is the screen someone comes back to.
function MutedList({ onChanged, user }) {
  const [rows, setRows] = useState([])
  // Through api rather than a bare fetch: only the calls in that module carry
  // the signed-in token, and one that goes round it is one the server refuses.
  const load = useCallback(() => api.notificationsMuted()
    .then(setRows).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  if (!rows.length) return null
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="small" style={{ color: 'var(--muted)', marginBottom: 8 }}>Muted queues</div>
      {rows.map((m) => (
        <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
          <span className="small" style={{ flex: 1 }}>{m.title}
            {!m.open_now && <span style={{ color: 'var(--muted)' }}> · clear right now</span>}</span>
          <button className="btn" style={{ padding: '2px 9px' }}
            onClick={() => api.notificationMute(m.key, false, user).then((r) => { onChanged(r); load() })}>Unmute</button>
        </div>
      ))}
    </div>
  )
}

// Who is meant to be watching, and on what number. Delivery is in-app today —
// said plainly here rather than implied by a number box that looks like it sends.
function RecipientList({ toast }) {
  const [rows, setRows] = useState([])
  const [form, setForm] = useState({ name: '', mobile: '', role: '', levels: ['critical', 'warn', 'info'] })
  const load = useCallback(() => api.notificationRecipients().then(setRows).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  const add = async () => {
    if (!form.name.trim()) { toast('A name is needed', 'err'); return }
    try {
      await api.addRecipient(form)
      setForm({ name: '', mobile: '', role: '', levels: ['critical', 'warn', 'info'] })
      load(); toast('✓ Added to the list', 'ok')
    } catch (e) { toast(e.detail || 'Could not add them', 'err') }
  }
  const toggleLevel = (r, lvl) => {
    const has = (r.levels || []).includes(lvl)
    const levels = has ? r.levels.filter((l) => l !== lvl) : [...(r.levels || []), lvl]
    api.updateRecipient(r.id, { levels }).then(load).catch(() => toast('Could not save', 'err'))
  }
  const remove = (r) => {
    if (!window.confirm(`Remove ${r.name} from the notification list?`)) return
    api.deleteRecipient(r.id).then(load).catch(() => toast('Could not remove them', 'err'))
  }
  return (
    <>
      <div className="small" style={{ color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.6 }}>
        Who watches these queues, and on what number. <b>Notices are delivered in the app</b> —
        the bell here and the Notifications tab in the warehouse phone app. The number is held
        against the person so a channel that dials out (SMS or WhatsApp) can be switched on later
        without collecting this list again.
      </div>
      {rows.length > 0 && (
        <div className="tablewrap">
          <table className="items">
            <thead><tr><th>Name</th><th>Mobile</th><th>Watches</th>
              <th style={{ width: 210 }}>Gets</th><th style={{ width: 34 }}></th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b></td>
                <td className="mono">{r.mobile || '—'}</td>
                <td className="small">{r.role || '—'}</td>
                <td>{Object.keys(NOTIF_LEVEL).map((lvl) => (
                  <button key={lvl} className={'fchip' + ((r.levels || []).includes(lvl) ? ' on' : '')}
                    style={{ marginRight: 4 }} title={NOTIF_LEVEL[lvl].label}
                    onClick={() => toggleLevel(r, lvl)}>{NOTIF_LEVEL[lvl].dot}</button>
                ))}</td>
                <td><button className="btn" style={{ padding: '2px 7px' }} onClick={() => remove(r)}>×</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {!rows.length && <div className="empty" style={{ margin: '10px 0' }}>
        Nobody on the list yet.</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
        <div className="field" style={{ minWidth: 150 }}><label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Sharu" /></div>
        <div className="field" style={{ minWidth: 160 }}><label>Mobile number</label>
          <input value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })}
            inputMode="tel" placeholder="+91 98765 43210" /></div>
        <div className="field" style={{ minWidth: 150 }}><label>What they watch</label>
          <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
            placeholder="e.g. Warehouse in-charge" /></div>
        <button className="btn primary" onClick={add}>Add</button>
      </div>
    </>
  )
}

// ==========================================================================
//  Dead Stock & Clearance
//  ------------------------------------------------------------------------
//  Five screens over ONE read of the stock: the dashboard is it totalled, the
//  register is it listed, the summary is it grouped, the cash impact is it
//  valued, and the worksheet is the part of it somebody has decided to act on.
//  Only the worksheet writes anything, and what it writes is a plan — the
//  quantity sold and the cash realised are read back off the till against the
//  product, so no clearance line ever becomes a second stock record.
// ==========================================================================

const DS_TABS = [
  ['dashboard', '📊 Dashboard', 'What has gone quiet, and what it is worth'],
  ['register', '📋 Register', 'Every dead line, with its age band and clearance price'],
  ['worksheet', '🏷 Clearance Worksheet', 'Campaigns, their actions, and what actually sold'],
  ['summary', '📈 Summary', 'Dead stock by category and by age band'],
  ['cash', '💰 Cash Impact', 'Capital locked, cash expected, and what it would earn'],
  ['rules', '⚙ Discount Rules', 'The age ladder and the assumptions behind the projection'],
]

//: the age bands, coloured by how urgent they are rather than by name
const DS_TONE = { critical: 'crit', dead: 'dead', approaching: 'warn', healthy: 'ok' }
const DS_DOT = { critical: '🔥', dead: '🔴', approaching: '🟠', healthy: '🟢' }

//: what the age is being measured from, said in words on the row it applies to
const DS_BASIS = {
  sale: 'since the last till sale',
  dispatch: 'since it was dispatched to a store',
  received: 'never sold — since it last came in',
  never: 'nothing to date it from',
}

const rupees = (v) => (v == null ? '—' : '₹ ' + money(v))
const pct = (v) => (v == null ? '—' : v + '%')

function DsTiles({ tiles }) {
  return (
    <div className="dgrid">
      {tiles.map((t, i) => (
        <DashTile key={i} label={t.label} value={t.value} sub={t.sub} tone={t.tone}
          accent={t.accent} hint={t.hint} onClick={t.onClick || (() => {})} />
      ))}
    </div>
  )
}

// The three warnings, in the order they should be acted on. Not one 90-day
// event: at 60 days a small markdown may still move the line, and at 180 the
// question has stopped being "what discount" and become "who takes the lot".
function DsAlerts({ alerts, go, compact }) {
  if (!alerts?.length) {
    return compact ? null : (
      <div className="warnbox clean" style={{ marginBottom: 14 }}>
        <h4 style={{ border: 'none', margin: 0 }}>Nothing has gone quiet — every stocked line has moved inside the window.</h4>
      </div>
    )
  }
  return (
    <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
      {alerts.map((a) => (
        <div key={a.level} className="warnbox"
          style={a.level === 'approaching' ? undefined : { borderColor: 'var(--danger-line)', background: 'var(--danger-bg)' }}>
          <h4 style={{ border: 'none', margin: 0, color: a.level === 'approaching' ? 'var(--warn)' : 'var(--danger)' }}>
            {DS_DOT[a.level]} {a.title} — {a.lines} product{a.lines === 1 ? '' : 's'}, {a.note}
          </h4>
          <div className="small" style={{ color: 'var(--text-2)', marginTop: 4 }}>
            {a.qty} pcs · stock value <b>{rupees(a.stock_value)}</b> · expected on clearance <b>{rupees(a.expected_realisation)}</b>
            {go && <>{'  '}<button className="btn" style={{ padding: '2px 9px', marginLeft: 8 }}
              onClick={() => go(a.level)}>View these</button></>}
          </div>
        </div>
      ))}
    </div>
  )
}

// Where the sales came from. Said on every screen that counts a sale, because a
// register that quietly counts nothing when the till is off is worse than one
// that admits it — every line would read as dead.
function DsSource({ pos }) {
  if (!pos) return null
  return (
    <div className="small" style={{ color: 'var(--muted)', marginTop: 8 }}>
      {pos.available
        ? <>Sales read from the shop (POS) — {pos.linked_products} item{pos.linked_products === 1 ? '' : 's'} sold there are warehouse stock
            {pos.last_sale ? <>, last bill {pos.last_sale}</> : null}. Stock dispatched to a store counts as movement too.</>
        : <><b>The shop (POS) is not installed here</b>, so no till sales are visible. Ages are measured from
            dispatches and receipts only — a line sold at the counter would still read as unsold.</>}
    </div>
  )
}

function DeadStock({ toast, go, intent, onIntentUsed }) {
  const [tab, setTab] = useState('dashboard')
  const [sum, setSum] = useState(null)
  const [alerts, setAlerts] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const loadSummary = useCallback(() => {
    setBusy(true)
    return Promise.all([api.deadStockSummary(), api.deadStockAlerts()])
      .then(([s, a]) => { setSum(s); setAlerts(a); setErr('') })
      .catch((e) => setErr(e.status === 404
        ? 'The server is still running the code from before Dead Stock & Clearance existed — restart the backend (Ctrl-C in the run window, then run.bat again) and reload this page.'
        : (e.message || 'Could not read the stock')))
      .finally(() => setBusy(false))
  }, [])
  useEffect(() => { loadSummary() }, [loadSummary])

  // the register opens filtered to whatever band was clicked on the dashboard
  const [regStatus, setRegStatus] = useState('dead')
  const openRegister = (status) => { setRegStatus(status || 'dead'); setTab('register') }
  // A card on the MAIN dashboard says which screen it meant, and filtered how —
  // "₹1.42L locked" opens the register on the lines holding it, not a landing
  // page somebody then has to navigate. Consumed once, so coming back to this
  // module later opens where it was left rather than replaying the last click.
  useEffect(() => {
    if (!intent) return
    if (intent.tab) setTab(intent.tab)
    if (intent.status) setRegStatus(intent.status)
    onIntentUsed && onIntentUsed()
  }, [intent])   // eslint-disable-line react-hooks/exhaustive-deps

  const t = sum?.totals
  const c = sum?.counts
  const cash = sum?.cash_impact

  return (
    <div className="screen scrolls">
      <div className="pagehead">
        <h2>Dead Stock &amp; Clearance</h2>
        <div className="pagesub small">
          Stock that has stopped moving, what it is worth to clear, and whether the clearance worked
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={loadSummary} disabled={busy}
          title="Re-read the stock, the till and the ledger">{busy ? 'Reading…' : '↻ Refresh'}</button>
      </div>

      <div style={{ padding: '14px var(--gutter) 0' }}>
        <div className="segbar" role="tablist" aria-label="Dead stock screens">
          {DS_TABS.map(([key, label, hint]) => (
            <button key={key} role="tab" aria-selected={tab === key} title={hint}
              className={'seg' + (tab === key ? ' on' : '')} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="dash">
        {err && <div className="warnbox" style={{ marginBottom: 14 }}>
          <h4>Dead stock could not be read</h4>
          <div className="small" style={{ color: 'var(--text-2)' }}>{err}</div>
        </div>}

        {tab === 'dashboard' && sum && (
          <>
            <DsAlerts alerts={alerts?.alerts} go={openRegister} />
            <Section id="ds-tiles" title="Dead stock at a glance"
              summary={`${c.dead_total.lines} line(s) past ${c.thresholds.dead} days`}>
              <DsTiles tiles={[
                { label: 'Dead stock', value: c.dead_total.qty + ' pcs', accent: 'stock',
                  sub: `${c.dead_total.lines} product line(s) with no movement for ${c.thresholds.dead}+ days`,
                  tone: c.dead_total.lines ? 'warn' : '', onClick: () => openRegister('dead'),
                  hint: 'Open the register filtered to dead stock' },
                { label: 'Stock value', value: rupees(t.stock_value), accent: 'money',
                  sub: 'capital sitting on the shelf', tone: c.dead_total.lines ? 'warn' : '',
                  onClick: () => setTab('cash') },
                { label: 'Expected cash', value: rupees(t.expected_realisation), accent: 'money',
                  sub: 'if every line clears at its ladder price', onClick: () => setTab('cash') },
                { label: 'Recovery', value: t.recovery_pct == null ? '—' : t.recovery_pct + '%',
                  accent: 'adjust',
                  sub: 'expected cash against what it cost', onClick: () => setTab('cash') },
                { label: 'Approaching', value: c.approaching.qty + ' pcs', accent: 'stock',
                  sub: `${c.approaching.lines} line(s) quiet for ${c.thresholds.approaching}+ days — dead in under a month`,
                  tone: c.approaching.lines ? 'warn' : '', onClick: () => openRegister('approaching'),
                  hint: 'Open the register filtered to what is about to go dead' },
                { label: 'Critical', value: c.critical.qty + ' pcs', accent: 'stock',
                  sub: `${c.critical.lines} line(s) unsold for ${c.thresholds.critical}+ days`,
                  tone: c.critical.lines ? 'warn' : '', onClick: () => openRegister('critical') },
              ]} />
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button className="btn" onClick={() => openRegister('dead')}>View dead stock</button>
                <button className="btn primary" onClick={() => setTab('register')}>
                  Create a clearance worksheet</button>
              </div>
              <DsSource pos={sum.pos} />
            </Section>

            {sum.oldest.length > 0 && (
              <Section id="ds-oldest" title="Quietest lines" summary={`${sum.oldest.length} shown`}>
                <div className="tablewrap">
                  <table className="items">
                    <thead><tr><th>SKU</th><th>Product</th><th className="num">Qty</th>
                      <th className="num">Days</th><th>Measured from</th><th className="num">Stock value</th>
                      <th className="num">Discount</th><th className="num">Expected</th></tr></thead>
                    <tbody>{sum.oldest.map((r) => (
                      <tr key={r.product_id}>
                        <td className="mono">{r.sku}</td>
                        <td>{r.name}{r.size ? <span className="small"> · {r.size}</span> : null}</td>
                        <td className="num">{r.qty}</td>
                        <td className="num"><b>{r.days_idle}</b></td>
                        <td className="small">{DS_BASIS[r.basis]}</td>
                        <td className="num">{rupees(r.stock_value)}</td>
                        <td className="num">{pct(r.discount_pct)}</td>
                        <td className="num">{rupees(r.expected_realisation)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </Section>
            )}
          </>
        )}

        {tab === 'register' && <DsRegister toast={toast} status={regStatus} setStatus={setRegStatus}
          onChanged={loadSummary} />}
        {tab === 'worksheet' && <DsWorksheets toast={toast} />}
        {tab === 'summary' && sum && <DsSummary sum={sum} />}
        {tab === 'cash' && sum && <DsCash sum={sum} toast={toast} onSaved={loadSummary} />}
        {tab === 'rules' && <DsRules toast={toast} onSaved={loadSummary} />}
      </div>
    </div>
  )
}

// ---------- the register: every dead line, and what to do with it ----------
function DsRegister({ toast, status, setStatus, onChanged }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [f, setF] = useState({ bucket: '', category: '', supplier: '', size: '', min_value: '', min_qty: '' })
  const [open, setOpen] = useState(false)          // filter panel
  const [sel, setSel] = useState(() => new Set())
  const [actions, setActions] = useState({})       // product_id → chosen action
  const [adding, setAdding] = useState(false)      // the "add to clearance" dialog

  const load = useCallback(() => {
    setBusy(true)
    return api.deadStock({ q, status, ...f })
      .then(setData).catch((e) => toast(e.message || 'Could not read the register', 'err'))
      .finally(() => setBusy(false))
  }, [q, status, f, toast])
  useEffect(() => { load() }, [load])

  const rows = data?.rows || []
  const page = usePaged(rows, 50)
  const chosen = rows.filter((r) => sel.has(r.product_id))
  const toggle = (id) => setSel((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
  })
  const allShown = page.slice.every((r) => sel.has(r.product_id))
  const toggleAll = () => setSel((s) => {
    const n = new Set(s)
    page.slice.forEach((r) => (allShown ? n.delete(r.product_id) : n.add(r.product_id)))
    return n
  })
  const selTotals = {
    qty: chosen.reduce((a, r) => a + r.qty, 0),
    cost: chosen.reduce((a, r) => a + r.stock_value, 0),
    expected: chosen.reduce((a, r) => a + r.expected_realisation, 0),
  }
  const active = Object.values(f).filter(Boolean).length + (q ? 1 : 0)

  return (
    <>
      <Section id="ds-register" title="Dead Stock Register"
        summary={data ? `${rows.length} line(s)` : 'reading…'}
        actions={<>
          <SearchBox value={q} onChange={setQ} placeholder="SKU, product, category, supplier…" />
          <FilterButton open={open} onToggle={() => setOpen((o) => !o)} active={active} />
        </>}>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <FilterChips value={status} onChange={setStatus} options={[
            ['dead', 'Dead', null, `No movement for ${data?.rules?.dead_after_days ?? 90}+ days — includes critical`],
            ['critical', 'Critical', null, `Unsold for ${data?.rules?.critical_days ?? 180}+ days`],
            ['approaching', 'Approaching', null, `Quiet for ${data?.rules?.approaching_days ?? 60}+ days, not dead yet`],
            ['healthy', 'Healthy', null, 'Still moving'],
            ['all', 'All stock', null, 'Every stocked line, whatever its age'],
          ]} />
        </div>
        <FilterPanel open={open} active={active} onClear={() => {
          setQ(''); setF({ bucket: '', category: '', supplier: '', size: '', min_value: '', min_qty: '' })
        }} onApply={load} hint="Narrow the register, then select the lines to clear.">
          <div><label>Age band</label>
            <select value={f.bucket} onChange={(e) => setF({ ...f, bucket: e.target.value })}>
              <option value="">Any</option>
              {(data?.options?.buckets || []).map((b) => <option key={b} value={b}>{b}</option>)}
            </select></div>
          <div><label>Category</label>
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="">Any</option>
              {(data?.options?.categories || []).map((x) => <option key={x} value={x}>{x}</option>)}
            </select></div>
          <div><label>Supplier</label>
            <select value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })}>
              <option value="">Any</option>
              {(data?.options?.suppliers || []).map((x) => <option key={x} value={x}>{x}</option>)}
            </select></div>
          <div><label>Size</label>
            <select value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })}>
              <option value="">Any</option>
              {(data?.options?.sizes || []).map((x) => <option key={x} value={x}>{x}</option>)}
            </select></div>
          <div><label>Stock value at least</label>
            <input value={f.min_value} inputMode="decimal"
              onChange={(e) => setF({ ...f, min_value: e.target.value })} placeholder="₹" /></div>
          <div><label>Quantity at least</label>
            <input value={f.min_qty} inputMode="decimal"
              onChange={(e) => setF({ ...f, min_qty: e.target.value })} placeholder="pcs" /></div>
        </FilterPanel>

        {busy && !data && <div className="empty" style={{ marginTop: 30 }}>Reading the stock…</div>}
        {data && rows.length === 0 && (
          <div className="empty" style={{ marginTop: 30 }}>
            {status === 'dead'
              ? `Nothing has been still for ${data.rules.dead_after_days}+ days. Try “All stock” to see what is moving.`
              : 'Nothing matches these filters.'}
          </div>
        )}
        {rows.length > 0 && (
          <>
            <div className="tablewrap">
              <table className="items" style={{ minWidth: 1420 }}>
                <thead><tr>
                  <th style={{ width: 30 }}>
                    <input type="checkbox" checked={allShown} onChange={toggleAll}
                      title="Select every line on this page" /></th>
                  <th style={{ width: 96 }}>SKU</th>
                  <th style={{ minWidth: 190 }}>Product</th>
                  <th style={{ width: 58 }}>Size</th>
                  <th className="num" style={{ width: 56 }}>Qty</th>
                  <th className="num" style={{ width: 76 }}>Cost</th>
                  <th className="num" style={{ width: 76 }}>MRP</th>
                  <th style={{ width: 96 }}>Last sold</th>
                  <th className="num" style={{ width: 62 }}>Days</th>
                  <th style={{ width: 108 }}>Age band</th>
                  <th className="num" style={{ width: 66 }}>Disc</th>
                  <th className="num" style={{ width: 88 }}>Clearance</th>
                  <th className="num" style={{ width: 96 }}>Expected</th>
                  <th style={{ width: 132 }}>Action</th>
                </tr></thead>
                <tbody>{page.slice.map((r) => (
                  <tr key={r.product_id} style={sel.has(r.product_id) ? { background: 'var(--brand-50)' } : undefined}>
                    <td><input type="checkbox" checked={sel.has(r.product_id)}
                      onChange={() => toggle(r.product_id)} /></td>
                    <td className="mono">{r.sku}</td>
                    <td>{r.name}
                      {r.category && <div className="cellsub">{r.category}</div>}</td>
                    <td>{r.size || '—'}</td>
                    <td className="num">{r.qty}</td>
                    <td className="num">{rupees(r.cost_price)}</td>
                    <td className="num">{r.mrp == null
                      ? <span title={`No MRP on this product — the clearance price is worked out off ${r.price_source === 'cost' ? 'cost, which is a loss, not a markdown' : 'the sale price'}`}
                          style={{ color: 'var(--warn)' }}>none</span>
                      : rupees(r.mrp)}</td>
                    <td className="small" title={DS_BASIS[r.basis]}>
                      {fmtDate(r.moved_on)}
                      <div className="cellsub">{r.basis === 'sale' ? 'till sale'
                        : r.basis === 'dispatch' ? 'dispatched' : 'never sold'}</div></td>
                    <td className="num"><b>{r.days_idle}</b></td>
                    <td>{DS_DOT[r.status]} <span className="small">{r.bucket}</span></td>
                    <td className="num">{pct(r.discount_pct)}</td>
                    <td className="num">{rupees(r.clearance_price)}</td>
                    <td className="num">{rupees(r.expected_realisation)}</td>
                    <td>
                      <select value={actions[r.product_id] || 'Review'}
                        onChange={(e) => setActions({ ...actions, [r.product_id]: e.target.value })}
                        title="What to do with this line — carried onto the worksheet">
                        {DS_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Pager {...page} noun="line" />
            <div className="items-foot">
              <span>{rows.length} line(s) · Σ {data.totals.qty} pcs</span>
              <span>Σ stock value <b>{rupees(data.totals.stock_value)}</b></span>
              <span>Σ expected <b>{rupees(data.totals.expected_realisation)}</b></span>
              <button className="btn primary" style={{ marginLeft: 'auto' }}
                disabled={!chosen.length} onClick={() => setAdding(true)}
                title={chosen.length ? 'Put these lines on a clearance worksheet' : 'Select some lines first'}>
                Add {chosen.length || ''} to clearance</button>
            </div>
            {chosen.length > 0 && (
              <div className="small" style={{ color: 'var(--text-2)', marginTop: 6 }}>
                Selected: {chosen.length} line(s) · {Math.round(selTotals.qty * 1000) / 1000} pcs ·
                cost <b>{rupees(selTotals.cost)}</b> · expected <b>{rupees(selTotals.expected)}</b>
              </div>
            )}
          </>
        )}
        <DsSource pos={data?.pos} />
      </Section>

      {adding && (
        <DsAddToClearance rows={chosen} actions={actions} toast={toast}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); setSel(new Set()); load(); onChanged && onChanged() }} />
      )}
    </>
  )
}

const DS_ACTIONS = ['Clear Now', 'Markdown', 'Bundle', 'Promotional Sale',
  'Transfer to Store', 'Return to Supplier', 'Hold', 'Review']

// Putting selected lines on a worksheet — onto a draft that is already open, or
// onto a new one. Two ways in, because a clearance is built over a morning, not
// in one pass of the register.
function DsAddToClearance({ rows, actions, onClose, onDone, toast }) {
  const [drafts, setDrafts] = useState([])
  const [target, setTarget] = useState('new')
  const [name, setName] = useState(() => {
    const d = new Date()
    return `${d.toLocaleString('en-IN', { month: 'long' })} ${d.getFullYear()} Clearance`
  })
  const iso = (d) => d.toISOString().slice(0, 10)
  const [from, setFrom] = useState(() => iso(new Date()))
  const [to, setTo] = useState(() => iso(new Date(Date.now() + 30 * 864e5)))
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.clearanceList('draft').then(setDrafts).catch(() => {}) }, [])

  const ids = rows.map((r) => r.product_id)
  const picked = {}
  ids.forEach((id) => { picked[String(id)] = actions[id] || 'Review' })
  const totals = {
    qty: rows.reduce((a, r) => a + r.qty, 0),
    cost: rows.reduce((a, r) => a + r.stock_value, 0),
    expected: rows.reduce((a, r) => a + r.expected_realisation, 0),
  }

  const save = async () => {
    setBusy(true)
    try {
      const r = target === 'new'
        ? await api.clearanceCreate({ name, starts_on: from, ends_on: to, product_ids: ids, actions: picked })
        : await api.clearanceAddLines(+target, ids, picked)
      toast(`✓ ${r.added} line(s) on “${r.name}”${r.skipped ? ` · ${r.skipped} already there or out of stock` : ''}`, 'ok')
      onDone()
    } catch (e) { toast(e.detail || 'Could not add the lines', 'err'); setBusy(false) }
  }

  return (
    <div className="piece-wrap" onClick={onClose}>
      <div className="piece-card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="piece-head"><b>Add to a clearance worksheet</b>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button></div>
        <div className="piece-body">
          <div className="small" style={{ color: 'var(--text-2)', marginBottom: 12 }}>
            {rows.length} line(s) · {Math.round(totals.qty * 1000) / 1000} pcs ·
            stock cost <b>{rupees(totals.cost)}</b> · expected <b>{rupees(totals.expected)}</b>.
            The age, band, discount and price are copied onto the worksheet as they are today — that is
            what the campaign is approved at, and it does not drift as the stock goes on ageing.
          </div>
          <div className="field"><label>Worksheet</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="new">➕ A new worksheet</option>
              {drafts.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.line_count} line(s)</option>)}
            </select></div>
          {target === 'new' && <>
            <div className="field"><label>Campaign name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div style={{ display: 'flex', gap: 10 }}>
              <DateField label="Runs from" value={from} onChange={setFrom} />
              <DateField label="Runs to" value={to} onChange={setTo} />
            </div>
            <div className="small" style={{ color: 'var(--muted)', marginTop: 4 }}>
              Sales at the till between these dates are what this campaign realised.
            </div>
          </>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={busy || !ids.length}>
              {busy ? 'Adding…' : `Add ${ids.length} line(s)`}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- the worksheets, and how each one is actually doing ----------
function DsWorksheets({ toast }) {
  const [list, setList] = useState([])
  const [open, setOpen] = useState(null)          // the campaign being read
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    setBusy(true)
    return api.clearanceList('all').then(setList).catch(() => {}).finally(() => setBusy(false))
  }, [])
  useEffect(() => { load() }, [load])

  const openOne = async (id) => {
    try { setOpen(await api.clearanceGet(id)) }
    catch { toast('Could not open that worksheet', 'err') }
  }
  const patch = async (body) => {
    try { const c = await api.clearanceUpdate(open.id, body); setOpen(c); load() }
    catch (e) { toast(e.detail || 'Could not save', 'err') }
  }
  const patchLine = async (lineId, body) => {
    try { setOpen(await api.clearanceUpdateLine(open.id, lineId, body)) }
    catch (e) { toast(e.detail || 'Could not save the line', 'err') }
  }
  const dropLine = async (lineId) => {
    try { setOpen(await api.clearanceDeleteLine(open.id, lineId)) }
    catch (e) { toast(e.detail || 'Could not remove the line', 'err') }
  }
  const remove = async (c) => {
    if (!window.confirm(`Delete “${c.name}”?\n\nThe worksheet and its ${c.line_count} line(s) go. No stock is affected — a clearance worksheet holds none.`)) return
    try { await api.clearanceDelete(c.id); toast('Worksheet deleted', 'ok'); setOpen(null); load() }
    catch (e) { toast(e.detail || 'Could not delete it', 'err') }
  }

  if (open) {
    const t = open.totals
    return (
      <Section id="ds-sheet" title={open.name}
        summary={`${open.status} · ${open.line_count} line(s)`}
        actions={<button className="btn" onClick={() => { setOpen(null); load() }}>‹ All worksheets</button>}>
        <div className="dgrid" style={{ marginBottom: 14 }}>
          <DashTile label="Products" value={t.qty + ' pcs'} accent="stock" sub={`${open.line_count} line(s) in the campaign`} />
          <DashTile label="Stock cost" value={rupees(t.stock_cost)} accent="money" sub="what these pieces cost us" />
          <DashTile label="Expected" value={rupees(t.expected_realisation)} accent="money" sub="at the approved clearance prices" />
          <DashTile label="Actually sold" value={t.sold_qty + ' pcs'} accent="move"
            sub={t.sell_through_pct == null ? 'nothing yet' : `${t.sell_through_pct}% sell-through`}
            tone={t.sold_qty ? '' : 'warn'} />
          <DashTile label="Actually realised" value={rupees(t.actual_realisation)} accent="money"
            sub={t.realisation_pct == null ? 'read from the till' : `${t.realisation_pct}% of expected`} />
          <DashTile label="Remaining" value={t.remaining_qty + ' pcs'} accent="stock" sub="still on the shelf" />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
          <div className="field" style={{ minWidth: 220 }}><label>Campaign name</label>
            <input defaultValue={open.name} onBlur={(e) => e.target.value !== open.name && patch({ name: e.target.value })} /></div>
          <DateField label="Runs from" value={open.starts_on} onChange={(v) => patch({ starts_on: v })} />
          <DateField label="Runs to" value={open.ends_on} onChange={(v) => patch({ ends_on: v })} />
          <div className="field"><label>Status</label>
            <select value={open.status} onChange={(e) => patch({ status: e.target.value })}
              title="Draft is being built · Active is running · Closed stops counting new sales">
              <option value="draft">Draft</option><option value="active">Active</option>
              <option value="closed">Closed</option>
            </select></div>
          <button className="btn" onClick={() => remove(open)} title="Delete this worksheet">🗑 Delete</button>
        </div>
        <div className="small" style={{ color: 'var(--muted)', marginBottom: 10 }}>
          Sold and realised are the till's own figures for these products between the campaign dates —
          nothing is keyed in here, and nothing here holds stock.
        </div>
        <div className="tablewrap">
          <table className="items" style={{ minWidth: 1180 }}>
            <thead><tr>
              <th style={{ width: 96 }}>SKU</th><th style={{ minWidth: 180 }}>Product</th>
              <th className="num" style={{ width: 56 }}>Days</th><th style={{ width: 104 }}>Band</th>
              <th className="num" style={{ width: 66 }}>Disc %</th>
              <th className="num" style={{ width: 84 }}>Price</th>
              <th className="num" style={{ width: 60 }}>Qty</th>
              <th className="num" style={{ width: 92 }}>Expected</th>
              <th className="num" style={{ width: 56 }}>Sold</th>
              <th className="num" style={{ width: 72 }}>Left</th>
              <th className="num" style={{ width: 96 }}>Realised</th>
              <th style={{ width: 132 }}>Action</th><th style={{ width: 34 }}></th>
            </tr></thead>
            <tbody>{(open.lines || []).map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.sku}</td>
                <td>{l.name}{l.size ? <span className="small"> · {l.size}</span> : null}</td>
                <td className="num">{l.days_idle}</td>
                <td className="small">{l.bucket}</td>
                <td className="num">
                  <input defaultValue={l.discount_pct} inputMode="decimal" style={{ width: 52 }}
                    title="Override the ladder for this line — the price and the expected figure follow it"
                    onBlur={(e) => Number(e.target.value) !== l.discount_pct
                      && patchLine(l.id, { discount_pct: Number(e.target.value) })} /></td>
                <td className="num">{rupees(l.clearance_price)}</td>
                <td className="num">{l.qty}</td>
                <td className="num">{rupees(l.expected_realisation)}</td>
                <td className="num"><b>{l.sold_qty}</b></td>
                <td className="num">{l.remaining_qty}</td>
                <td className="num">{rupees(l.actual_realisation)}</td>
                <td><select value={l.action || 'Review'} onChange={(e) => patchLine(l.id, { action: e.target.value })}>
                  {DS_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}</select></td>
                <td><button className="btn" style={{ padding: '2px 7px' }} title="Remove this line"
                  onClick={() => dropLine(l.id)}>×</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {!open.lines?.length && <div className="empty" style={{ marginTop: 24 }}>
          No lines yet — open the Register, select what to clear and add it here.</div>}
      </Section>
    )
  }

  return (
    <Section id="ds-sheets" title="Clearance worksheets" summary={`${list.length} campaign(s)`}>
      {busy && !list.length && <div className="empty" style={{ marginTop: 30 }}>Reading…</div>}
      {!busy && !list.length && (
        <div className="empty" style={{ marginTop: 30 }}>
          No clearance worksheets yet. Open the <b>Register</b>, select the lines to clear and add them to one.
        </div>
      )}
      {list.length > 0 && (
        <div className="tablewrap">
          <table className="items">
            <thead><tr><th>Campaign</th><th>Status</th><th>Period</th>
              <th className="num">Lines</th><th className="num">Pcs</th><th className="num">Stock cost</th>
              <th className="num">Expected</th><th className="num">Sold</th>
              <th className="num">Realised</th><th className="num">Sell-through</th><th></th></tr></thead>
            <tbody>{list.map((c) => (
              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => openOne(c.id)}>
                <td><b>{c.name}</b>{c.note && <div className="cellsub">{c.note}</div>}</td>
                <td><span className={'badge ' + (c.status === 'closed' ? 'posted' : c.status === 'active' ? 'confirmed' : 'draft')}>{c.status}</span></td>
                <td className="small">{fmtDate(c.starts_on)} → {fmtDate(c.ends_on)}</td>
                <td className="num">{c.line_count}</td>
                <td className="num">{c.totals.qty}</td>
                <td className="num">{rupees(c.totals.stock_cost)}</td>
                <td className="num">{rupees(c.totals.expected_realisation)}</td>
                <td className="num">{c.totals.sold_qty}</td>
                <td className="num">{rupees(c.totals.actual_realisation)}</td>
                <td className="num">{c.totals.sell_through_pct == null ? '—' : c.totals.sell_through_pct + '%'}</td>
                <td><button className="btn" style={{ padding: '2px 7px' }}
                  onClick={(e) => { e.stopPropagation(); remove(c) }}>×</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

// ---------- the summary: the same dead stock, grouped ----------
function DsSummary({ sum }) {
  const t = sum.totals
  const maxCat = Math.max(1, ...sum.by_category.map((g) => g.stock_value))
  return (
    <>
      <Section id="ds-sum-tiles" title="Dead stock summary" summary={`${t.lines} line(s)`}>
        <DsTiles tiles={[
          { label: 'Dead stock', value: t.qty + ' pcs', accent: 'stock', sub: `${t.lines} product line(s)` },
          { label: 'Stock value', value: rupees(t.stock_value), accent: 'money', sub: 'at weighted-average cost' },
          { label: 'Expected cash', value: rupees(t.expected_realisation), accent: 'money', sub: 'at ladder prices' },
          { label: 'Recovery', value: t.recovery_pct == null ? '—' : t.recovery_pct + '%',
            accent: 'adjust', sub: 'expected cash ÷ stock cost' },
        ]} />
      </Section>

      <Section id="ds-by-cat" title="By category" summary={`${sum.by_category.length} categor(y/ies)`}>
        {!sum.by_category.length && <div className="empty">Nothing dead to group.</div>}
        {sum.by_category.length > 0 && (
          <div className="tablewrap">
            <table className="items">
              <thead><tr><th>Category</th><th className="num">Lines</th><th className="num">Qty</th>
                <th className="num">Cost value</th><th className="num">Expected realisation</th>
                <th className="num">Recovery</th><th style={{ width: 180 }}>Share of locked capital</th></tr></thead>
              <tbody>{sum.by_category.map((g) => (
                <tr key={g.category}>
                  <td>{g.category}</td>
                  <td className="num">{g.lines}</td>
                  <td className="num">{g.qty}</td>
                  <td className="num">{rupees(g.stock_value)}</td>
                  <td className="num">{rupees(g.expected_realisation)}</td>
                  <td className="num">{g.recovery_pct == null ? '—' : g.recovery_pct + '%'}</td>
                  <td><div style={{ background: 'var(--panel-3)', borderRadius: 3, height: 10 }}>
                    <div style={{ width: `${Math.round(g.stock_value / maxCat * 100)}%`, height: '100%',
                      background: 'var(--brand)', borderRadius: 3 }} /></div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="ds-by-band" title="By age band" summary="the ladder, as it actually falls">
        {!sum.by_bucket.length && <div className="empty">Nothing dead to band.</div>}
        {sum.by_bucket.length > 0 && (
          <div className="tablewrap">
            <table className="items">
              <thead><tr><th>Age band</th><th className="num">Discount</th><th className="num">Lines</th>
                <th className="num">Qty</th><th className="num">Cost value</th>
                <th className="num">Expected realisation</th></tr></thead>
              <tbody>{sum.by_bucket.map((b) => (
                <tr key={b.bucket}>
                  <td>{b.bucket}</td>
                  <td className="num">{pct(b.discount_pct)}</td>
                  <td className="num">{b.lines}</td>
                  <td className="num">{b.qty}</td>
                  <td className="num">{rupees(b.stock_value)}</td>
                  <td className="num">{rupees(b.expected_realisation)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  )
}

// ---------- what clearing it is worth, and on what assumptions ----------
function DsCash({ sum, toast, onSaved }) {
  const c = sum.cash_impact
  const [turns, setTurns] = useState(String(c.stock_turns ?? ''))
  const [margin, setMargin] = useState(String(c.gross_margin_pct ?? ''))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api.saveDeadStockRules({ stock_turns: Number(turns), gross_margin_pct: Number(margin) })
      toast('✓ Assumptions saved', 'ok'); onSaved()
    } catch (e) { toast(e.detail || 'Could not save', 'err') }
    setBusy(false)
  }
  return (
    <>
      <Section id="ds-cash" title="Cash impact" summary="what the shelf is holding, and what it would return">
        <DsTiles tiles={[
          { label: 'Capital locked', value: rupees(c.capital_locked), accent: 'money',
            sub: 'cost of stock that has stopped moving', tone: c.capital_locked ? 'warn' : '' },
          { label: 'Expected cash', value: rupees(c.expected_cash), accent: 'money',
            sub: 'if every dead line clears at its ladder price' },
          { label: 'Expected recovery', value: c.recovery_pct == null ? '—' : c.recovery_pct + '%',
            accent: 'adjust', sub: 'cash out against cost in' },
          { label: 'Annual revenue potential', value: rupees(c.annual_revenue_potential),
            accent: 'money', sub: `that cash turned over ${c.stock_turns}× a year` },
          { label: 'Annual gross profit', value: rupees(c.annual_gross_profit),
            accent: 'money', sub: `at ${c.gross_margin_pct}% gross margin` },
        ]} />
        <div className="small" style={{ color: 'var(--text-2)', marginTop: 12, maxWidth: 760, lineHeight: 1.6 }}>
          The first three figures are facts about stock that exists. The last two are a
          <b> projection</b>: freed capital, assumed to turn over {c.stock_turns} times a year at
          {' '}{c.gross_margin_pct}% margin. They are here because “₹{money(c.capital_locked)} is asleep on a shelf”
          is not an argument anyone acts on, and “that capital would earn ₹{money(c.annual_gross_profit)} a year
          if it were working” is.
        </div>
      </Section>
      <Section id="ds-assume" title="Assumptions" summary="used by the two projected figures above">
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field"><label>Stock turns per year</label>
            <input value={turns} inputMode="decimal" onChange={(e) => setTurns(e.target.value)} style={{ width: 120 }} /></div>
          <div className="field"><label>Gross margin %</label>
            <input value={margin} inputMode="decimal" onChange={(e) => setMargin(e.target.value)} style={{ width: 120 }} /></div>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save assumptions'}</button>
        </div>
      </Section>
    </>
  )
}

// ---------- the ladder, as a policy someone owns ----------
function DsRules({ toast, onSaved }) {
  const [rules, setRules] = useState(null)
  const [defaults, setDefaults] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.deadStockRules().then((r) => { setRules(r.rules); setDefaults(r.defaults) }).catch(() => {})
  }, [])
  if (!rules) return <div className="empty" style={{ marginTop: 30 }}>Reading the rules…</div>

  const setBucket = (i, k, v) => {
    const b = rules.buckets.map((x, j) => (j === i ? { ...x, [k]: v } : x))
    setRules({ ...rules, buckets: b })
  }
  const addBucket = () => setRules({
    ...rules,
    buckets: [...rules.buckets, { from: 0, to: null, label: '', discount: 0 }],
  })
  const dropBucket = (i) => setRules({ ...rules, buckets: rules.buckets.filter((_, j) => j !== i) })
  const save = async () => {
    setBusy(true)
    try {
      const r = await api.saveDeadStockRules({
        buckets: rules.buckets.map((b) => ({
          from: Number(b.from) || 0,
          to: b.to === '' || b.to == null ? null : Number(b.to),
          label: b.label, discount: Number(b.discount) || 0,
        })),
        approaching_days: Number(rules.approaching_days),
        dead_after_days: Number(rules.dead_after_days),
        critical_days: Number(rules.critical_days),
      })
      setRules(r.rules)
      toast('✓ Rules saved — every screen uses them from now on', 'ok')
      onSaved()
    } catch (e) { toast(e.detail || 'Could not save the rules', 'err') }
    setBusy(false)
  }

  return (
    <>
      <Section id="ds-ladder" title="Discount ladder"
        summary={`${rules.buckets.length} band(s)`}
        actions={<button className="btn" onClick={() => setRules({ ...rules, ...defaults })}
          title="Put back the ladder this install shipped with">Reset to default</button>}>
        <div className="small" style={{ color: 'var(--text-2)', marginBottom: 12, maxWidth: 720 }}>
          The discount a line is offered at, by how long it has been still. Bands are read in order and
          the last one is open-ended. Changing a percentage here changes what the register suggests —
          it never re-prices a worksheet that has already been approved.
        </div>
        <div className="tablewrap">
          <table className="items" style={{ maxWidth: 720 }}>
            <thead><tr><th style={{ width: 90 }}>From (days)</th><th style={{ width: 90 }}>To (days)</th>
              <th>Label</th><th className="num" style={{ width: 100 }}>Discount %</th>
              <th style={{ width: 34 }}></th></tr></thead>
            <tbody>{rules.buckets.map((b, i) => (
              <tr key={i}>
                <td><input value={b.from} inputMode="numeric" onChange={(e) => setBucket(i, 'from', e.target.value)} /></td>
                <td><input value={b.to == null ? '' : b.to} inputMode="numeric" placeholder="∞"
                  onChange={(e) => setBucket(i, 'to', e.target.value)} /></td>
                <td><input value={b.label} onChange={(e) => setBucket(i, 'label', e.target.value)} /></td>
                <td className="num"><input value={b.discount} inputMode="decimal" style={{ width: 70 }}
                  onChange={(e) => setBucket(i, 'discount', e.target.value)} /></td>
                <td><button className="btn" style={{ padding: '2px 7px' }} onClick={() => dropBucket(i)}>×</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <button className="btn" style={{ marginTop: 10 }} onClick={addBucket}>➕ Add a band</button>
      </Section>

      <Section id="ds-thresholds" title="When a line is called dead"
        summary="the three lines the alerts are drawn at">
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field"><label>🟠 Approaching after (days)</label>
            <input value={rules.approaching_days} inputMode="numeric" style={{ width: 120 }}
              onChange={(e) => setRules({ ...rules, approaching_days: e.target.value })} /></div>
          <div className="field"><label>🔴 Dead after (days)</label>
            <input value={rules.dead_after_days} inputMode="numeric" style={{ width: 120 }}
              onChange={(e) => setRules({ ...rules, dead_after_days: e.target.value })} /></div>
          <div className="field"><label>🔥 Critical after (days)</label>
            <input value={rules.critical_days} inputMode="numeric" style={{ width: 120 }}
              onChange={(e) => setRules({ ...rules, critical_days: e.target.value })} /></div>
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save rules'}</button>
        </div>
      </Section>
    </>
  )
}

// ==========================================================================
//  Warehouse menu · Dashboard
//  ------------------------------------------------------------------------
//  Eleven modules laid out on one strip made the strip into the screen, and it
//  still scrolled sideways at 1600px. They are not eleven unrelated things —
//  they are one warehouse, walked through in an order (a consignment arrives,
//  an invoice is read, goods are received, stock moves, money settles). So they
//  live behind one WAREHOUSE menu, in that order, each saying what it is for.
//
//  The dashboard sits at the top of that same menu, above a rule, because it is
//  not a twelfth module — it is the way in to the eleven. It earns first place
//  by answering the question that used to be answered by opening all of them:
//  what is waiting on me. Every figure on it is a link to the screen that clears
//  it — a number nobody can act on is decoration.
// ==========================================================================

// ==========================================================================
//  Item Locator — one scanned tag, the whole account of an item
//  ------------------------------------------------------------------------
//  Somebody is holding a garment and wants to know what it is. That question is
//  never only "what is it": it is followed, every time, by where it came from,
//  where it is meant to be, where it has gone and what it cost — and those live
//  on four different screens, each of which has to be found first.
//
//  Every tag the warehouse prints is accepted, because the person holding one
//  does not know which kind it is. A product QR, the per-piece code off a single
//  garment, a carton label, a printed barcode, or a SKU typed in from a
//  scribbled note all go into the same box.
// ==========================================================================

// A block of labelled figures. Rows whose value is null are dropped rather than
// printed as dashes: eleven attributes with three filled in is a card about three
// attributes, and eight empty lines between them is eight lines of nothing to
// read past. A row that must show even when empty passes a value of ''.
function KV({ rows }) {
  const shown = rows.filter((r) => r && r[1] !== null && r[1] !== undefined)
  if (!shown.length) return <div className="empty" style={{ margin: '4px 0', fontSize: 13 }}>Nothing recorded.</div>
  return (
    <div className="kv">
      {shown.map(([k, v]) => (
        <React.Fragment key={k}>
          <div className="k">{k}</div>
          <div>{v === '' ? '—' : v}</div>
        </React.Fragment>
      ))}
    </div>
  )
}

// Print the sticker from here.
//
// The commonest reason anybody is on this screen holding a garment is that its
// tag has come off or cannot be read. Sending them to QR / Label Printing to
// find the item a second time — by the code they have just established they
// cannot read — is the one thing this screen exists to avoid. So the same sheet
// the printing screen opens is opened from here, against the item already on
// the page.
//
// Three sheets, because there are three questions: how many stickers of this
// DESIGN, every remaining PIECE of it, and the one piece in your hand. The last
// is only offered when a piece code was what was scanned, because only then is
// there a particular garment to mean.
function LocatorPrint({ res, toast }) {
  const p = res.product
  const [templates, setTemplates] = useState([])
  const [tpl, setTpl] = useState(0)
  const [copies, setCopies] = useState('1')
  // Active ones only, and the default pre-picked — the same shape the printing
  // screen loads, so the two offer the same list rather than two opinions of it.
  // A failure is silent here: the print endpoint falls back to the default
  // template on its own, so a locator that could not reach the designer can
  // still print.
  useEffect(() => {
    api.labelTemplates().then((ts) => {
      const live = (ts || []).filter((t) => t.active)
      setTemplates(live)
      const def = live.find((t) => t.is_default) || live[0]
      if (def) setTpl(def.id)
    }).catch(() => {})
  }, [])

  const ok = res.printing?.can_print !== false
  const why = res.printing?.why
  const open = (url) => window.open(url, '_blank')
  const guard = () => {
    if (ok) return true
    toast(why || 'Labels cannot be printed for this item', 'err')
    return false
  }
  const n = Math.max(1, Math.min(999, Math.round(+copies || 1)))
  const pieces = res.unit_counts?.in_stock || 0

  return (
    <div className="section locprint">
      <h4>QR &amp; labels</h4>
      <div className="locprint-row">
        <img className="locprint-qr" alt="QR code"
          src={api.qrSvgUrl(p.product_id, 4)}
          title={p.qr_payload || p.sku} />
        <div className="locprint-acts">
          <div className="field" style={{ width: 200 }}>
            <label>Template</label>
            <select value={tpl} onChange={(e) => setTpl(+e.target.value)}
              title="Laid out in Label Designer. Without a choice the default is used.">
              {!templates.length && <option value={0}>Default template</option>}
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.is_default ? ' · default' : ''}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ width: 92 }}>
            <label>Copies</label>
            <input value={copies} inputMode="numeric"
              onChange={(e) => setCopies(e.target.value)}
              title="How many stickers of this design" />
          </div>
          <button className="btn primary" disabled={!ok}
            title={ok ? `Open a sheet of ${n} label(s) for ${p.sku}` : why}
            onClick={() => guard() && open(api.labelPrintUrl(tpl, [{ id: p.product_id, qty: n }]))}>
            🖨 Print {n} label{n === 1 ? '' : 's'}
          </button>
          {/* every remaining piece, each carrying its OWN code — not n copies of
              one sticker. A garment's tag is unique to that garment. */}
          {pieces > 0 && (
            <button className="btn" disabled={!ok}
              title={ok ? `One label per piece — ${pieces} in stock, each with its own code` : why}
              onClick={() => guard() && open(api.labelPrintUrl(tpl, [], { unitProducts: [p.product_id] }))}>
              🏷 All {pieces} piece label{pieces === 1 ? '' : 's'}
            </button>
          )}
          {res.unit?.id && (
            <button className="btn" disabled={!ok}
              title={ok ? `Reprint the tag for piece ${res.unit.code}` : why}
              onClick={() => guard() && open(api.labelPrintUrl(tpl, [], { units: [res.unit.id] }))}>
              ⧉ This piece only
            </button>
          )}
          <a className="btn" href={api.labelUrl(p.product_id)} target="_blank" rel="noreferrer"
            title="The plain label this product prints without a template">Plain label</a>
        </div>
      </div>
      <div className={'small' + (ok ? '' : ' printblocked')}>
        {ok
          ? <>Opens in a new tab, ready for the printer. Piece labels count as printed,
              so Inventory offers a reprint afterwards rather than pretending they were not.</>
          : <>⚠ {why}</>}
      </div>
    </div>
  )
}

// How long it has been standing. The number of days is the single most useful
// thing anyone can say about a garment nobody has sold, and the transport
// register already carries the holding period it was bought against — so this
// can say it is LATE, which is the part that needs acting on.
function AgeChip({ age }) {
  if (!age) return null
  const late = age.overdue_by > 0
  return (
    <span className={'agechip' + (late ? ' late' : '')}
      title={`Received ${fmtDate(age.received_on)}`
        + (age.holding_days ? ` · bought against a ${age.holding_days}-day holding period` : '')}>
      {age.days} day{age.days === 1 ? '' : 's'}{late ? ` · ${age.overdue_by} over` : ''}
    </span>
  )
}

function LocatorRows({ title, rows, cols, empty }) {
  if (!rows || !rows.length) return (
    <div className="section"><h4>{title}</h4>
      <div className="empty" style={{ margin: '6px 0', fontSize: 13 }}>{empty}</div></div>
  )
  return (
    <div className="section">
      <h4>{title} <span className="panelsum">{rows.length}</span></h4>
      <div className="tablewrap">
        <table className="items">
          <thead><tr>{cols.map(([, h, num]) =>
            <th key={h} className={num ? 'num' : undefined}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>{cols.map(([k, h, num, fmt]) => (
              <td key={h} className={num ? 'num' : undefined}>
                {fmt ? fmt(r[k], r) : (r[k] ?? '—')}</td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  )
}

function ItemLocator({ toast }) {
  const [code, setCode] = useState('')
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const box = useRef(null)

  // The box holds focus because a scanner IS a keyboard: it types the code and
  // presses Enter. A screen that has to be clicked first turns every scan into a
  // scan plus a click, which is the whole saving gone.
  useEffect(() => { box.current?.focus() }, [])

  const look = async () => {
    const c = code.trim()
    if (!c) return
    setBusy(true); setErr('')
    try {
      const r = await api.locateItem(c)
      setRes(r); setCode('')
    } catch (e) {
      setRes(null)
      setErr(e.detail || 'Could not look that up')
    }
    setBusy(false)
    box.current?.focus()
  }

  const p = res?.product
  const con = res?.consignment
  const pr = res?.pricing
  const ws = res?.warehouse_stock
  //: the newest receipt — what the consignment, the age and the money hang off
  const first = res?.receipts?.[0]
  const money2 = (v) => (v == null ? '—' : '₹ ' + money(v))
  //: every date on this screen, in the house format — an ISO timestamp off a
  //  movement row and a plain date off an invoice both read the same way
  const day = (v) => fmtDate(v)

  return (
    <div className="screen scrolls">
      <div className="pagehead"><h2>Item Locator</h2></div>

      {/* this screen had no gutter at all: the header band was padded and every
          panel under it ran flush to the window edge, so the title started 22px
          in and the scan box started at 0 */}
      <div className="screenbody">
      <div className="section" style={{ maxWidth: 760 }}>
        <div className="field">
          <label>Scan a tag, or type a code</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input ref={box} value={code} style={{ flex: 1, fontSize: 15 }}
              placeholder="Product QR, piece code, carton label, barcode or SKU"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') look() }} />
            <button className="btn primary" disabled={busy || !code.trim()}
              onClick={look}>{busy ? 'Looking…' : 'Go'}</button>
          </div>
        </div>
        {err && <div className="empty" style={{ margin: '10px 0' }}>{err}</div>}
      </div>

      {res?.kind === 'bundle' && (
        <div className="section">
          <h4>Carton {res.bundle?.code}</h4>
          <div className="small" style={{ lineHeight: 1.8 }}>
            This is a CARTON label, not a garment — it names a box, so the answer
            is about the box.<br />
            Location <b>{res.bundle?.location || 'not put away yet'}</b> ·
            status <b>{res.bundle?.status || '—'}</b> ·
            GRN <b>{res.bundle?.grn_no || '—'}</b> ·
            invoice <b>{res.bundle?.invoice_number || '—'}</b> ·
            <b> {res.bundle?.qty ?? '—'}</b> inside
          </div>
        </div>
      )}

      {res?.kind === 'product' && (
        <>
          <div className="section">
            <h4>{p?.description || p?.name || 'Item'}
              <span className="panelsum">{p?.sku}</span></h4>
            <div className="small" style={{ marginBottom: 2 }}>
              {[p?.name !== p?.description ? p?.name : null, p?.variant,
                p?.category].filter(Boolean).join(' · ') || 'No attributes recorded yet'}
            </div>
            {res.unit && (
              <div className="small" style={{ marginTop: 6 }}>
                Scanned ONE piece: <b className="mono">{res.unit.code}</b>
                {' '}(#{res.unit.seq}) · {res.unit.status} — the difference between
                {' '}this design and this exact garment.
              </div>
            )}
          </div>

          {/* Four blocks that used to be four screens. Somebody holding the
              garment asks all of these in one breath — what is it, where did it
              come from, what did it cost, and how much of it is left — so they
              are answered side by side rather than one tab at a time. */}
          <div className="locgrid">
            <div className="section">
              <h4>Consignment &amp; invoice</h4>
              <KV rows={[
                ['Barcode', <span className="mono">{p?.supplier_barcode || p?.barcode || p?.sku}</span>],
                ['LR entry no / stock age',
                  (con?.lr_entry_no || res.age) ? (
                    <>{con?.lr_entry_no || '—'} <AgeChip age={res.age} /></>
                  ) : null],
                ['LR no / date', con ? `${con.lr_no || '—'} / ${fmtDate(con.lr_date)}` : null],
                ['Mode / transport', con
                  ? [con.mode, con.transport].filter(Boolean).join(' · ') || null : null],
                ['Supplier', con?.supplier_name || first?.supplier || p?.supplier || ''],
                ['Agent', con?.agent
                  ? con.agent + (con.agent_commission ? ` · ${con.agent_commission}%` : '') : null],
                ['GRN', first?.grn_no || null],
                ['Invoice no', first?.invoice_number || con?.inv_no || ''],
                ['Invoice date', day(first?.invoice_date || con?.inv_date)],
                ['Entry date', con?.lr_entry_date ? fmtDate(con.lr_entry_date) : null],
                ['Received on', res.age?.received_on ? fmtDate(res.age.received_on) : null],
                ['Consignment', con
                  ? [con.qty ? `${con.qty} pcs` : null, con.amount ? money2(con.amount) : null,
                     con.boxes ? `${con.boxes} box(es)` : null].filter(Boolean).join(' · ') || null
                  : null],
                ['Purchase manager', con?.purchase_manager || null],
                ['Onward branch', con?.auto_transfer_location || null],
                ['Freight', con?.paid_topay || null],
              ]} />
            </div>

            <div className="section">
              <h4>Cost &amp; margin</h4>
              <KV rows={[
                ['Base / cost price', pr?.cost ? money2(pr.cost) : ''],
                ['Last purchase rate',
                  pr?.last_rate && pr.last_rate !== pr.cost ? money2(pr.last_rate) : null],
                ['Net cost (incl. purchase tax)', pr?.net_cost
                  ? <>{money2(pr.net_cost)}{pr.purchase_tax_pct
                      ? <span className="small"> &nbsp;[{money2(pr.net_cost - pr.cost)} @ {pr.purchase_tax_pct}%]</span>
                      : null}</>
                  : null],
                ['MRP', pr?.mrp ? money2(pr.mrp) : ''],
                ['Selling price', pr?.sale_price
                  ? <>{money2(pr.sale_price)}{pr.discount
                      ? <span className="small"> &nbsp;[{money2(pr.mrp)} − {money2(pr.discount)}]</span>
                      : null}</>
                  : ''],
                ['Margin', pr?.margin != null
                  ? <>{money2(pr.margin)} <span className="small">&nbsp;{pr.margin_pct}% of the sell price</span></>
                  : null],
                ['Net margin', pr?.net_margin != null
                  ? <>{money2(pr.net_margin)} <span className="small">&nbsp;{pr.net_margin_pct}% — after the purchase tax</span></>
                  : null],
                ['Mark-up on cost', pr?.markup_pct != null
                  ? <span title="The same gap read from the other end: margin over COST, not over the sell price.">{pr.markup_pct}%</span>
                  : null],
              ]} />
            </div>

            <div className="section">
              <h4>Product attributes</h4>
              <KV rows={[
                ['Brand', p?.brand || ''], ['Colour', p?.color || ''],
                ['Pattern', p?.pattern], ['Style', p?.style],
                ['Material', p?.material], ['Type', p?.product_type],
                ['Sleeve', p?.sleeve], ['Fit', p?.fit],
                ['Design', p?.design_no || ''], ['Size', p?.size || ''],
                ['Category', p?.category], ['HSN', p?.hsn],
                ['UOM', p?.uom], ['SKU', <span className="mono">{p?.sku}</span>],
              ]} />
            </div>

            <div className="section">
              <h4>Warehouse stock</h4>
              {/* The stock figure is one number and it is the END of a story.
                  These are the story, and they add up to it. */}
              <KV rows={[
                ['Purchase qty', ws?.purchased ?? ''],
                ['Transferred out', ws?.transferred ?? ''],
                ['Returned to supplier', ws?.returned ?? ''],
                ['Damaged at the dock', ws?.damaged || null],
                ['Short on the bill', ws?.short || null],
                ['Excess over the bill', ws?.excess || null],
                ['Journal (physical audit)', ws?.adjusted || null],
                ['Reversed (unposted GRN)', ws?.reversed || null],
                ['Stock', <b>{ws?.stock ?? p?.stock_qty ?? 0}</b>],
                ['Stock value', p?.stock_value == null ? null : money2(p.stock_value)],
                ['Piece codes', `${res.unit_counts?.in_stock ?? 0} in stock of ${res.unit_counts?.total ?? 0} printed`],
              ]} />
            </div>
          </div>

          <LocatorPrint res={res} toast={toast} />

          <LocatorRows title="Retail stock — where the pieces are now" rows={res.locations}
            empty="Nothing has been dispatched, so every piece is still in this warehouse."
            cols={[['location', 'Location'], ['sent', 'Sent', true],
                   ['accepted', 'Accepted', true],
                   ['short_by', 'Short', true, (v) => (v ? <b style={{ color: 'var(--warn)' }}>{v}</b> : '—')],
                   ['sold', 'Sold', true], ['price', 'Price', true, money2],
                   ['discount', 'Discount', true, money2],
                   ['selling_price', 'Selling price', true, money2]]} />

          <LocatorRows title="Transfers" rows={res.transfers}
            empty="Never transferred out of the warehouse."
            cols={[['code', 'Code'], ['from', 'From'], ['to', 'To'],
                   ['packed_on', 'Packed on', false, day], ['packed_qty', 'Packed', true],
                   ['received_on', 'Received on', false, day],
                   ['received_qty', 'Received', true],
                   ['short_by', 'Short', true, (v) => (v ? <b style={{ color: 'var(--warn)' }}>{v}</b> : '—')],
                   ['status', 'Status']]} />

          {/* Whether it SOLD or is merely gone. From this side of the wall those
              two look identical — stock zero, nothing on the shelf — so the till
              is asked, read-only, and says so when it is not there to ask. */}
          {res.sales?.available ? (
            <LocatorRows
              title={`Sold at the till${res.sales.bills
                ? ` — ${res.sales.qty} on ${res.sales.bills} bill(s), ${money2(res.sales.amount)}` : ''}`}
              rows={res.sales.rows}
              empty="Never sold. It has not been through the till."
              cols={[['bill_no', 'Bill'], ['date', 'Date', false, day],
                     ['kind', 'Kind', false, (v) => (v === 'return' ? 'RETURN' : 'sale')],
                     ['customer', 'Customer'], ['qty', 'Qty', true],
                     ['rate', 'Rate', true, money2], ['tax', 'Tax', true, money2],
                     ['amount', 'Amount', true, money2]]} />
          ) : (
            <div className="section"><h4>Sold at the till</h4>
              <div className="empty" style={{ margin: '6px 0', fontSize: 13 }}>
                The shop's own database is not beside this warehouse, so nothing is
                known here about what has sold.
              </div>
            </div>
          )}

          <LocatorRows title="Where it came from" rows={res.receipts}
            empty="No receipt recorded — this item has not been booked in against a GRN."
            cols={[['grn_no', 'GRN'], ['supplier', 'Supplier'],
                   ['invoice_number', 'Invoice'], ['invoice_date', 'Inv date', false, day],
                   ['qty', 'Qty', true], ['rate', 'Rate', true, money2],
                   ['status', 'Status']]} />

          <LocatorRows title="Where it is" rows={res.cartons}
            empty="Not in any carton — either never bundled, or already opened."
            cols={[['code', 'Carton'], ['location', 'Location'],
                   ['qty', 'Qty', true], ['status', 'Status'],
                   ['grn_no', 'GRN'], ['invoice_number', 'Invoice']]} />

          <LocatorRows title="Where it went" rows={res.dispatches}
            empty="Never dispatched — it has not left this warehouse."
            cols={[['code', 'Dispatch'], ['date', 'Date', false, day],
                   ['to', 'To'], ['qty', 'Sent', true],
                   ['accepted_qty', 'Accepted', true], ['status', 'Status']]} />

          <LocatorRows title="Stock movements" rows={res.movements}
            empty="No movements recorded against this item."
            cols={[['at', 'When', false, day], ['kind', 'Kind'],
                   ['qty_delta', 'Change', true],
                   ['balance_after', 'Balance', true], ['note', 'Note']]} />
        </>
      )}
      </div>
    </div>
  )
}

const DASHBOARD = { key: 'dashboard', icon: '🏠', label: 'Dashboard',
  blurb: 'What is waiting on someone, across every module' }

// ==========================================================================
//  Users & Access — the super admin's screen
//  ------------------------------------------------------------------------
//  Everything on it is refused by the server for anyone else, so this is the
//  presentation of a rule rather than the rule itself. What it adds is the part
//  a 403 cannot: it says what each role means beside the control that sets it,
//  because "admin" and "user" are only obvious to whoever chose the words.
//
//  Deliberately not a modal. Adding people, resetting a forgotten password and
//  checking who has never signed in are the same sitting, and a dialog that has
//  to be closed to see the list turns that into three.
// ==========================================================================

const ROLE_HELP = {
  user: 'The floor — LR, invoice entry, GRN, inventory, label printing, dispatch and receipt. On the phone app too.',
  admin: 'All of the floor, plus the setup behind it — masters, suppliers, label design — and reports, payments, returns, dead stock, the audit trail and asking questions.',
  superadmin: 'Everything, plus this screen, the server settings (the vision key and model) and the Command Center.',
  superboss: 'Everything a super admin has — and the only rank that can create, change or remove a Super Boss. The owner’s seat.',
}

// ==========================================================================
//  Access editor — what one account may do, screen by screen
//  ------------------------------------------------------------------------
//  Three roles answer "how much of this app is yours" in three steps, and three
//  steps is not enough for a warehouse. A receiving clerk needs the GRN screen
//  and must not post a return; a stock auditor needs to read every screen and
//  change none of them. Both of those live inside one role, so the only way to
//  express either was to hand over the whole role.
//
//  Two things about this grid are worth knowing before ticking anything, and
//  both are said on the screen rather than only here:
//
//    * The ROLE IS STILL THE CEILING. Ticking Reports for a floor user does not
//      open Reports — the server still refuses it. A tick can only ever take
//      access away, never add it, which is what makes a mis-tick harmless.
//    * NO TICKS AT ALL means the role decides on its own, exactly as it did
//      before this existed. An empty grid is not "denied everything"; it is
//      "unrestricted", and it is what every existing account starts as.
// ==========================================================================
function AccessEditor({ user, catalog, onSave, onClose, toast }) {
  const [map, setMap] = useState(() => ({ ...(user.permissions?.screens || {}) }))
  const [data, setData] = useState(() => [...(user.permissions?.data || [])])
  // Which buildings this account may work inside. Empty means every one of
  // them — the same "nothing recorded means unrestricted" rule the screen map
  // above follows, and what keeps every existing account working untouched.
  const [whs, setWhs] = useState(() => [...(user.permissions?.warehouses || [])])
  // How much of the Store: 'admin' (every screen — what nothing recorded means)
  // or 'user' (Billing Counter and Store Reports). See services/permissions.
  const [store, setStore] = useState(() => (user.permissions?.store === 'user' ? 'user' : 'admin'))
  const [busy, setBusy] = useState(false)
  // The grid is normally drawn from the catalog that rides along with the user
  // list. When that is missing the screen must not open as an empty box: an
  // empty grid already MEANS something here — unrestricted — so a grid with no
  // rows because the server is old would read as a grid with nothing ticked.
  // Fetch it directly, and if that 404s, say what is actually wrong.
  const [own, setOwn] = useState(null)
  const [stale, setStale] = useState(false)
  useEffect(() => {
    if ((catalog.screens || []).length) return
    api.permissionCatalog().then(setOwn)
      .catch((e) => setStale(e.status === 404 || e.status === 405))
  }, [catalog])
  const cat = (catalog.screens || []).length ? catalog : (own || catalog)
  const acts = cat.actions || []
  const screens = cat.screens || []
  const restricted = Object.keys(map).length > 0

  const has = (k, a) => (map[k] || []).includes(a)
  const toggle = (k, a) => setMap((m) => {
    const cur = new Set(m[k] || [])
    if (cur.has(a)) cur.delete(a); else { cur.add(a); cur.add('view') }
    const kept = acts.map((x) => x.key).filter((x) => cur.has(x))
    const next = { ...m }
    if (kept.length) next[k] = kept; else delete next[k]
    return next
  })
  // A whole column at once. Sixteen rows of five boxes is eighty clicks to say
  // "read everything", which is a thing nobody does twice.
  const column = (a) => {
    const every = screens.every((sc) => has(sc.key, a))
    setMap((m) => {
      const next = { ...m }
      screens.forEach((sc) => {
        const cur = new Set(next[sc.key] || [])
        if (every) cur.delete(a); else { cur.add(a); cur.add('view') }
        const kept = acts.map((x) => x.key).filter((x) => cur.has(x))
        if (kept.length) next[sc.key] = kept; else delete next[sc.key]
      })
      return next
    })
  }
  const row = (k) => setMap((m) => {
    const every = acts.every((a) => (m[k] || []).includes(a.key))
    const next = { ...m }
    if (every) delete next[k]; else next[k] = acts.map((a) => a.key)
    return next
  })

  const submit = async () => {
    setBusy(true)
    try {
      await api.setUserPermissions(user.id, { screens: map, data, warehouses: whs, store })
      const where = whs.length
        ? `${whs.length} warehouse(s)`
        : 'every warehouse'
      const inStore = store === 'user' ? ' · Store: Billing & Reports only' : ''
      toast((Object.keys(map).length
        ? `✓ ${user.username} is restricted to ${Object.keys(map).length} screen(s), ${where}`
        : whs.length
          ? `✓ ${user.username} may work in ${where} — screens still decided by their role`
          : store === 'user'
            ? `✓ ${user.username} is saved`
            : `✓ ${user.username} is back to their role — nothing restricted`) + inStore, 'ok')
      await onSave(); onClose()
    } catch (e) { toast(e.detail || 'Could not save that', 'err') }
    setBusy(false)
  }

  const groups = []
  screens.forEach((sc) => {
    const g = groups.find((x) => x.name === sc.group)
    if (g) g.rows.push(sc); else groups.push({ name: sc.group, rows: [sc] })
  })

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal accessmodal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Access — {user.username}</b>
          <span className={'badge role-' + user.role}>{user.role_label}</span>
          <button className="modal-x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {!screens.length && (
            <div className="accessnote on">
              {stale
                ? <>This server was started before per-screen access existed.
                    <b> Restart the ESSA server and reload this page</b> — the grid
                    is drawn from a list only the server can supply, and until it
                    can there is nothing here to tick.</>
                : <>Loading the screen list…</>}
            </div>
          )}
          <div className={'accessnote' + (restricted ? ' on' : '')}>
            {restricted
              ? <>Restricted to what is ticked below. Their <b>{user.role_label}</b> role
                  is still the ceiling — a tick on a screen that role cannot reach
                  does nothing.</>
              : <>Nothing is ticked, so this account is <b>unrestricted</b> and its
                  role decides on its own — exactly as before. Tick anything and it
                  becomes restricted to what is ticked.</>}
          </div>
          <div className="tablewrap">
            <table className="items accessgrid">
              <thead><tr>
                <th>Screen</th>
                {acts.map((a) => (
                  <th key={a.key} title={a.why}>
                    <button className="link" onClick={() => column(a.key)}
                      title={`${a.label} on every screen`}>{a.label}</button>
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {groups.map((g) => (
                  <React.Fragment key={g.name}>
                    <tr className="accessgroup">
                      <td colSpan={acts.length + 1}>{g.name}</td>
                    </tr>
                    {g.rows.map((sc) => {
                      // A screen this role cannot reach at all is shown, not
                      // hidden — otherwise the grid silently changes shape per
                      // role and nobody can tell a screen that is missing from a
                      // screen that is off — but it says so, and its boxes are
                      // dead, because ticking one would promise access the server
                      // is going to refuse.
                      const over = sc.min && !atLeast(user.role, sc.min)
                      return (
                        <tr key={sc.key} className={over ? 'overrole' : undefined}>
                          <td>
                            <button className="link" disabled={over}
                              onClick={() => row(sc.key)}
                              title={over ? '' : 'Everything on this screen'}>{sc.label}</button>
                            {over && <span className="small"> · needs {ROLE_LABEL[sc.min]}</span>}
                          </td>
                          {acts.map((a) => (
                            <td key={a.key} className="num">
                              <input type="checkbox" disabled={over}
                                checked={has(sc.key, a.key)}
                                onChange={() => toggle(sc.key, a.key)} />
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <h4 style={{ marginTop: 18 }}>Warehouses</h4>
          <div className="small" style={{ marginBottom: 8 }}>
            <b>Nothing ticked means EVERY warehouse</b> — this account is not tied
            to a building, which is what every existing account is. Tick one or
            more and they can only work inside those: other warehouses stop
            appearing on the dashboard, in the pickers, and in every list.
            Tick exactly one and they are taken straight into it at sign-in.
          </div>
          <div className="datagrid">
            {!(cat.warehouses || []).length && (
              <span className="small" style={{ color: 'var(--text-2)' }}>
                No warehouses to allot — add them under Locations.</span>
            )}
            {(cat.warehouses || []).map((w) => (
              <label className="mcheck" key={w.id}
                title={w.active === false ? 'This warehouse is closed' : ''}>
                <input type="checkbox" checked={whs.includes(w.id)}
                  onChange={() => setWhs((v) => (v.includes(w.id)
                    ? v.filter((x) => x !== w.id) : [...v, w.id]))} />
                {w.name}{w.code ? ` · ${w.code}` : ''}
                {w.active === false && <span className="small"> (closed)</span>}
              </label>
            ))}
          </div>

          <h4 style={{ marginTop: 18 }}>Store / POS</h4>
          <div className="small" style={{ marginBottom: 8 }}>
            What this account may open in the Store. <b>User</b> sees only the
            Billing Counter and Store Reports — the other Store screens leave the
            menu and are refused if reached another way. The Store&apos;s own
            sign-in still applies underneath: its Reports need a manager or
            admin login there.
          </div>
          <div className="datagrid">
            {(cat.store_access || [
              { key: 'admin', label: 'Admin', why: 'every Store screen' },
              { key: 'user', label: 'User', why: 'Billing Counter and Store Reports only' },
            ]).map((s) => (
              <label className="mcheck" key={s.key}>
                <input type="radio" name="store-access" checked={store === s.key}
                  onChange={() => setStore(s.key)} />
                <b>{s.label}</b>&nbsp;— {s.why}
              </label>
            ))}
          </div>

          <h4 style={{ marginTop: 18 }}>Figures to withhold</h4>
          <div className="small" style={{ marginBottom: 8 }}>
            Ticked here, the figure is stripped by the server before it reaches
            this account — on every screen, not hidden by the one showing it.
          </div>
          <div className="datagrid">
            {(catalog.data_permissions || []).map((d) => (
              <label className="mcheck" key={d.key} title={d.why}>
                <input type="checkbox" checked={data.includes(d.key)}
                  onChange={() => setData((v) => (v.includes(d.key)
                    ? v.filter((x) => x !== d.key) : [...v, d.key]))} />
                {d.label}
              </label>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => { setMap({}); setData([]); setWhs([]); setStore('admin') }}
            title="Back to role-only — every screen, every warehouse and the whole Store">Clear all</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : 'Save access'}</button>
        </div>
      </div>
    </div>
  )
}

function Users({ toast, me }) {
  const [rows, setRows] = useState([])
  const [roles, setRoles] = useState([])
  const [catalog, setCatalog] = useState({ actions: [], screens: [], data_permissions: [] })
  const [access, setAccess] = useState(null)     // the account whose grid is open
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState('')
  const blank = { username: '', password: '', role: 'user', full_name: '' }
  const [form, setForm] = useState(blank)

  const load = useCallback(() => {
    setBusy(true)
    return api.listUsers()
      .then((r) => {
        setRows(r.users || []); setRoles(r.roles || []); setErr('')
        if (r.catalog) setCatalog(r.catalog)
      })
      .catch((e) => setErr(e.detail || 'Could not load the user list'))
      .finally(() => setBusy(false))
  }, [])
  useEffect(() => { load() }, [load])

  const add = async (e) => {
    e.preventDefault()
    if (!form.username.trim() || !form.password) { toast('Username and password are both needed', 'err'); return }
    try {
      await api.createUser({ ...form, username: form.username.trim() })
      setForm(blank); load(); toast(`✓ ${form.username.trim()} can now sign in`, 'ok')
    } catch (e2) { toast(e2.detail || 'Could not create that account', 'err') }
  }

  const patch = async (u, body, note) => {
    try { await api.updateUser(u.id, body); await load(); if (note) toast(note, 'ok') }
    catch (e) { toast(e.detail || 'Could not save that change', 'err') }
  }

  // The one field on an account that is neither identity nor a permission, and
  // the one thing that was previously impossible to correct: somebody added as
  // "sharu" with no full name, or spelt wrong on the day. The username is left
  // alone deliberately — it is what tokens, ledger notes and "recorded by" lines
  // already carry, and renaming it would orphan every one of them.
  const rename = async (u) => {
    const name = window.prompt(`Full name for ${u.username}:`, u.full_name || '')
    if (name === null) return
    patch(u, { full_name: name.trim() },
      `✓ ${u.username} is ${name.trim() || 'unnamed'}`)
  }

  const reset = async (u) => {
    // window.prompt rather than a field on the row: a reset is rare, and a
    // password box sitting open on every row is a shoulder-surfing invitation
    // for the ninety-nine percent of the time nobody is resetting anything.
    const pw = window.prompt(`New password for ${u.username}.\n\nThey are signed out of every device as soon as this is set.`)
    if (!pw) return
    try { await api.resetUserPassword(u.id, pw); toast(`✓ Password reset for ${u.username}`, 'ok') }
    catch (e) { toast(e.detail || 'Could not reset it', 'err') }
  }

  const remove = async (u) => {
    if (!window.confirm(`Delete ${u.username}?\n\nDeactivating instead keeps the record of what they did and can be undone. Deleting cannot.`)) return
    try { await api.deleteUser(u.id); await load(); toast(`✓ ${u.username} deleted`, 'ok') }
    catch (e) { toast(e.detail || 'Could not delete that account', 'err') }
  }

  const isMe = (u) => u.username === me
  const when = (iso) => fmtDate(iso)

  return (
    <div className="screen scrolls">
      {/* this screen used to open with its own heading inside its own card, at
          its own 18px indent — so it was the one module whose title did not
          start where every other module's title starts. It wears the same band
          as the rest now, and the card below it holds the page's gutter. */}
      <div className="pagehead">
        <h2>👤 Users &amp; Access</h2>
        <div className="pagesub small">
          Who can sign in, and what each account is allowed to open
        </div>
      </div>
      <div className="screenbody">
      {/* the app's own panel, not a hand-rolled one — this card used to carry a
          12px radius and 20px of padding against the 14/16 every other panel in
          the app uses, so it read as a slightly different object */}
      <div className="section" style={{ maxWidth: 1080 }}>

        <div className="small" style={{ color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.7 }}>
          Everyone signs in with their own account, on the desktop app and on the phone —
          the same account works on both. Four levels, each holding everything below it:
          <div style={{ marginTop: 8 }}>{Object.keys(ROLE_HELP).map((r) => (
            <div key={r} style={{ display: 'flex', gap: 10, marginTop: 5 }}>
              <span className={'badge role-' + r} style={{ flex: '0 0 92px' }}>{ROLE_LABEL[r]}</span>
              <span style={{ flex: 1 }}>{ROLE_HELP[r]}</span>
            </div>
          ))}</div>
        </div>

        {err && <div className="empty" style={{ margin: '10px 0' }}>{err}</div>}
        {busy && !rows.length && <div className="empty" style={{ margin: '10px 0' }}>Loading…</div>}

        {rows.length > 0 && (
          <div className="tablewrap">
            <table className="items">
              <thead><tr>
                <th>Username</th><th>Name</th><th style={{ width: 150 }}>Role</th>
                <th style={{ width: 100 }}>Last signed in</th><th style={{ width: 90 }}>Added</th>
                <th style={{ width: 200 }}></th>
              </tr></thead>
              <tbody>{rows.map((u) => (
                <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}>
                  <td><b>{u.username}</b>{isMe(u) && <span className="small" style={{ color: 'var(--text-2)' }}> · you</span>}</td>
                  <td className="small">{u.full_name || '—'}</td>
                  <td>
                    {/* Your own row shows the role but cannot change it — the
                        account you are signed in as is the one holding the door
                        open, and the server refuses this too. */}
                    {/* A row this account may not change — its own, or one that
                        outranks it — shows the role and no control. The server
                        refuses either way; what this avoids is offering a super
                        admin a dropdown on the Super Boss that answers 403. */}
                    {isMe(u) || u.manageable === false ? (
                      <span className={'badge role-' + u.role}
                        title={isMe(u) ? ROLE_HELP[u.role]
                          : `Only a ${u.role_label} can change a ${u.role_label} account`}>
                        {u.role_label}</span>
                    ) : (
                      <select className="sel" value={u.role} title={ROLE_HELP[u.role]}
                        onChange={(e) => patch(u, { role: e.target.value }, `✓ ${u.username} is now ${ROLE_LABEL[e.target.value]}`)}>
                        {/* the roles THIS account may hand out — the server sends
                            only those, and adds Super Boss while the seat is empty */}
                        {(roles.some((r) => r.value === u.role) ? roles
                          : [{ value: u.role, label: u.role_label }, ...roles])
                          .map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    )}
                    {u.permissions?.store === 'user' && (
                      <div style={{ marginTop: 4 }}>
                        <span className="badge" title="Store access: Billing Counter and Store Reports only — change it under Access">
                          Store · User</span>
                      </div>
                    )}
                  </td>
                  <td className="small">{u.last_login_at ? when(u.last_login_at) : <span title="This account has never been used">never</span>}</td>
                  <td className="small">{when(u.created_at)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {u.manageable === false ? (
                      <span className="small" style={{ color: 'var(--text-2)' }}>
                        only a {u.role_label} can change this account</span>
                    ) : <>
                      <button className="btn" style={{ padding: '2px 8px', marginRight: 5 }}
                        onClick={() => rename(u)}
                        title="Change the name shown against this account">Edit name</button>
                      {!isMe(u) && (
                        <button className="btn" style={{ padding: '2px 8px', marginRight: 5 }}
                          onClick={() => setAccess(u)}
                          title="Choose screen by screen what this account may view, create, modify, delete and print">
                          Access{u.permissions?.screens
                            ? ` · ${Object.keys(u.permissions.screens).length}` : ''}</button>
                      )}
                      <button className="btn" style={{ padding: '2px 8px', marginRight: 5 }}
                        onClick={() => reset(u)} title="Set a new password and sign them out everywhere">Reset password</button>
                      {!isMe(u) && <>
                        <button className="btn" style={{ padding: '2px 8px', marginRight: 5 }}
                          onClick={() => patch(u, { active: !u.active }, u.active ? `${u.username} can no longer sign in` : `✓ ${u.username} can sign in again`)}
                          title={u.active ? 'Stop this account signing in — reversible' : 'Let this account sign in again'}>
                          {u.active ? 'Deactivate' : 'Reactivate'}</button>
                        <button className="btn" style={{ padding: '2px 8px' }} onClick={() => remove(u)} title="Delete permanently">×</button>
                      </>}
                    </>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}

        <form onSubmit={add} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
          <div className="field" style={{ minWidth: 150 }}><label>Username</label>
            <input value={form.username} autoComplete="off"
              onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="e.g. sharu" /></div>
          <div className="field" style={{ minWidth: 170 }}><label>Full name</label>
            <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              placeholder="e.g. Sharu Kumar" /></div>
          <div className="field" style={{ minWidth: 160 }}><label>Password</label>
            <input type="password" value={form.password} autoComplete="new-password"
              onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="at least 6 characters" /></div>
          <div className="field" style={{ minWidth: 140 }}><label>Role</label>
            <select className="sel" value={form.role} title={ROLE_HELP[form.role]}
              onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {(roles.length ? roles : [{ value: 'user', label: 'User' }]).map((r) =>
                <option key={r.value} value={r.value}>{r.label}</option>)}
            </select></div>
          <button className="btn primary" type="submit">Add user</button>
        </form>
        <div className="small" style={{ color: 'var(--text-2)', marginTop: 8 }}>{ROLE_HELP[form.role]}</div>
      </div>
      </div>

      {access && (
        <AccessEditor user={access} catalog={catalog} toast={toast}
          onSave={load} onClose={() => setAccess(null)} />
      )}
    </div>
  )
}

// The one account action everybody has, whatever their role.
function ChangePassword({ onClose, toast }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (e) => {
    e.preventDefault()
    if (next !== again) { toast('The two new passwords do not match', 'err'); return }
    setBusy(true)
    try {
      const r = await api.changePassword(cur, next)
      // The change rotated the signing seed, so the token this tab is holding
      // is already dead — swap in the fresh one rather than dropping the user
      // at the login screen for having done as they were asked.
      if (r.token) session.set(r.token)
      toast('✓ Password changed', 'ok'); onClose()
    } catch (e2) { toast(e2.detail || 'Could not change it', 'err'); setBusy(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(11,61,46,.4)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: 380, maxWidth: 'calc(100vw - 32px)', background: 'var(--panel)', border: '1px solid var(--line)',
        borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-3)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Change password</h2>
          <div style={{ flex: 1 }} />
          <button className="btn" style={{ padding: '2px 9px' }} onClick={onClose}>×</button>
        </div>
        <form onSubmit={save}>
          <div className="field"><label>Current password</label>
            <input type="password" value={cur} autoComplete="current-password"
              onChange={(e) => setCur(e.target.value)} autoFocus /></div>
          <div className="field"><label>New password</label>
            <input type="password" value={next} autoComplete="new-password"
              onChange={(e) => setNext(e.target.value)} placeholder="at least 6 characters" /></div>
          <div className="field"><label>New password again</label>
            <input type="password" value={again} autoComplete="new-password"
              onChange={(e) => setAgain(e.target.value)} /></div>
          <div className="small" style={{ color: 'var(--text-2)', margin: '10px 0' }}>
            Your other devices — including the phone app — are signed out when this is saved.
          </div>
          <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Saving…' : 'Change password'}</button>
        </form>
      </div>
    </div>
  )
}

// ==========================================================================
//  Roles
//  ------------------------------------------------------------------------
//  Three ranked roles, matching backend/app/services/users.py. Everything is
//  compared by RANK rather than by equality — `rank >= admin` rather than
//  `role === 'admin'` — because the super admin is an admin who can also do
//  more, and equality tests quietly lock the top role out of the middle one's
//  screens. That bug is invisible until the one person who has the top role
//  tries to use the app.
//
//  This gating is a courtesy, not the enforcement. A screen hidden here is
//  still refused by the server (see backend/app/security.py) if it is reached
//  another way — the point of hiding it is that the floor is not shown twelve
//  buttons that answer "not for you".
// ==========================================================================
//  Locations — warehouse → store → POS terminal
//  ------------------------------------------------------------------------
//  Where this company trades from. Until now "where" was a NAME: a dispatch
//  names its destination as free text, and the list somebody was supposed to
//  maintain was a fixed dropdown holding one value, "NONE", that the API
//  refused additions to — so there was no way to add a branch at all.
//
//  Drawn as the tree it is rather than as three lists, because the question
//  people actually have is "what does this warehouse supply" and three tabs
//  make that an exercise in cross-referencing. A store carries its tills
//  inline for the same reason.
//
//  Closing beats deleting throughout, and the server enforces it: a branch
//  that has taken deliveries has last year's transfers filed against it BY
//  NAME, so removing the row would orphan them silently.
// ==========================================================================
//  The address as one line, in the order it is written on an envelope. Built
//  from the parts rather than stored that way, because the state has to be a
//  column of its own — it decides whether a sale is inter-state — and a row
//  that showed only line 1 would say a place has no city.
function locWhere(node) {
  const parts = [node.address, node.address2, node.city, node.district,
    node.state, node.pincode, node.country]
    .map((s) => (s || '').trim()).filter(Boolean)
  // "Coimbatore, Coimbatore" is what a district that shares its city's name
  // prints as, and around here most of them do. Both are still stored — a GST
  // address needs the district in its own right — but a line that says it
  // twice reads as a mistake in the data.
  return parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1].toLowerCase())
    .join(', ')
}

function LocationRow({ node, kind, onEdit, onAdd, onAddAlt, onToggle, onDelete, deleteHint, children }) {
  const dim = node.active === false
  const where = locWhere(node)
  return (
    <div className={'locnode loc-' + kind + (dim ? ' off' : '')}>
      <div className="locbar">
        <span className="locico" aria-hidden="true">
          {kind === 'warehouse' ? '🏢' : kind === 'store' ? '🏬'
            : kind === 'floor' ? '🪜' : '🖥'}</span>
        <span className="locname">{node.name}</span>
        {node.code && <span className="loccode">{node.code}</span>}
        {/* The bill prefix, on the row. It is the only thing a floor decides,
            and it is what somebody opens this screen to check — a till left on
            the wrong storey is discoverable only if the series it prints is
            visible beside it. Shown on the till too, read through from its
            floor, because that is the row people actually look at. */}
        {kind === 'floor' && (node.prefix
          ? <span className="badge gstbadge" title="Bills from this floor start with this">
              {node.prefix}…</span>
          : <span className="badge review" title="Without a prefix this floor's tills bill on the shop's plain series">
              no bill prefix</span>)}
        {kind === 'terminal' && node.bill_prefix && (
          <span className="badge" title={`Bills read ${node.bill_prefix}26-001 — from ${node.floor_name}`}>
            {node.bill_prefix}…</span>
        )}
        {/* What this building trades in. On the row rather than only in the
            editor, because "which of these is the silk warehouse" is the
            question this screen is opened to answer once there is more than one
            line. */}
        {kind === 'warehouse' && node.catalogue && (
          <span className="badge" title="Business line — its categories and attributes">
            {node.catalogue}</span>
        )}
        {/* Deliberately its own badge and not the catalogue's — a franchise
            store still trades in one of the real lines. */}
        {node.loc_type && (
          <span className="badge loctype" title="Type of place">{node.loc_type}</span>
        )}
        {/* A registered place shows that it is one. Its number is on the form;
            what belongs on a list is which places have one at all, because that
            is what decides where a bill can be raised. */}
        {node.gstin && (
          <span className="badge gstbadge" title={'GSTIN ' + node.gstin}>GST</span>
        )}
        {dim && <span className="badge review">closed</span>}
        {where && <span className="small locaddr" title={where}>{where}</span>}
        <span className="spacer" />
        {onAdd && <button className="btn" onClick={onAdd}>{
          kind === 'warehouse' ? '+ Store' : kind === 'store' ? '+ Floor' : '+ POS'}</button>}
        {/* A store offers both, because a shop with no floors still has tills
            and must not be made to invent a storey before it can add one. */}
        {onAddAlt && <button className="btn" onClick={onAddAlt}>+ POS</button>}
        {onEdit && <button className="iconbtn" title="Rename or edit" onClick={onEdit}>✎</button>}
        {onToggle && <button className="iconbtn"
          title={dim ? 'Reopen this' : 'Close it — its history stays readable'}
          onClick={onToggle}>{dim ? '↺' : '⊘'}</button>}
        {onDelete && <button className="iconbtn danger"
          title={deleteHint || 'Delete — only possible while nothing is filed under it'}
          onClick={onDelete}>×</button>}
        {/* Not deletable, but with a reason to give: the cross stays in place
            greyed out rather than disappearing, so the row does not look like it
            is missing a control and nobody goes hunting for one. Rows that are
            merely blocked by their children pass no hint and keep the old
            behaviour of showing nothing at all. */}
        {!onDelete && deleteHint && (
          <button className="iconbtn" disabled title={deleteHint}
            style={{ opacity: .35, cursor: 'not-allowed' }}>×</button>
        )}
      </div>
      {children}
    </div>
  )
}

//  The editor
//  ------------------------------------------------------------------------
//  ONE form for all three levels, not three. The field set is identical
//  because the thing that needs it is a document and all three print one —
//  see models.LocationProfile. Three near-copies would drift, and the field
//  that went missing would be missing on exactly one level, which is the
//  hardest kind of gap to notice.
//
//  Seventeen fields is a lot to meet at once, so they arrive in the order the
//  question is actually answered: what is it and whose, where is it, who do I
//  ring, what is it registered as, is it open. The rules between those groups
//  are doing real work — an undifferentiated grid of seventeen boxes reads as
//  a form to endure rather than one to fill in.
const LOC_LABEL = { warehouse: 'Warehouse', store: 'Store / Shop', floor: 'Floor',
  terminal: 'POS / Counter' }
//  Written out rather than lower-cased from the badge above, because POS is an
//  abbreviation and "New pos / counter" reads as a typo.
const LOC_TITLE = { warehouse: 'warehouse', store: 'store / shop', terminal: 'POS / counter' }

//  What the server will refuse, said here first. Duplicated deliberately: the
//  server check is the one that counts (see routers/locations._apply_profile)
//  and stays whatever this does, but finding out a GSTIN is a character short
//  after pressing Create means re-reading a form you thought you had finished.
function locProblems(f) {
  const out = {}
  const g = (f.gstin || '').trim().toUpperCase()
  if (g && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(g))
    out.gstin = 'A GST number is 15 characters, like 33AADCE6591N1Z7'
  const p = (f.pincode || '').trim()
  if (p && !/^\d{6}$/.test(p)) out.pincode = 'A PIN code is 6 digits'
  const e = (f.email || '').trim()
  if (e && !e.includes('@')) out.email = 'That is not an email address'
  if (!(f.name || '').trim()) out.name = 'required'
  return out
}

function LocField({ label, hint, error, wide, children }) {
  return (
    <div className={'field' + (wide ? ' wide' : '') + (error ? ' flag' : '')}>
      <label>{label}</label>
      {children}
      {error && <div className="flagnote">{error}</div>}
      {!error && hint && <div className="hint">{hint}</div>}
    </div>
  )
}

//  A floor gets its OWN small editor rather than a fourth mode of the form
//  below, and for the same reason that form has three modes: the field set. The
//  other three levels share one because they all print a document and all need
//  the same address and GSTIN block (see models.LocationProfile). A floor prints
//  nothing. What it has is a name, an order and a bill prefix — four boxes —
//  and putting those through a seventeen-field form would mean hiding most of
//  it and asking for an address nobody could answer.
function FloorEditor({ init, stores, onSave, onClose }) {
  const [f, setF] = useState(() => ({
    name: init?.name || '',
    prefix: init?.prefix || '',
    sort_order: init?.sort_order ?? 0,
    active: init?.active !== false,
    store_id: init?.store_id || stores?.[0]?.id || null,
  }))
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }))
  const prefix = (f.prefix || '').trim().toUpperCase()
  const bad = {}
  if (!(f.name || '').trim()) bad.name = 'required'
  // Refused here as well as on the server, because finding out after pressing
  // Create means re-reading a form you thought you had finished.
  if (prefix && !/^[A-Z0-9]{1,8}$/.test(prefix))
    bad.prefix = 'Letters and digits only, up to 8 — it is the front of a bill number'
  const blocked = Object.keys(bad).length > 0
  const year = String(new Date().getFullYear() % 100)

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal locmodal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{`${init?.id ? 'Edit' : 'New'} floor`}</b>
          <span className="badge">Floor</span>
          <button className="modal-x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="formsec">
            <h5>Identity</h5>
            <div className="mgrid">
              <LocField label="Name" error={bad.name === 'required' ? null : bad.name}>
                <input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)}
                  placeholder="e.g. Ground Floor" />
              </LocField>
              <LocField label="At store">
                <select value={f.store_id || ''} onChange={(e) => set('store_id', +e.target.value)}>
                  {(stores || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </LocField>
              <LocField label="Bill prefix" error={bad.prefix}
                hint={prefix
                  ? `Bills from this floor will read ${prefix}${year}-001`
                  : 'Left blank, its tills bill on the shop’s plain INV- series'}>
                <input value={f.prefix} style={{ textTransform: 'uppercase' }}
                  maxLength={8} onChange={(e) => set('prefix', e.target.value)}
                  placeholder="TG" />
              </LocField>
              <LocField label="Order"
                hint="Ground floor first — F sorts before G, so the list needs telling">
                <input type="number" value={f.sort_order}
                  onChange={(e) => set('sort_order', +e.target.value || 0)} />
              </LocField>
            </div>
          </div>
          <div className="formsec">
            <h5>Status</h5>
            <label className="chk">
              <input type="checkbox" checked={!!f.active}
                onChange={(e) => set('active', e.target.checked)} />
              <span>Open — offered at the till and on this screen</span>
            </label>
            <div className="hint" style={{ marginTop: 6 }}>
              Closing a floor stops it being offered. Bills already numbered from
              it keep their numbers — each carries the prefix it was raised under,
              so the register stays readable whatever happens here.
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn primary" disabled={blocked}
            onClick={() => onSave({ ...f, prefix })}>
            {init?.id ? 'Save' : 'Create'}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          {blocked && !bad.name && <span className="small" style={{ color: 'var(--warn)' }}>
            Fix the highlighted field to save</span>}
        </div>
      </div>
    </div>
  )
}

function LocationEditor({ init, kind, stores, floors, warehouses, catalogues, options, onSave, onClose }) {
  const [f, setF] = useState(() => ({
    name: init?.name || '', code: init?.code || '',
    // Which storey a till stands on. Blank means it is on none, which is a real
    // answer and the one every till has until somebody places it.
    floor_id: init?.floor_id || '',
    loc_type: init?.loc_type || '',
    address: init?.address || '', address2: init?.address2 || '',
    city: init?.city || '', district: init?.district || '',
    state: init?.state || '',
    // A new place is in India until somebody says otherwise; an existing one is
    // left exactly as it was, blank included, because filling a blank column on
    // open would save a value nobody typed.
    country: init?.country || (init?.id ? '' : 'India'),
    pincode: init?.pincode || '',
    contact_person: init?.contact_person || '', phone: init?.phone || '',
    email: init?.email || '', gstin: init?.gstin || '', cin: init?.cin || '',
    active: init?.active !== false,
    // Blank means "the same company as the thing above it", which is what the
    // server does with it. Offered as a real choice rather than pre-filled,
    // because pre-filling would make every branch look deliberately assigned.
    business_id: init?.business_id || '',
    warehouse_id: init?.warehouse_id || warehouses?.[0]?.id || null,
    store_id: init?.store_id || stores?.[0]?.id || null,
    catalogue_id: init?.catalogue_id
      || (catalogues || []).find((c) => c.is_default)?.id
      || catalogues?.[0]?.id || null,
  }))
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }))
  const label = LOC_LABEL[kind] || 'Location'
  const bad = locProblems(f)
  const blocked = Object.keys(bad).length > 0

  // The GST state code is not asked for — it IS the first two digits of the
  // GSTIN, and two fields that must agree, both typed by hand, disagree
  // eventually. Shown as it is derived so nobody goes looking for the box.
  const gst = (f.gstin || '').trim().toUpperCase()
  const stateCode = /^\d{2}/.test(gst) ? gst.slice(0, 2) : null

  // The storeys of the store this till is being put at, and the one chosen.
  // Narrowed here rather than offering every floor in the company, because the
  // server refuses a floor of another building and a picker that offers one is
  // the only thing standing between a manager and that error.
  const storeFloors = (floors || []).filter(
    (x) => String(x.store_id) === String(f.store_id) && x.active !== false)
  const tillFloor = storeFloors.find((x) => String(x.id) === String(f.floor_id))

  const businesses = (options?.businesses || [])
  const types = options?.types || ['Garments', 'Silks', 'Franchise']
  const inherits = kind === 'warehouse' ? 'the default company'
    : kind === 'store' ? 'the supplying warehouse’s company' : 'the store’s company'

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal locmodal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{`${init?.id ? 'Edit' : 'New'} ${LOC_TITLE[kind] || 'location'}`}</b>
          <span className="badge">{label}</span>
          {init?.code && <span className="loccode">{init.code}</span>}
          <button className="modal-x" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* ---- 1. what it is, and whose ---- */}
          <div className="formsec">
            <h5>Identity</h5>
            <div className="mgrid">
              <LocField label="Name" error={bad.name === 'required' ? null : bad.name}>
                <input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)}
                  placeholder={kind === 'warehouse' ? 'e.g. Warehouse 1'
                    : kind === 'store' ? 'e.g. TAQUA SILKS, TIRUPUR' : 'e.g. Main Counter'} />
              </LocField>
              {/* The placeholder used to be a real code — WH-01, ST-01, POS-01
                  — which reads as a suggestion, gets typed in, and collides with
                  whatever already holds it. Codes are unique across every level,
                  so the only safe suggestion is none: this says what happens if
                  you leave it alone, and the server names the holder if you
                  pick one that is taken. */}
              <LocField label="Code"
                hint={init?.id ? 'Unique across every ' + (LOC_TITLE[kind] || 'place')
                               : 'Leave blank and one is issued for you'}>
                <input value={f.code} onChange={(e) => set('code', e.target.value)}
                  placeholder="issued automatically" />
              </LocField>
              <LocField label="Type">
                <select value={f.loc_type} onChange={(e) => set('loc_type', e.target.value)}>
                  <option value="">— not set —</option>
                  {types.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </LocField>
              <LocField label="Business" hint={`Blank uses ${inherits}`}>
                <select value={f.business_id} onChange={(e) => set('business_id', e.target.value)}>
                  <option value="">— {inherits} —</option>
                  {businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}{b.code ? ` · ${b.code}` : ''}</option>
                  ))}
                </select>
              </LocField>

              {kind === 'warehouse' && (
                <LocField label="Trades in" hint="Decides its categories and attributes">
                  <select value={f.catalogue_id || ''}
                    onChange={(e) => set('catalogue_id', +e.target.value)}>
                    {(catalogues || []).filter((c) => c.active !== false || c.id === init?.catalogue_id)
                      .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </LocField>
              )}
              {kind === 'store' && (
                <LocField label="Supplied by">
                  <select value={f.warehouse_id || ''} onChange={(e) => set('warehouse_id', +e.target.value)}>
                    {(warehouses || []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </LocField>
              )}
              {kind === 'terminal' && (
                <LocField label="At store">
                  <select value={f.store_id || ''} onChange={(e) => {
                    // Moving a till to another building drops the storey with
                    // it — a floor belongs to one store, and keeping the old id
                    // would offer a pairing the server refuses.
                    set('store_id', +e.target.value); set('floor_id', '')
                  }}>
                    {(stores || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </LocField>
              )}
              {kind === 'terminal' && (
                <LocField label="On floor"
                  hint={tillFloor
                    ? `Bills from this till will read ${tillFloor.prefix || 'INV'}${String(new Date().getFullYear() % 100)}-001`
                    : 'Not on a floor — it bills on the shop’s plain INV- series'}>
                  <select value={f.floor_id || ''} onChange={(e) => set('floor_id', e.target.value)}>
                    <option value="">— not on a floor —</option>
                    {storeFloors.map((fl) => (
                      <option key={fl.id} value={fl.id}>
                        {fl.name}{fl.prefix ? ` — ${fl.prefix}…` : ''}</option>
                    ))}
                  </select>
                </LocField>
              )}
            </div>
          </div>

          {/* ---- 2. where it is ---- */}
          <div className="formsec">
            <h5>Address <span className="small">as it should print on a document</span></h5>
            <div className="mgrid">
              <LocField label="Address line 1" wide>
                <input value={f.address} onChange={(e) => set('address', e.target.value)}
                  placeholder="Door / building / street" />
              </LocField>
              <LocField label="Address line 2" wide>
                <input value={f.address2} onChange={(e) => set('address2', e.target.value)}
                  placeholder="Area / landmark" />
              </LocField>
              <LocField label="City">
                <input value={f.city} onChange={(e) => set('city', e.target.value)} />
              </LocField>
              <LocField label="District">
                <input value={f.district} onChange={(e) => set('district', e.target.value)} />
              </LocField>
              <LocField label="ZIP / PIN code" error={bad.pincode}>
                <input value={f.pincode} onChange={(e) => set('pincode', e.target.value)}
                  inputMode="numeric" maxLength={6} placeholder="641604" />
              </LocField>
              <LocField label="State"
                hint={stateCode ? `GST state code ${stateCode}` : null}>
                <input value={f.state} onChange={(e) => set('state', e.target.value)}
                  placeholder="Tamil Nadu" />
              </LocField>
              <LocField label="Country">
                <input value={f.country} onChange={(e) => set('country', e.target.value)} />
              </LocField>
            </div>
          </div>

          {/* ---- 3. who to ring ---- */}
          <div className="formsec">
            <h5>Contact</h5>
            <div className="mgrid">
              <LocField label="Contact person">
                <input value={f.contact_person} onChange={(e) => set('contact_person', e.target.value)} />
              </LocField>
              <LocField label={kind === 'warehouse' ? 'Contact number' : 'Store contact number'}>
                <input value={f.phone} onChange={(e) => set('phone', e.target.value)}
                  inputMode="tel" placeholder="+91 …" />
              </LocField>
              <LocField label="Email ID" error={bad.email}>
                <input value={f.email} onChange={(e) => set('email', e.target.value)}
                  inputMode="email" />
              </LocField>
            </div>
          </div>

          {/* ---- 4. what it is registered as ---- */}
          <div className="formsec">
            <h5>Statutory</h5>
            <div className="mgrid">
              <LocField label="GST number" error={bad.gstin}
                hint={stateCode ? `State code ${stateCode}, taken from these first two digits`
                  : 'Its first two digits set the GST state code'}>
                <input value={f.gstin} style={{ textTransform: 'uppercase' }}
                  onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                  maxLength={15} placeholder="33AADCE6591N1Z7" />
              </LocField>
              <LocField label="CIN" hint="The MCA registration, if this place has its own">
                <input value={f.cin} style={{ textTransform: 'uppercase' }}
                  onChange={(e) => set('cin', e.target.value.toUpperCase())}
                  placeholder="U17111TZ2011PTC017…" />
              </LocField>
            </div>
          </div>

          {/* ---- 5. open or closed ---- */}
          <div className="formsec">
            <h5>Status</h5>
            <div className="segbar">
              <button type="button" className={'seg' + (f.active ? ' on' : '')}
                onClick={() => set('active', true)}>● Active</button>
              <button type="button" className={'seg' + (!f.active ? ' on' : '')}
                onClick={() => set('active', false)}>○ Inactive</button>
            </div>
            <div className="hint" style={{ marginTop: 'var(--sp-2)' }}>
              {f.active
                ? 'Offered wherever a place is chosen — as a destination, on a GRN, in the shop.'
                : 'Closed: kept on the record with all its history, and no longer offered anywhere.'}
            </div>
          </div>

          {kind === 'warehouse' && (
            <div className="infobox" style={{ marginTop: 'var(--sp-4)' }}>
              <b>Trades in</b> is the business line — it decides which categories this
              warehouse’s GRN offers and which attributes its items carry, so a silk
              warehouse is never asked a garment’s sleeve length. Edit the lines under
              <b> Masters → Catalogues</b>. A warehouse already holding stock cannot be
              moved to another line. <b>Type</b> is separate and only describes the
              place, so a franchise still trades in one of the real lines.
            </div>
          )}
          {kind === 'store' && (
            <div className="infobox" style={{ marginTop: 'var(--sp-4)' }}>
              Store names are unique across the company and are how the retail shop
              recognises a branch. Renaming one here does not rename it there.
            </div>
          )}
          {kind === 'terminal' && (
            <div className="infobox" style={{ marginTop: 'var(--sp-4)' }}>
              A counter carries its own address and GSTIN because it <b>prints</b> — a
              counter run under a franchise agreement bills under a different number
              from the store it stands in. Leave them blank and its bills use the
              store’s, which is the ordinary case.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn primary" disabled={blocked}
            onClick={() => onSave(f)}>{init?.id ? 'Save' : 'Create'}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          {blocked && !bad.name && <span className="small" style={{ color: 'var(--warn)' }}>
            Fix the highlighted field to save</span>}
        </div>
      </div>
    </div>
  )
}

function Locations({ toast }) {
  const [tree, setTree] = useState(null)
  const [err, setErr] = useState(null)
  const [edit, setEdit] = useState(null)     // {kind, init}
  const [catalogues, setCatalogues] = useState([])
  const [options, setOptions] = useState(null)

  const load = useCallback(() => api.locationTree()
    .then((r) => { setTree(r.warehouses || []); setErr(null) })
    .catch((e) => setErr(e.status === 404 ? 'restart' : (e.detail || e.message))), [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.listCatalogues().then((r) => setCatalogues(r.catalogues || [])).catch(() => {})
    // Swallowed on purpose: the form falls back to the three type words it
    // ships with and an empty company list, which is a form that still saves.
    // Losing the whole screen because a lookup 404'd on an older server would
    // be the worse failure.
    api.locationFormOptions().then(setOptions).catch(() => {})
  }, [])

  const warehouses = (tree || []).filter((w) => !w.unassigned)
  const allStores = (tree || []).flatMap((w) => w.stores || [])
  // Flattened for the till editor's floor picker, which narrows to the store
  // being chosen — a till can only stand on a floor of its own building.
  const allFloors = allStores.flatMap((s) => s.floors || [])

  const run = async (fn, ok) => {
    try { const r = await fn(); await load(); toast(r?.warning || ok, r?.warning ? 'warn' : 'ok'); setEdit(null) }
    catch (e) { toast(e.detail || e.message, 'err') }
  }

  // Every text field is sent as a STRING, empty ones included, never dropped.
  // The server reads `null` as "not mentioned, leave the column alone" — which
  // is what lets the close-a-branch button PATCH {name, active} without wiping
  // an address — so omitting a field the person deliberately cleared would
  // silently refuse to clear it.
  const TEXT = ['loc_type', 'address', 'address2', 'city', 'district', 'state',
    'country', 'pincode', 'contact_person', 'phone', 'email', 'gstin', 'cin']

  // Which API each level uses, in one place. A chain of ternaries with a
  // fallback meant every new level silently defaulted to the terminal's
  // endpoints — a floor would have been PATCHed as a till.
  const API = {
    warehouse: { create: api.createWarehouse, update: api.updateWarehouse, remove: api.deleteWarehouse },
    store: { create: api.createStore, update: api.updateStore, remove: api.deleteStore },
    floor: { create: api.createFloor, update: api.updateFloor, remove: api.deleteFloor },
    terminal: { create: api.createTerminal, update: api.updateTerminal, remove: api.deleteTerminal },
  }

  const save = (kind, init, f) => {
    // A floor carries none of the address block — it prints no document. See
    // FloorEditor.
    if (kind === 'floor') {
      const body = {
        name: f.name.trim(), prefix: (f.prefix || '').trim().toUpperCase() || '',
        sort_order: f.sort_order || 0, active: !!f.active, store_id: f.store_id,
      }
      return init?.id ? run(() => API.floor.update(init.id, body), 'Saved')
                      : run(() => API.floor.create(body), 'Created')
    }
    const body = { name: f.name.trim(), code: f.code.trim() || null, active: !!f.active }
    for (const k of TEXT) body[k] = (f[k] ?? '').trim()
    // 0, not null, for "no company of its own — inherit". null would mean "not
    // mentioned" and would make the blank option unable to clear a business
    // that had already been set.
    body.business_id = f.business_id ? +f.business_id : 0
    if (kind === 'warehouse') body.catalogue_id = f.catalogue_id
    if (kind === 'store') body.warehouse_id = f.warehouse_id
    if (kind === 'terminal') {
      body.store_id = f.store_id
      // 0 for "take it off its floor", never null — null means "not mentioned"
      // to the server, so the blank option could not unplace a till.
      body.floor_id = f.floor_id ? +f.floor_id : 0
    }
    if (init?.id) return run(() => API[kind].update(init.id, body), 'Saved')
    return run(() => API[kind].create(body), 'Created')
  }

  const toggle = (kind, node) =>
    run(() => API[kind].update(node.id, { name: node.name, active: node.active === false }),
      node.active === false ? 'Reopened' : 'Closed')

  const remove = (kind, node) => {
    if (!window.confirm(`Delete “${node.name}”? This is only possible while nothing is filed under it — otherwise close it instead.`)) return
    return run(() => API[kind].remove(node.id), 'Deleted')
  }

  if (err === 'restart') return (
    <div className="screen scrolls">
      <div className="pagehead"><h2>Locations</h2></div>
      <div className="screenbody"><div className="warnbox" style={{ maxWidth: 620 }}>
        <h4>The server needs restarting</h4>
        <div className="small" style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
          This page was loaded from disk, but <code>/api/locations</code> is registered
          when Python starts — and this server was started before Locations existed.
          Stop it (Ctrl-C in the run window), start it again with <code>run.bat</code>,
          and reload.
        </div>
      </div></div>
    </div>
  )

  return (
    <div className="screen">
      <div className="pagehead">
        <h2>Locations</h2>
        <div className="pagesub small">
          The warehouses, the stores each one supplies, the floors of each store
          and the tills standing on them
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={load}>↻ Refresh</button>
        <button className="btn primary" onClick={() => setEdit({ kind: 'warehouse' })}>
          + New warehouse</button>
      </div>
      <div className="screenbody">
        {err && <div className="warnbox" style={{ marginBottom: 14 }}>
          <h4>Locations could not be read</h4>
          <div className="small" style={{ color: 'var(--text-2)' }}>{err}</div></div>}

        <div className="infobox" style={{ marginBottom: 'var(--sp-4)' }}>
          A <b>store</b> owns stock; a <b>floor</b> and a <b>POS terminal</b> only
          record sales against it. What a floor decides is the <b>bill prefix</b>:
          a till on a floor numbers its bills from that floor's own series —
          <code> TG26-001</code> on the ground floor, <code>TF26-001</code> on the
          first — and one on no floor bills on the shop's plain <code>INV-</code>
          series. Closing a place keeps its history and stops it being offered —
          deleting is refused once anything is filed under it.
        </div>

        {tree && tree.length === 0 && (
          <div className="empty" style={{ marginTop: 50 }}>
            No warehouses yet. Add one, then the stores it supplies.</div>
        )}

        {(tree || []).map((w) => (
          <LocationRow key={w.id ?? 'orphan'} node={w} kind="warehouse"
            onAdd={w.unassigned ? null : () => setEdit({ kind: 'store', init: { warehouse_id: w.id } })}
            onEdit={w.unassigned ? null : () => setEdit({ kind: 'warehouse', init: w })}
            onToggle={w.unassigned ? null : () => toggle('warehouse', w)}
            onDelete={w.unassigned || (w.stores || []).length ? null : () => remove('warehouse', w)}>
            <div className="lockids">
              {(w.stores || []).length === 0 && (
                <div className="small locempty">No stores under this warehouse yet.</div>
              )}
              {(w.stores || []).map((s) => (
                <LocationRow key={s.id} node={s} kind="store"
                  onAdd={() => setEdit({ kind: 'floor', init: { store_id: s.id } })}
                  onAddAlt={() => setEdit({ kind: 'terminal', init: { store_id: s.id } })}
                  onEdit={() => setEdit({ kind: 'store', init: s })}
                  onToggle={() => toggle('store', s)}
                  onDelete={(s.terminals || []).length || (s.floors || []).length
                    ? null : () => remove('store', s)}>
                  <div className="lockids">
                    {(s.floors || []).length === 0 && (s.terminals || []).length === 0 && (
                      <div className="small locempty">
                        No floors or tills at this store yet. Add a floor first —
                        it is what decides the bill prefix its tills use.
                      </div>
                    )}

                    {/* A storey, and the tills standing on it. The floor row
                        carries the bill prefix because that is the only thing a
                        floor decides, and hiding it behind the editor would make
                        this screen unable to answer the question it exists for:
                        what will this counter's bills be called. */}
                    {(s.floors || []).map((fl) => (
                      <LocationRow key={'f' + fl.id} node={fl} kind="floor"
                        onAdd={() => setEdit({ kind: 'terminal',
                          init: { store_id: s.id, floor_id: fl.id } })}
                        onEdit={() => setEdit({ kind: 'floor', init: fl })}
                        onToggle={() => toggle('floor', fl)}
                        deleteHint={(fl.terminals || []).length
                          ? 'Move its tills to another floor first' : null}
                        onDelete={(fl.terminals || []).length ? null : () => remove('floor', fl)}>
                        <div className="lockids">
                          {(fl.terminals || []).length === 0 && (
                            <div className="small locempty">No tills on this floor yet.</div>
                          )}
                          {(fl.terminals || []).map((t) => (
                            <LocationRow key={t.id} node={t} kind="terminal"
                              deleteHint={t.deletable_on
                                ? `Closed on ${fmtDate(t.deactivated_at)} — can be deleted from ${fmtDate(t.deletable_on)}`
                                : 'Close this till first — it can be deleted a year after it is switched off'}
                              onEdit={() => setEdit({ kind: 'terminal', init: t })}
                              onToggle={() => toggle('terminal', t)}
                              onDelete={t.can_delete ? () => remove('terminal', t) : null} />
                          ))}
                        </div>
                      </LocationRow>
                    ))}

                    {/* Tills on no floor, at the store level where they have
                        always been. Shown as such rather than hidden or quietly
                        filed under the first floor: a shop that has never used
                        floors must not have its tills vanish the day the level
                        exists, and one that has needs to see which are unplaced
                        — those are the counters still numbering bills from the
                        shop's fallback series. */}
                    {(s.terminals || []).length > 0 && (s.floors || []).length > 0 && (
                      <div className="small locempty" style={{ marginTop: 6 }}>
                        Not on any floor — these bill on the shop's plain series
                        until they are placed:
                      </div>
                    )}
                    {(s.terminals || []).map((t) => (
                      /* A till is closed, not deleted — its number is on every
                         bill it printed, and those are read back long after it
                         stops being used. The cross appears a year after it is
                         switched off; until then the switch beside it is the
                         whole of what this screen offers, and the server
                         refuses the same thing with the date. */
                      <LocationRow key={t.id} node={t} kind="terminal"
                        deleteHint={t.deletable_on
                          ? `Closed on ${fmtDate(t.deactivated_at)} — can be deleted from ${fmtDate(t.deletable_on)}`
                          : 'Close this till first — it can be deleted a year after it is switched off'}
                        onEdit={() => setEdit({ kind: 'terminal', init: t })}
                        onToggle={() => toggle('terminal', t)}
                        onDelete={t.can_delete ? () => remove('terminal', t) : null} />
                    ))}
                  </div>
                </LocationRow>
              ))}
            </div>
          </LocationRow>
        ))}
      </div>

      {edit && edit.kind === 'floor' && (
        <FloorEditor init={edit.init} stores={allStores}
          onClose={() => setEdit(null)}
          onSave={(f) => save('floor', edit.init?.id ? edit.init : null, f)} />
      )}
      {edit && edit.kind !== 'floor' && (
        <LocationEditor kind={edit.kind} init={edit.init} warehouses={warehouses}
          stores={allStores} floors={allFloors} catalogues={catalogues} options={options}
          onClose={() => setEdit(null)}
          onSave={(f) => save(edit.kind, edit.init?.id ? edit.init : null, f)} />
      )}
    </div>
  )
}

// ==========================================================================
//  Choose a warehouse
//  ------------------------------------------------------------------------
//  The way into a building for anyone who cannot open the Central Dashboard —
//  which is admin-only, while this app is mostly used by the floor. Without
//  this screen a warehouse user signing in has no route into any warehouse at
//  all: the company menu offers them almost nothing, and the access-denied
//  panel sends them back to a screen they may not have.
//
//  It reads GET /api/locations, which the floor may already call and which the
//  server narrows to the warehouses this account is allotted. So the list IS
//  the allotment — a manager tied to one building sees exactly one card.
// ==========================================================================
function ChooseWarehouse({ onEnter, user }) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.locationTree()
      .then((t) => setRows((t.warehouses || []).filter((w) => w.id && w.active !== false)))
      .catch((e) => setErr(e.detail || e.message))
  }, [])

  return (
    <div className="screen scrolls">
      <div className="pagehead"><h2>Choose a warehouse</h2></div>
      <div className="screenbody">
        <div className="infobox" style={{ marginBottom: 'var(--sp-4)' }}>
          Every screen after this one shows <b>one warehouse's</b> work — its
          deliveries, its stock, its dispatches. Pick the building you are
          standing in.
        </div>
        {err && <div className="warnbox"><h4>Could not read the warehouses</h4>
          <div className="small" style={{ color: 'var(--text-2)' }}>{err}</div></div>}
        {rows === null && !err && <div className="empty">Loading…</div>}
        {rows && rows.length === 0 && (
          <div className="empty" style={{ marginTop: 40, lineHeight: 1.7 }}>
            <b>No warehouse is allotted to {user}.</b><br />
            Ask a super admin to tick one for you in Users &amp; Access.
          </div>
        )}
        {/* `whcard`, not a plain KPI tile: the value here is a NAME, and the
            tile's own rule keeps a figure on one line at any cost — which cut
            "Palakkad Warehouse" off at the card's edge. See styles.css. */}
        <div className="dgrid whgrid">
          {(rows || []).map((w) => (
            <button key={w.id} className="dtile whcard" style={{ textAlign: 'left' }}
              title={`Work inside ${w.name}`} onClick={() => onEnter(w)}>
              <span className="lbl">{w.code || 'Warehouse'}</span>
              <span className="val">{w.name}</span>
              <span className="sub">
                {w.catalogue ? w.catalogue + ' · ' : ''}
                {(w.stores || []).length} store(s)
              </span>
              <span className="whgo">Open <span aria-hidden="true">→</span></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ==========================================================================
//  The dashboards' reads, in one place
//  ------------------------------------------------------------------------
//  Each dashboard reads through the cache in dashcache.js, and the shell warms
//  that cache ahead of time (warmDashboards, below). Both must ask the same
//  question under the same key, or the warm-up fills a slot the screen never
//  looks in — so the key and the read are defined once, here.
//
//  `wh` is the workspace the read belongs to: null for company level (the
//  Command Center and the Central Dashboard are only ever opened outside a
//  warehouse), an id for a warehouse's own dashboard.
// ==========================================================================
function readWarehouseDash() {
  // allSettled, not all: an inventory scan that fails must not blank the six
  // figures that loaded. What is missing is said out loud instead.
  return Promise.allSettled([
    // the GRN figures, not every GRN — the full list was 17 MB on a big store
    api.purchasesSummary(), api.inventorySummary(), api.listOutwards('posted'),
    api.listOutwards('draft'), api.pendingBills(), api.listReturns(),
    // LR counts over the whole register — the list stops at 500 rows
    api.lrSummary(), api.listSuppliers(), api.notifications(), api.deadStockSummary(),
  ]).then((r) => {
    const v = (i, fb) => (r[i].status === 'fulfilled' ? r[i].value : fb)
    return {
      partial: r.some((x) => x.status === 'rejected'),
      d: {
        grns: v(0, { drafts: [], recent: [], posted: 0, short_lines: 0, short_value: 0 }),
        stock: v(1, {}), transit: v(2, []), outDrafts: v(3, []),
        bills: v(4, []), returns: v(5, []),
        lr: v(6, { total: 0, pending: 0, unlinked: 0 }), suppliers: v(7, []),
        // The same feed the bell reads. One call rather than a second pass for
        // the dead-stock tile: the notices already carry it, and two reads of
        // one queue is two chances to print two different numbers for it.
        notifs: v(8, { notices: [], counts: {} }),
        // the same read the module opens on — KPIs, age bands and the clearance
        // trend, so the section below is the module's own arithmetic and not a
        // second calculation of it that could disagree
        dead: v(9, null),
      },
    }
  })
}

const DASH = {
  command: (day, scope) => ({ key: `co|command|${day || ''}|${scope || ''}`,
    read: () => api.commandOverview(day || undefined, scope || undefined) }),
  central: (days, scope) => ({ key: `co|central|${days}|${scope || ''}`,
    read: () => api.locationOverview(days, scope) }),
  sales: (days, scope) => ({ key: `co|sales|${days}|${scope || ''}`,
    read: () => api.storeSales(days, scope) }),
  warehouse: (wh) => ({ key: `${wh || 'co'}|dash`, read: readWarehouseDash }),
  charts: (wh) => ({ key: `${wh || 'co'}|charts`, read: () => api.dashboardCharts() }),
  examples: (wh) => ({ key: `${wh || 'co'}|examples`, read: () => api.commandExamples() }),
  // The Reports screen. Its lists fail soft, the way the screen always took
  // them: no groups falls back to the built-in headings, no Store is [].
  reportCat: (wh) => ({ key: `${wh || 'co'}|repcat`, read: () => api.reportCatalogue() }),
  reportGroups: (wh) => ({ key: `${wh || 'co'}|repgroups`,
    read: () => api.reportGroups().catch(() => []) }),
  storeReports: (wh) => ({ key: `${wh || 'co'}|storereps`,
    read: () => api.storeReportCatalogue().catch(() => []) }),
  reportExamples: (wh) => ({ key: `${wh || 'co'}|repeg`,
    read: () => api.reportAskExamples().catch(() => null) }),
  // One report under one set of filters. The filters are sorted into the key
  // so the same question asked in a different order is the same entry.
  report: (wh, key, params) => ({
    key: `${wh || 'co'}|rep|${key}|${JSON.stringify(Object.entries(params || {}).sort())}`,
    read: () => api.runReport(key, params) }),
}

// Which report the Reports screen had up, per workspace — see Reports.
const REPORTS_MEMO = (wh) => `${wh || 'co'}|reports-open`
// How many report results are held per workspace before the oldest go.
const REPORTS_HELD = 12

// How recent a held read must be for the warm-up to leave it alone. Opening a
// screen always re-reads (behind what is drawn); this only spaces the warm-up.
const WARM_FRESH = 60 * 1000

/** Fill the cache for the screens this account can switch to, each read under
 *  its own workspace's header whatever is on screen. Failures are left for the
 *  screen to report when it is opened — a warm-up has nobody to tell. */
function warmDashboards({ command, central, warehouses, charts, fresh = WARM_FRESH }) {
  const out = []
  const warm = (wh, q) => out.push(asWarehouse(wh, () =>
    cacheLoad(q.key, q.read, { fresh }).catch(() => {})))
  if (command) warm(null, DASH.command('', null))
  if (central) { warm(null, DASH.central(14, null)); warm(null, DASH.sales(14, null)) }
  if (command || central) warm(null, DASH.examples(null))
  for (const wh of warehouses || []) {
    warm(wh, DASH.warehouse(wh))
    // the charts view is one more read, worth it only where somebody is standing
    if (charts) warm(wh, DASH.charts(wh))
  }
  return Promise.all(out)
}

/** The Reports screen for one workspace: its lists, and the report it will
 *  open on — the one left up there, or the first in the catalogue. Only the
 *  one: a warm-up that ran all thirty-three registers would cost more than
 *  every visit it saved. */
function warmReports(wh, fresh = WARM_FRESH) {
  const warm = (q) => asWarehouse(wh, () => cacheLoad(q.key, q.read, { fresh }))
  warm(DASH.reportGroups(wh)).catch(() => {})
  warm(DASH.storeReports(wh)).catch(() => {})
  warm(DASH.reportExamples(wh)).catch(() => {})
  return warm(DASH.reportCat(wh)).then((cat) => {
    const memo = recall(REPORTS_MEMO(wh)) || {}
    const e = (cat || []).find((r) => r.key === memo.key) || (memo.key ? null : cat?.[0])
    if (!e) return undefined         // a Store report, or one no longer listed
    // the same narrowing the screen applies — only filters this report takes
    const params = Object.fromEntries(Object.entries(memo.filters || {})
      .filter(([k, v]) => v && (e.params || []).includes(k)))
    return warm(DASH.report(wh, e.key, params))
  }).catch(() => {})
}

// ==========================================================================
//  Ask anything — one line first, the rows behind it
//  ------------------------------------------------------------------------
//  The Reports screen's question box picks a register and draws the table. This
//  one answers: a sentence with the figure in it, said the way the business says
//  money, and THEN the detail for whoever wants it. That order is the whole
//  point — an owner asking "what did we sell today" wants a number, not a
//  register to read.
//
//  The same box tracks a code. A GRN number, a bill number or a scanned QR typed
//  in here is followed end to end instead of being read as a question, because
//  somebody holding a tag does not want it parsed, they want its history.
//
//  Spoken questions land in the same box (VoiceButton, shared with Reports), and
//  a spoken question gets a spoken answer — `speak` comes from the server, with
//  the figure in lakhs and crores, because "eight lakh forty-two thousand" is
//  how it is said out loud and "842650" is not.
// ==========================================================================
function TraceChain({ chain }) {
  if (!chain || !chain.length) return null
  return (
    <ol className="cc-chain">
      {chain.map((s, i) => (
        <li key={i} className={'cc-step s-' + (s.state || 'done')}>
          <span className="cc-dot" aria-hidden="true" />
          <div className="cc-stepbody">
            <div className="cc-stage">{s.stage}</div>
            <div className="cc-steptitle">{s.title}</div>
            {s.detail && <div className="small cc-stepdetail">{s.detail}</div>}
            <div className="cc-stepmeta small">
              {s.when && <span>{String(s.when).replace('T', ' ')}</span>}
              {s.ref && <span className="mono">{s.ref}</span>}
              {s.qty != null && <span>{fmtQty(s.qty)} units</span>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}

function AskAnything({ go, big, placeholder, seed }) {
  const [q, setQ] = useState('')
  const [ans, setAns] = useState(null)
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState(false)
  const spoken = useRef(false)
  const asked = useRef(null)

  // Cached with the dashboards it sits on, so the examples do not pop in late.
  const wh = warehouse.get()?.id
  const meta = useCached(DASH.examples(wh).key, () => DASH.examples(wh).read()).data || null

  const say = (text) => {
    // Only for a question that was ASKED by voice: reading every typed answer
    // aloud in a shop office is a feature nobody asked for.
    try {
      if (!text || !window.speechSynthesis) return
      window.speechSynthesis.cancel()
      const u = new window.SpeechSynthesisUtterance(text)
      u.lang = 'en-IN'
      window.speechSynthesis.speak(u)
    } catch { /* no voice on this browser */ }
  }

  const run = async (text) => {
    const question = (typeof text === 'string' ? text : q).trim()
    if (!question) return
    setBusy(true); setDetails(false)
    try {
      const r = await api.commandAsk(question)
      setAns(r)
      if (spoken.current) say(r.speak || r.line)
    } catch (e) {
      const stale = e.status === 404 || e.status === 405
      setAns({ ok: false, title: 'Could not ask',
        line: stale
          ? 'The server is still running the code from before this screen existed — restart it and ask again.'
          : (e.detail || 'The question could not be sent.') })
    }
    spoken.current = false
    setBusy(false)
  }

  // A row somewhere else on the screen asking this box a question — clicking a
  // product, a store or a warehouse. `seed.n` changes on every click, so asking
  // the same thing twice still runs; the ref stops a re-render repeating it.
  useEffect(() => {
    if (!seed || !seed.q || asked.current === seed.n) return
    asked.current = seed.n
    setQ(seed.q)
    run(seed.q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  const pick = (choice) => {
    setBusy(true)
    api.commandTrace(ans?.code || q, choice.kind, choice.id)
      .then((r) => setAns(r)).catch(() => {}).finally(() => setBusy(false))
  }

  const exportCsv = () => {
    const cols = ans?.columns || []
    if (!cols.length) return
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const csv = [cols.map(esc).join(','),
      ...(ans.rows || []).map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
    // The byte-order mark is what makes Excel read ₹ and Tamil names as UTF-8
    // rather than mojibake. Written as an escape, not as the character: a real
    // U+FEFF in source is invisible, and the next editor to touch this line has
    // no way to see what it would be deleting.
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    const el = document.createElement('a')
    el.href = url
    el.download = `${(ans.title || 'answer').replace(/[^\w]+/g, '_').toLowerCase()}.csv`
    el.click()
    URL.revokeObjectURL(url)
  }

  const read = ans?.interpretation
  return (
    <div className={'cc-ask' + (big ? ' big' : '')}>
      <div className="askbar">
        <span className="ico" aria-hidden="true">✨</span>
        <span className="askfield">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder || 'Ask anything — press 🎤 and say “today’s total invoices” — or paste a GRN, bill or QR code'}
            title="Speak it or type it, in English or Tamil. A code pasted here is tracked end to end."
            onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) run() }} />
          {q && <button className="askclear" title="Clear" onClick={() => { setQ(''); setAns(null) }}>×</button>}
        </span>
        <VoiceButton onInterim={setQ} onSpoken={(t) => { spoken.current = true; run(t) }} disabled={busy} />
        <button className="btn primary" disabled={busy || !q.trim()} onClick={() => run()}>
          {busy ? 'Working…' : 'Ask'}</button>
        {meta?.engine === 'keywords' && (
          <span className="askengine" title="No AI key is set, so questions are matched on keywords rather than read as sentences. A super admin can set one in the top bar.">
            keyword mode</span>
        )}
      </div>

      {!ans && big && (
        <div className="cc-voicehint small">
          🎤 Press the microphone and say it — “today’s total sales”, “today’s total
          invoices”, “today’s total LR entries”, “today’s billing”, “which floor has
          the highest sales” — in English or Tamil. The answer is read back to you.
        </div>
      )}
      {!ans && meta?.examples && (
        <div className="cc-examples">
          {meta.examples.slice(0, big ? 8 : 6).map((e) => (
            <button key={e.q} className="cc-chip" title={e.note}
              onClick={() => { setQ(e.q); run(e.q) }}>{e.q}</button>
          ))}
        </div>
      )}

      {ans && (
        <div className={'cc-answer' + (ans.ok === false ? ' miss' : '')}>
          <div className="cc-answerhead">
            <div>
              <div className="cc-title small">{ans.title || 'Answer'}</div>
              <div className="cc-line">{ans.line}</div>
            </div>
            <span className="spacer" />
            {ans.headline && <div className="cc-headline">{ans.headline}</div>}
            <button className="askclear" title="Dismiss" onClick={() => setAns(null)}>×</button>
          </div>

          {(ans.facts || []).length > 0 && (
            <div className="cc-facts">
              {ans.facts.map((f) => (
                <span key={f.label} className="cc-fact"><b>{f.value}</b> {f.label}</span>
              ))}
            </div>
          )}

          {(ans.choices || []).length > 0 && (
            <div className="cc-examples">
              {ans.choices.map((c) => (
                <button key={c.kind + c.id} className="cc-chip" onClick={() => pick(c)}>{c.label}</button>
              ))}
            </div>
          )}

          <TraceChain chain={ans.chain} />

          {(ans.suggestions || []).length > 0 && (
            <div className="cc-examples">
              {ans.suggestions.map((s) => (
                <button key={s} className="cc-chip" onClick={() => { setQ(s); run(s) }}>{s}</button>
              ))}
            </div>
          )}

          <div className="cc-actions">
            {(ans.rows || []).length > 0 && (
              <button className="btn" onClick={() => setDetails((d) => !d)}>
                {details ? 'Hide details' : `View details · ${ans.rows.length} row(s)`}</button>
            )}
            {(ans.rows || []).length > 0 && (
              <button className="btn" onClick={exportCsv} title="Download these rows as a spreadsheet">
                Export</button>
            )}
            {ans.speak && (
              <button className="btn" onClick={() => say(ans.speak)} title="Read the answer out loud">
                🔊 Say it</button>
            )}
            {ans.open?.tab && go && (
              <button className="btn" onClick={() => go(ans.open.tab)}>Open the screen</button>
            )}
            <span className="spacer" />
            {read && (
              <span className="small cc-read" title="How the question was read — check it before trusting the figure">
                read as <b>{read.intent}</b>
                {ans.period ? ` · ${ans.period.label}` : ''}
                {read.engine === 'keywords' ? ' · keywords' : ''}
              </span>
            )}
          </div>

          {(read?.notes || []).map((n, i) => <div key={i} className="asknote warn">⚠ {n}</div>)}
          {read?.degraded && <div className="asknote warn">⚠ {read.degraded}</div>}
          {ans.note && <div className="asknote">{ans.note}</div>}

          {details && (ans.rows || []).length > 0 && (
            <div className="tablewrap" style={{ marginTop: 10 }}>
              <table className="items">
                <thead><tr>{ans.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{ans.rows.slice(0, 200).map((r, i) => (
                  <tr key={i}>{ans.columns.map((c) => (
                    <td key={c} className={typeof r[c] === 'number' ? 'num mono' : ''}>
                      {typeof r[c] === 'number' ? money(r[c]) : (fmtLoose(r[c]) ?? '')}</td>
                  ))}</tr>
                ))}</tbody>
              </table>
              {ans.rows.length > 200 && (
                <div className="small" style={{ padding: 8, color: 'var(--text-2)' }}>
                  Showing the first 200 of {ans.rows.length} — Export gives all of them.</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ==========================================================================
//  Command Center — the whole business on one screen
//  ------------------------------------------------------------------------
//  The owner's screen. Everything else in this app is a way into one part of
//  the operation; this is the operation: what sold, what came in, what is owed,
//  what is standing still, who did what — for every warehouse, store and till at
//  once, with one box to ask anything of it.
//
//  One request draws all of it (/api/command/overview), for the same reason the
//  Central Dashboard makes one: twenty figures fetched separately is twenty
//  round trips on a screen somebody opens first thing in the morning.
//
//  Every figure is the business's own day (IST, not UTC) — see
//  services/business_day — and is scoped to whatever warehouses the account is
//  allotted. The panel says which figures are company-wide whatever that scope.
// ==========================================================================
const CC_SERIES = [
  ['sales', 'Sales', 'What the stores billed, net of returns'],
  ['purchases', 'Purchases', 'GRNs posted — goods that became stock'],
  ['payments', 'Payments', 'Paid to suppliers'],
  ['returns', 'Returns', 'Customer returns and debit notes'],
  ['movement', 'Stock movement', 'Units in and out of the warehouses'],
]

function CommandCenter({ go, toast, user, role, onEnter }) {
  const [day, setDay] = useState('')
  const [scope, setScope] = useState(null)        // one warehouse, or every one
  const [view, setView] = useState('sales')
  // What a clicked row asks the question box — a product's SKU traces it end to
  // end, a place asks for its sales. See AskAnything's `seed`.
  const [seed, setSeed] = useState(null)
  const ask = (q) => setSeed({ q, n: Date.now() })

  // Held in the dashboard cache: coming back to this screen draws the last
  // read at once and refreshes behind it. See dashcache.js.
  const cc = useCached(DASH.command(day, scope).key, () => DASH.command(day, scope).read())
  const ov = cc.data || null
  const busy = cc.busy
  const load = cc.refresh
  const err = !cc.error ? ''
    : (cc.error.status === 404 || cc.error.status === 405) ? 'restart'
      : (cc.error.detail || 'The Command Center could not be read')

  if (err === 'restart') return (
    <div className="screen scrolls">
      <div className="pagehead"><h2>Command Center</h2></div>
      <div className="screenbody"><div className="warnbox" style={{ maxWidth: 620 }}>
        <h4>The server needs restarting</h4>
        <div className="small" style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
          <code>/api/command/overview</code> is registered when Python starts, and this
          server was started before it existed. Stop it and run it again.
        </div></div></div>
    </div>
  )

  const k = ov?.kpis || {}
  // ₹8.42 L, not ₹842,650.00 — a tile is read at a glance, and the full figure
  // is in its tooltip. Named apart from the app's `money`, which is the long form.
  const short = (v) => '₹' + compact(+v || 0)
  // The warehouse row behind an id, so "Open POS" hands the shell the same
  // building the picker would — with its code, which the context bar shows.
  const whOf = (id) => {
    const w = (ov?.places?.warehouses || []).find((x) => x.warehouse_id === id)
      || (ov?.places?.picker || []).find((x) => x.warehouse_id === id)
    return w ? { id: w.warehouse_id, name: w.name, code: w.code } : null
  }
  const series = ov?.series
  const chart = () => {
    if (!series) return null
    if (view === 'movement') {
      return (
        <ChartCard title="Units in and out, per day" columns={['Day', 'In', 'Out']}
          rows={series.labels.map((l, i) => [l, fmtQty(series.inward[i]), fmtQty(series.outward[i])])}
          legend={<Legend items={[{ label: 'Inward', color: 'var(--viz-1)' },
            { label: 'Outward', color: 'var(--viz-2)' }]} />}>
          <GroupedBars labels={series.labels} unit="units"
            series={[{ name: 'Inward', values: series.inward },
              { name: 'Outward', values: series.outward }]} />
        </ChartCard>
      )
    }
    const values = series[view] || []
    const meta = CC_SERIES.find(([key]) => key === view)
    return (
      <ChartCard title={`${meta[1]} — the last fortnight`} note={meta[2]}
        columns={['Day', meta[1]]}
        rows={series.labels.map((l, i) => [l, short(values[i])])}>
        <LineChart labels={series.labels} values={values} unit="₹" />
      </ChartCard>
    )
  }

  return (
    <div className="screen scrolls">
      <div className="pagehead">
        <h2>🧭 Command Center</h2>
        <div className="pagesub">
          {ov ? `${ov.label} · ${ov.counts?.warehouses ?? 0} warehouse(s), ${ov.counts?.stores ?? 0} store(s), ${ov.counts?.counters ?? 0} till(s)` : 'The whole business on one screen'}
          {ov?.scope?.warehouse ? ` · ${ov.scope.warehouse} only`
            : ov?.scope?.restricted ? ' · your allotted warehouses only' : ''}
        </div>
        {/* Scopes the WHOLE screen — tiles, charts, alerts and activity — to one
            building, the way the Central Dashboard's picker does. The warehouse
            table below is the other way in: click a row. */}
        <select className="sel" value={scope || ''} style={{ minWidth: 190 }}
          title="Show one warehouse — its stock, its stores' takings, its GRNs and its people"
          onChange={(e) => setScope(e.target.value ? +e.target.value : null)}>
          <option value="">All warehouses</option>
          {(ov?.places?.picker || []).map((w) => (
            <option key={w.warehouse_id} value={w.warehouse_id}>{w.name}</option>
          ))}
        </select>
        <input type="date" value={day} max={ov?.day} style={{ width: 150 }}
          title="Look at another business day" onChange={(e) => setDay(e.target.value)} />
        {day && <button className="btn" onClick={() => setDay('')}>Today</button>}
        <button className="btn" onClick={() => load().catch(() => {})} disabled={busy}>{busy ? 'Reading…' : 'Refresh'}</button>
      </div>

      <div className="screenbody">
        <AskAnything go={go} big seed={seed} />

        {err && <div className="warnbox" style={{ marginBottom: 14 }}>
          <h4>Some of this could not be read</h4>
          <div className="small" style={{ color: 'var(--text-2)' }}>{err}</div></div>}
        {!ov ? <div className="empty" style={{ marginTop: 30 }}>Reading the business…</div> : (
          <>
            {!ov.pos?.available && (
              <div className="warnbox" style={{ marginBottom: 14 }}>
                <h4>The stores' till database is not readable from here</h4>
                <div className="small" style={{ color: 'var(--text-2)' }}>
                  Sales, discounts, profit and store stock are blank; everything from the
                  warehouse's own books is unaffected.</div>
              </div>
            )}

            <div className="dgrid" style={{ marginBottom: 'var(--sp-4)' }}>
              <DashTile label={`${ov.label}'s Sales`} value={short(k.sales?.value)} accent="money"
                sub={`${n0(k.sales?.bills || 0)} bill(s) · ${fmtQty(k.sales?.units || 0)} units`}
                hint={`Billed ₹${money(k.sales?.gross || 0)} less ₹${money(k.sales?.returns || 0)} of customer returns`}
                onClick={() => go('central')} />
              <DashTile label="Purchases" value={short(k.purchases?.value)} accent="stock"
                sub={`${n0(k.purchases?.grns || 0)} GRN(s) · ${fmtQty(k.purchases?.units || 0)} units`}
                hint="GRNs posted today — goods that actually became stock"
                onClick={() => go('purchases')} />
              <DashTile label="Stock Value" value={short(k.stock_value?.value)} accent="count"
                sub={`${fmtQty(k.stock_value?.qty || 0)} units · ${n0(k.stock_value?.items || 0)} items`}
                hint="Quantity × each warehouse's own weighted-average cost"
                onClick={() => go('inventory')} />
              <DashTile label="Profit" value={short(k.profit?.value)} accent="money"
                tone={k.profit?.value > 0 ? 'ok' : ''}
                sub={k.profit?.margin_pct != null ? `${k.profit.margin_pct}% margin` : 'no sales yet'}
                hint="Store sales before tax, less what those goods cost at the till" />
            </div>

            <div className="dgrid small-tiles" style={{ marginBottom: 'var(--sp-4)' }}>
              <DashTile label="Warehouses" value={n0(ov.counts?.warehouses || 0)} accent="count"
                sub="open" onClick={() => go('locations')} />
              <DashTile label="Stores" value={n0(ov.counts?.stores || 0)} accent="count"
                sub="selling" onClick={() => go('locations')} />
              <DashTile label="POS Counters" value={n0(ov.counts?.counters || 0)} accent="count"
                sub="tills" onClick={() => go('locations')} />
              {ov.counts?.users != null && (
                <DashTile label="Users" value={n0(ov.counts.users)} accent="count"
                  sub="can sign in" onClick={() => go('users')} />
              )}
              <DashTile label="Low Stock" value={n0(k.low_stock?.count || 0)} accent="back"
                tone={k.low_stock?.count ? 'warn' : ''} sub="in the stores"
                hint="Store products at or below their reorder level" />
              <DashTile label="Returns" value={short(k.returns?.value)} accent="back"
                sub={`${n0(k.returns?.store_notes || 0)} customer · ${n0(k.returns?.debit_notes || 0)} supplier`} />
            </div>

            <Section id="cc.flow" title="Business overview"
              summary={CC_SERIES.find(([key]) => key === view)[1]}
              actions={
                <span className="segbar">
                  {CC_SERIES.map(([key, label]) => (
                    <button key={key} className={view === key ? 'on' : ''}
                      onClick={(e) => { e.stopPropagation(); setView(key) }}>{label}</button>
                  ))}
                </span>}>
              {chart()}
            </Section>

            {/* ---- one row per warehouse: what it holds AND what its shops took ---- */}
            <Section id="cc.warehouses" title="Warehouses"
              summary={`${(ov.places?.warehouses || []).length} building(s)`}>
              <div className="tablewrap">
                <table className="items">
                  <thead><tr>
                    <th>Warehouse</th><th>Code</th><th className="num">Stores</th>
                    <th className="num">Stock (qty)</th><th className="num">Stock value</th>
                    <th className="num">{ov.label}'s sales</th><th className="num">Bills</th>
                    <th className="num">Purchases</th><th className="num">In transit</th>
                    <th style={{ width: 170 }}></th>
                  </tr></thead>
                  <tbody>
                    {!(ov.places?.warehouses || []).length && (
                      <tr><td colSpan={10} className="small" style={{ padding: 16 }}>
                        No warehouses yet — add one under Locations.</td></tr>
                    )}
                    {(ov.places?.warehouses || []).map((w) => (
                      <tr key={w.warehouse_id} className={w.warehouse_id === scope ? 'sel' : ''}
                        style={{ cursor: 'pointer' }}
                        title="Show the whole screen for this warehouse"
                        onClick={() => setScope(w.warehouse_id === scope ? null : w.warehouse_id)}>
                        <td><b>{w.name}</b>{w.active === false && <span className="small"> · closed</span>}</td>
                        <td className="mono small">{w.code || '—'}</td>
                        <td className="num">{w.stores}</td>
                        <td className="num mono">{fmtQty(w.qty)}</td>
                        <td className="num mono">₹ {money(w.value)}</td>
                        <td className="num mono">₹ {money(w.sales)}</td>
                        <td className="num">{n0(w.bills)}</td>
                        <td className="num mono">₹ {money(w.purchases)}</td>
                        <td className="num mono">{fmtQty(w.in_transit)}</td>
                        {/* No per-row "Ask" button: the bar at the top is the way
                            to ask, by voice or typed, and a column of twenty
                            identical buttons is a column of noise. Clicking the
                            row scopes the screen; Open walks into the building. */}
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn" style={{ padding: '2px 10px' }}
                            title={`Work inside ${w.name} — every screen shows only its own`}
                            onClick={(e) => { e.stopPropagation(); onEnter && onEnter({ id: w.warehouse_id, name: w.name, code: w.code }) }}>
                            Open →</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* ---- and one per store, with the tills under it ---- */}
            <Section id="cc.stores" title="Stores & POS counters"
              summary={`${(ov.places?.stores || []).length} store(s) · ${(ov.places?.counters || []).length} till(s) billing`}>
              <div className="tablewrap">
                <table className="items">
                  <thead><tr>
                    <th>Store</th><th>Warehouse</th><th className="num">Tills</th>
                    <th className="num">Bills</th><th className="num">{ov.label}'s sales</th>
                    <th className="num">Returns</th><th style={{ width: 190 }}></th>
                  </tr></thead>
                  <tbody>
                    {!(ov.places?.stores || []).length && (
                      <tr><td colSpan={7} className="small" style={{ padding: 16 }}>
                        No stores under this scope — add one under Locations.</td></tr>
                    )}
                    {(ov.places?.stores || []).map((s) => (
                      <tr key={s.id} style={{ cursor: 'pointer' }}
                        title={`Ask for ${s.name}'s sales`}
                        onClick={() => ask(`Today's sales at ${s.name}`)}>
                        <td><b>{s.name}</b>
                          {/* A badge, not a sentence: it is true of every row on a
                              shop whose branch names differ, and a paragraph
                              repeated seven times stops being read. */}
                          {!s.matched && <span className="badge" style={{ marginLeft: 6 }}
                            title="The till spells this branch differently, so its takings cannot be matched to this store — the names have to agree">
                            unmatched</span>}</td>
                        <td className="small">{s.warehouse || '—'}</td>
                        <td className="num">{s.terminals}</td>
                        <td className="num">{n0(s.bills)}</td>
                        <td className="num mono">₹ {money(s.sales)}</td>
                        <td className="num mono">{s.returns ? '₹ ' + money(s.returns) : '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn" style={{ padding: '2px 10px' }}
                            title={`Open this store's billing screens`}
                            onClick={() => onEnter && onEnter(whOf(s.warehouse_id) || { id: s.warehouse_id, name: s.warehouse }, 'pos:home')}>
                            Open POS →</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(ov.places?.counters || []).length > 0 && (
                <div className="tablewrap" style={{ marginTop: 12 }}>
                  <table className="items">
                    <thead><tr><th>POS counter</th><th className="num">Bills</th>
                      <th className="num">{ov.label}'s sales</th></tr></thead>
                    <tbody>{(ov.places.counters).map((c) => (
                      <tr key={c.label}>
                        <td className="small">{c.label}</td>
                        <td className="num">{n0(c.bills)}</td>
                        <td className="num mono">₹ {money(c.amount)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {(ov.places?.cashiers || []).length > 0 && (
                <div className="small" style={{ marginTop: 8, color: 'var(--text-2)' }}>
                  Billed by: {(ov.places.cashiers).map((c) => `${c.label} (₹${money(c.amount)})`).join(' · ')}
                </div>
              )}
            </Section>

            <div className="vizgrid">
              <ChartCard title="Top selling products — last 30 days"
                note="Click a bar's row in the table to follow that product end to end"
                columns={['Product', 'SKU', 'Sales']}
                rows={(ov.top_products || []).map((r) => [r.label, r.sku, short(r.amount)])}>
                {(ov.top_products || []).length ? <>
                  <HBars rows={(ov.top_products || []).map((r) => ({ label: r.label, value: r.amount }))} unit="₹" />
                  {/* A bar cannot be clicked in an SVG chart without turning the
                      chart into a control; the chips can, and they carry the SKU
                      — which is what a trace needs. */}
                  <div className="cc-examples">
                    {(ov.top_products || []).map((r) => (
                      <button key={r.sku || r.label} className="cc-chip"
                        title={`Follow ${r.sku || r.label} from its supplier to what is left`}
                        onClick={() => ask(r.sku || r.label)}>{r.label} →</button>
                    ))}
                  </div>
                </> : <div className="empty">No store sales in the last 30 days.</div>}
              </ChartCard>
              <ChartCard title={`Sales by floor — ${ov.label.toLowerCase()}`}
                columns={['Floor', 'Sales']}
                rows={(ov.top_floors || []).map((r) => [r.label, short(r.amount)])}>
                {(ov.top_floors || []).length
                  ? <HBars ordinal rows={(ov.top_floors || []).map((r) => ({ label: r.label, value: r.amount }))} unit="₹" />
                  : <div className="empty">Nothing billed yet.</div>}
              </ChartCard>
            </div>

            <Section id="cc.money" title="What needs somebody"
              summary={`${n0(k.pending_grns?.count || 0)} GRN(s), ₹${compact(k.pending_payments?.value || 0)} owed`}>
              <div className="dgrid small-tiles">
                <DashTile label="Pending GRNs" value={n0(k.pending_grns?.count || 0)} accent="adjust"
                  tone={k.pending_grns?.count ? 'warn' : ''}
                  sub={`₹${compact(k.pending_grns?.value || 0)} · ${n0(k.pending_grns?.documents || 0)} invoice(s) to review`}
                  onClick={() => go('purchases')} />
                <DashTile label="Pending Payments" value={short(k.pending_payments?.value)} accent="money"
                  tone={k.pending_payments?.overdue ? 'warn' : ''}
                  sub={`${n0(k.pending_payments?.bills || 0)} bill(s) · ₹${compact(k.pending_payments?.overdue || 0)} over 30 days`}
                  onClick={() => go('payments')} />
                <DashTile label="Dead Stock" value={n0(k.dead_stock?.count || 0)} accent="back"
                  tone={k.dead_stock?.critical ? 'warn' : ''}
                  sub={`₹${compact(k.dead_stock?.value || 0)} · idle ${k.dead_stock?.days || 90}+ days`}
                  onClick={() => go('deadstock')} />
                <DashTile label="In Transit" value={fmtQty(k.movement?.in_transit || 0)} accent="move"
                  sub={`${fmtQty(k.movement?.inward || 0)} in / ${fmtQty(k.movement?.outward || 0)} out today`}
                  onClick={() => go('inward')} />
                <DashTile label="Discounts" value={short(k.discounts?.value)} accent="back"
                  sub="given at the tills today" />
                <DashTile label="Transactions" value={n0(k.transactions?.count || 0)} accent="count"
                  sub={`${n0(k.transactions?.bills || 0)} bills · ${n0(k.transactions?.grns || 0)} GRNs · ${n0(k.transactions?.payments || 0)} payments`} />
              </div>
            </Section>

            <div className="cc-two">
              <Section id="cc.alerts" title="Alerts & exceptions"
                summary={`${(ov.alerts || []).length} open`}>
                {!(ov.alerts || []).length
                  ? <div className="empty">Nothing is asking for attention.</div>
                  : (ov.alerts || []).map((a, i) => (
                    <div key={i} className={'cc-alert ' + a.level}
                      onClick={() => a.tab && go(a.tab)}
                      style={{ cursor: a.tab ? 'pointer' : 'default' }}>
                      <div className="cc-alerttitle">{a.title}</div>
                      <div className="small">{a.body}{a.waiting ? ` · waiting ${a.waiting}` : ''}</div>
                    </div>
                  ))}
              </Section>

              <Section id="cc.slow" title="Low & dead stock"
                summary={`${n0(k.low_stock?.count || 0)} low · ${n0(k.dead_stock?.count || 0)} dead`}>
                <div className="tablewrap">
                  <table className="items">
                    <thead><tr><th>Product</th><th>Where</th><th className="num">Stock</th><th className="num">Value</th></tr></thead>
                    <tbody>
                      {/* Every product row opens its own history — supplier, GRN,
                          warehouse, what sold, what is left. */}
                      {(ov.low_stock || []).map((r) => (
                        <tr key={'l' + r.sku} style={{ cursor: 'pointer' }}
                          title={`Follow ${r.sku} end to end`} onClick={() => ask(r.sku)}>
                          <td>{r.product}<span className="small" style={{ color: 'var(--text-2)' }}> · low</span></td>
                          <td className="small">{r.floor || 'store'}</td>
                          <td className="num mono">{fmtQty(r.stock)}</td>
                          <td className="num small">reorder at {fmtQty(r.reorder_level)}</td>
                        </tr>
                      ))}
                      {(ov.dead_stock || []).map((r) => (
                        <tr key={'d' + r.sku} style={{ cursor: 'pointer' }}
                          title={`Follow ${r.sku} end to end`} onClick={() => ask(r.sku)}>
                          <td>{r.name}<span className="small" style={{ color: 'var(--text-2)' }}> · idle {r.days}d</span></td>
                          <td className="small">{r.category || '—'}</td>
                          <td className="num mono">{fmtQty(r.qty)}</td>
                          <td className="num mono">₹ {money(r.value)}</td>
                        </tr>
                      ))}
                      {!(ov.low_stock || []).length && !(ov.dead_stock || []).length && (
                        <tr><td colSpan={4} className="small" style={{ padding: 14 }}>
                          Nothing is low or standing still.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Section>
            </div>

            <Section id="cc.activity" title="Recent activity"
              summary={`${(ov.activity || []).length} newest`}
              actions={<button className="btn" style={{ padding: '2px 9px', fontSize: 11 }}
                onClick={(e) => { e.stopPropagation(); go('audit') }}>Open the audit trail</button>}>
              <div className="tablewrap">
                <table className="items">
                  <thead><tr><th style={{ width: 130 }}>When</th><th style={{ width: 150 }}>Who</th>
                    <th style={{ width: 120 }}>Module</th><th>What</th><th style={{ width: 150 }}>Where</th></tr></thead>
                  <tbody>
                    {!(ov.activity || []).length && (
                      <tr><td colSpan={5} className="small" style={{ padding: 14 }}>
                        Nothing has happened yet today.</td></tr>
                    )}
                    {(ov.activity || []).map((a, i) => (
                      <tr key={i} className={a.outcome === 'refused' ? 'warnrow' : undefined}>
                        <td className="small mono">{(a.local || '').replace('T', ' ').slice(0, 16)}</td>
                        <td className="small"><b>{a.who}</b>{a.role ? <span style={{ color: 'var(--text-2)' }}> · {a.role}</span> : ''}</td>
                        <td className="small">{a.module}</td>
                        <td className="small">{a.summary}</td>
                        <td className="small">{a.where || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <div className="small" style={{ color: 'var(--text-2)', marginTop: 10, lineHeight: 1.6 }}>
              Figures are for the business day {ov.day} and read at {(ov.generated_at || '').replace('T', ' ')}.
              Dead stock, the stores' low stock and supplier payments are company-wide — they belong
              to a product or a supplier rather than to a building.
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ==========================================================================
//  Audit Trail — who did what, when and where
//  ------------------------------------------------------------------------
//  Written by the server for every change that reaches a route, so this screen
//  is a reader and nothing else. An admin sees their own warehouses and not the
//  account-management lines; a super admin sees everything. See services/audit.
// ==========================================================================
function AuditTrail({ go }) {
  const [rows, setRows] = useState([])
  const [meta, setMeta] = useState({ people: [], modules: [] })
  const [f, setF] = useState({ user: '', screen: '', outcome: '', date_from: '', date_to: '', q: '' })
  const [more, setMore] = useState(null)
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback((before) => {
    setBusy(true)
    return api.auditEvents({ ...f, limit: 100, before })
      .then((r) => {
        setRows((old) => (before ? [...old, ...r.events] : r.events))
        setMore(r.next_before)
        setMeta({ people: r.people || [], modules: r.modules || [] })
        setErr('')
      })
      .catch((e) => setErr(e.status === 404 || e.status === 405
        ? 'The server was started before the audit trail existed — restart it.'
        : (e.detail || 'The trail could not be read')))
      .finally(() => setBusy(false))
  }, [f])
  useEffect(() => { load() }, [load])

  const set = (k, v) => setF((old) => ({ ...old, [k]: v }))
  return (
    <div className="screen scrolls">
      <div className="pagehead">
        <h2>📝 Audit Trail</h2>
        <div className="pagesub">Every change, who made it and where — newest first</div>
        <select className="sel" value={f.user} onChange={(e) => set('user', e.target.value)}
          title="One person's actions" style={{ minWidth: 140 }}>
          <option value="">Everyone</option>
          {meta.people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="sel" value={f.screen} onChange={(e) => set('screen', e.target.value)}
          title="One module" style={{ minWidth: 150 }}>
          <option value="">Every module</option>
          {meta.modules.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
        <select className="sel" value={f.outcome} onChange={(e) => set('outcome', e.target.value)}
          title="Refused attempts only">
          <option value="">Done and refused</option>
          <option value="ok">Done</option>
          <option value="refused">Refused</option>
          <option value="failed">Failed sign-ins</option>
        </select>
        <input type="date" value={f.date_from} style={{ width: 140 }}
          title="From this business day" onChange={(e) => set('date_from', e.target.value)} />
        <input type="date" value={f.date_to} style={{ width: 140 }}
          title="To this business day" onChange={(e) => set('date_to', e.target.value)} />
        <input value={f.q} placeholder="Search the trail…" style={{ width: 180 }}
          onChange={(e) => set('q', e.target.value)} />
      </div>

      <div className="screenbody">
        {err && <div className="warnbox" style={{ marginBottom: 12 }}>
          <div className="small">{err}</div></div>}
        <div className="section">
          <div className="tablewrap">
            <table className="items">
              <thead><tr>
                <th style={{ width: 140 }}>When</th><th style={{ width: 160 }}>Who</th>
                <th style={{ width: 130 }}>Module</th><th>What happened</th>
                <th style={{ width: 140 }}>Where</th><th style={{ width: 120 }}>Reference</th>
              </tr></thead>
              <tbody>
                {!rows.length && !busy && (
                  <tr><td colSpan={6} className="small" style={{ padding: 16 }}>
                    Nothing on the trail for these filters.</td></tr>
                )}
                {rows.map((e) => (
                  <tr key={e.id} className={e.outcome !== 'ok' ? 'warnrow' : undefined}>
                    <td className="small mono">{(e.local || '').replace('T', ' ')}</td>
                    <td className="small"><b>{e.who}</b>
                      {e.role_label && <span style={{ color: 'var(--text-2)' }}> · {e.role_label}</span>}</td>
                    <td className="small">{e.module}</td>
                    <td className="small">
                      {e.outcome === 'refused' && <span className="badge" style={{ marginRight: 6 }}>refused</span>}
                      {e.outcome === 'failed' && <span className="badge" style={{ marginRight: 6 }}>failed</span>}
                      {e.summary}</td>
                    <td className="small">{e.warehouse || '—'}</td>
                    <td className="small mono">{e.ref || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="items-foot">
            <span className="small">{rows.length} line(s)</span>
            <span className="spacer" />
            {more && <button className="btn" disabled={busy} onClick={() => load(more)}>
              {busy ? 'Reading…' : 'Load older'}</button>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ==========================================================================
//  Central Dashboard — every warehouse, from one place
//  ------------------------------------------------------------------------
//  The company-wide view: what is standing where, what it is worth, and what
//  moved. The Dashboard beside it answers "what needs doing today" for the
//  warehouse in front of you; this one answers "how is the whole operation
//  doing", which is a different question asked by a different person.
//
//  The warehouse picker scopes the tiles, the movement figures and the chart —
//  but never the table. The table is how somebody switches warehouse, and
//  filtering it to the one already chosen would leave no way back.
//
//  One request feeds all of it (/api/locations/overview). A screen with six
//  tiles, a table and two charts that fetched each part separately would open
//  in N round trips.
// ==========================================================================
function CentralDashboard({ toast, go, onEnter }) {
  const [scope, setScope] = useState(null)      // warehouse id, or null for all
  const [days, setDays] = useState(14)
  const [busy, setBusy] = useState(false)

  // Both reads are held in the dashboard cache, so switching back here draws
  // the last figures at once and refreshes behind them. See dashcache.js.
  const oq = useCached(DASH.central(days, scope).key, () => DASH.central(days, scope).read())
  const ov = oq.data || null
  const err = !oq.error ? null
    : oq.error.status === 404 ? 'restart' : (oq.error.detail || oq.error.message)
  // Fetched on its own, and its failure is its own. The shop is a second
  // database; if it is switched off this section says so while everything above
  // it still draws.
  const sq = useCached(DASH.sales(days, scope).key, () => DASH.sales(days, scope).read())
  const sales = sq.data
    || (sq.error ? { available: false, reason: sq.error.detail || sq.error.message } : null)
  const load = () => Promise.allSettled([oq.refresh(), sq.refresh()])

  const rebuild = async () => {
    setBusy(true)
    try {
      const r = await api.rebuildStock()
      toast(`✓ Recomputed ${r.products_rebuilt} product(s) from the movement ledger`, 'ok')
      await load()
    } catch (e) { toast(e.detail || e.message, 'err') }
    setBusy(false)
  }

  if (err === 'restart') return (
    <div className="screen scrolls">
      <div className="pagehead"><h2>Central Dashboard</h2></div>
      <div className="screenbody"><div className="warnbox" style={{ maxWidth: 620 }}>
        <h4>The server needs restarting</h4>
        <div className="small" style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
          <code>/api/locations/overview</code> is registered when Python starts,
          and this server was started before it existed. Stop it and run it again.
        </div></div></div>
    </div>
  )

  const rows = ov?.warehouses || []
  const t = ov?.totals || {}
  const scoped = rows.find((w) => w.warehouse_id === scope)
  // Only warehouses that actually hold something are charted. A bar of zero is
  // ink that says nothing, and four of them crowd out the one that has stock.
  const valued = rows.filter((w) => w.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((w) => ({ label: w.name, value: w.value }))
  const s = ov?.series
  const stores = ov?.stores || []
  const tf = ov?.transfers || { totals: {}, warehouses: [] }

  return (
    <div className="screen scrolls">
      <div className="pagehead">
        <h2>Central Dashboard</h2>
        <div className="pagesub">Every warehouse at once — stock, value, stores, POS sales and what moved</div>
        <select value={scope || ''} style={{ minWidth: 200 }}
          onChange={(e) => setScope(e.target.value ? +e.target.value : null)}
          title="Scope the tiles and the chart to one warehouse">
          <option value="">All warehouses</option>
          {rows.map((w) => (
            <option key={w.warehouse_id} value={w.warehouse_id}>{w.name}</option>
          ))}
        </select>
        <select value={days} style={{ minWidth: 120 }}
          onChange={(e) => setDays(+e.target.value)}
          title="How far back the movement chart looks">
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button className="btn" onClick={load}>Refresh</button>
      </div>

      <div className="screenbody">
        {/* The same question box the Command Center leads with. An admin never
            sees that screen, and "what did we sell today" is not a question only
            the owner asks — so it is here too, answered inside whatever
            warehouses this account is allotted. */}
        <AskAnything go={go} />

        {err && <div className="warnbox" style={{ marginBottom: 14 }}>
          <h4>The dashboard could not be read</h4>
          <div className="small" style={{ color: 'var(--text-2)' }}>{err}</div></div>}

        {!ov ? <div className="empty" style={{ marginTop: 40 }}>Loading…</div> : (
          <>
            <div className="dgrid" style={{ marginBottom: 'var(--sp-4)' }}>
              <DashTile label="Total Warehouses" value={t.warehouses ?? 0}
                accent="count" sub={scoped ? scoped.name : 'active'}
                hint="Warehouses that are open. A closed one keeps its history and stops being offered."
                onClick={() => go && go('locations')} />
              <DashTile label="Total Stores / POS" value={t.stores ?? 0}
                accent="count" sub={scope ? 'supplied by this warehouse' : 'active'}
                hint="Stores that sell. Their stock lives in the shop's own till database."
                onClick={() => go && go('locations')} />
              <DashTile label="Total Inventory (Qty)" value={fmtQty(t.qty)}
                accent="stock" sub={`${t.items ?? 0} distinct item(s)`}
                hint="Units on hand, counted in each product's own unit."
                onClick={() => go && go('inventory')} />
              <DashTile label="Total Value" value={'₹ ' + money(t.value)}
                accent="money" sub="at weighted-average cost"
                hint="Quantity × the warehouse's own average cost, summed."
                onClick={() => go && go('inventory')} />
              <DashTile label="Today's Inward" value={fmtQty(ov.today?.inward)}
                accent="move" sub="units received" tone={ov.today?.inward ? 'ok' : ''}
                hint="Everything that added stock today — receipts and transfers in."
                onClick={() => go && go('purchases')} />
              <DashTile label="Today's Outward" value={fmtQty(ov.today?.outward)}
                accent="move" sub="units dispatched" tone={ov.today?.outward ? 'ok' : ''}
                hint="Everything that removed stock today — dispatches, transfers out, returns."
                onClick={() => go && go('outward')} />
            </div>

            <Section id="cd.overview" title="Warehouse Overview"
              summary={`${rows.length} warehouse(s)`}>
              <div className="tablewrap">
                <table className="items">
                  <thead><tr>
                    <th>Warehouse</th><th>Code</th><th>Location</th><th>Trades in</th>
                    <th className="num">Stores / POS</th>
                    <th className="num">Stock (Qty)</th>
                    <th className="num">Stock Value</th>
                    <th>Status</th>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    {!rows.length && (
                      <tr><td colSpan={9} className="small" style={{ padding: 16 }}>
                        No warehouses yet. Add one under Locations.</td></tr>
                    )}
                    {rows.map((w) => (
                      <tr key={w.warehouse_id}
                        className={w.warehouse_id === scope ? 'sel' : ''}
                        style={{ cursor: 'pointer' }}
                        title="Scope this dashboard to this warehouse"
                        onClick={() => setScope(w.warehouse_id === scope ? null : w.warehouse_id)}>
                        <td><b>{w.name}</b></td>
                        <td className="mono small">{w.code || '—'}</td>
                        <td className="small">{w.address || '—'}</td>
                        <td className="small">{w.catalogue || '—'}</td>
                        <td className="num">{w.store_count}</td>
                        <td className="num mono">{fmtQty(w.qty)}</td>
                        <td className="num mono">₹ {money(w.value)}</td>
                        <td>{w.active
                          ? <span className="badge confirmed">Active</span>
                          : <span className="badge review">Closed</span>}</td>
                        {/* The way IN. Everything from here — LR entry, invoices,
                            GRN, inventory, labels, outward, inward, returns —
                            then shows this warehouse's work and nobody else's. */}
                        <td><button className="btn" style={{ padding: '2px 10px' }}
                          title={`Work inside ${w.name} — every screen shows only its own`}
                          onClick={(e) => { e.stopPropagation(); onEnter && onEnter(w) }}>
                          Open →</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="items-foot">
                <span>{rows.length} warehouse(s)</span>
                <span>Σ qty <b>{fmtQty(sum(rows, (r) => r.qty))}</b></span>
                <span>Σ value <b>₹ {money(sum(rows, (r) => r.value))}</b></span>
                <span className="spacer" />
                <button className="btn" disabled={busy} onClick={rebuild}
                  title="Recompute every warehouse balance from the movement ledger. Always safe — the ledger is the source of truth and this only rebuilds the running totals from it.">
                  {busy ? 'Recomputing…' : 'Recompute from ledger'}</button>
              </div>
            </Section>

            {/* ---- Stores / POS, under the warehouse that supplies each ---- */}
            <Section id="cd.stores" title="Stores / POS"
              summary={`${stores.length} store(s)`}
              actions={<button className="btn" style={{ padding: '2px 9px' }}
                onClick={() => go && go('reports')}
                title="Open the Stores / POS by Warehouse report">Report →</button>}>
              <div className="tablewrap">
                <table className="items">
                  <thead><tr>
                    <th>Store / POS</th><th>Code</th><th>Warehouse</th>
                    <th>Trades in</th><th>Type</th>
                    <th className="num">Tills</th><th>Status</th>
                  </tr></thead>
                  <tbody>
                    {!stores.length && (
                      <tr><td colSpan={7} className="small" style={{ padding: 16 }}>
                        No stores yet. Add them under Locations.</td></tr>
                    )}
                    {stores.map((s) => (
                      <tr key={s.id}>
                        <td><b>{s.name}</b></td>
                        <td className="mono small">{s.code || '—'}</td>
                        <td className="small">{s.warehouse || '(not assigned)'}</td>
                        <td className="small">{s.catalogue || '—'}</td>
                        <td className="small" title={s.terminals
                          ? 'Has a till, so it can bill'
                          : 'No till — it holds stock but cannot bill'}>{s.type}</td>
                        <td className="num">{s.terminals}</td>
                        <td>{s.active
                          ? <span className="badge confirmed">Active</span>
                          : <span className="badge review">Closed</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="items-foot">
                <span>{stores.length} store(s)</span>
                <span>Σ tills <b>{sum(stores, (s) => s.terminals)}</b></span>
              </div>
            </Section>

            {/* ---- What the shops sold, per branch ---- */}
            <Section id="cd.sales" title="POS Sales by Store"
              summary={sales?.available
                ? `₹ ${money(sales.totals?.net)} net`
                : 'the till could not be read'}
              actions={<button className="btn" style={{ padding: '2px 9px' }}
                onClick={() => go && go('reports')}
                title="Open the Sales by Store report">Report →</button>}>
              {!sales ? <div className="empty" style={{ padding: 20 }}>Loading…</div>
                : !sales.available ? (
                  <div className="warnbox">
                    <h4>No sales figures</h4>
                    <div className="small" style={{ color: 'var(--text-2)' }}>
                      {sales.reason || 'The shop could not be read.'} Everything
                      above is the warehouse's own ledger and is unaffected.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="dgrid" style={{ marginBottom: 'var(--sp-3)' }}>
                      <DashTile label="Net Sales" value={'₹ ' + money(sales.totals?.net)}
                        accent="money" sub={`last ${days} days`}
                        hint="Billed less returns, across every shop." />
                      <DashTile label="Bills" value={sales.totals?.bills ?? 0}
                        accent="count" sub={`${sales.totals?.stores ?? 0} store(s) selling`}
                        hint="Bills raised at a branch in this window." />
                      <DashTile label="Units Sold" value={fmtQty(sales.totals?.units)}
                        accent="move" sub="net of returns" />
                      <DashTile label="Returns" value={'₹ ' + money(sales.totals?.returns)}
                        accent="back" tone={sales.totals?.returns ? 'warn' : ''}
                        sub="credit notes" />
                    </div>
                    <div className="tablewrap">
                      <table className="items">
                        <thead><tr><th>Store</th><th>Warehouse</th>
                          <th className="num">Bills</th><th className="num">Units</th>
                          <th className="num">Gross</th><th className="num">Returns</th>
                          <th className="num">Net</th><th>Last sale</th></tr></thead>
                        <tbody>
                          {!(sales.stores || []).length && (
                            <tr><td colSpan={8} className="small" style={{ padding: 16 }}>
                              No shop sales in this window.</td></tr>
                          )}
                          {(sales.stores || []).map((s) => (
                            <tr key={s.store}>
                              <td><b>{s.store}</b></td>
                              <td className="small">{s.warehouse || '—'}</td>
                              <td className="num">{s.bills}</td>
                              <td className="num mono">{fmtQty(s.units)}</td>
                              <td className="num mono">₹ {money(s.gross)}</td>
                              <td className="num mono">₹ {money(s.returns)}</td>
                              <td className="num mono"><b>₹ {money(s.net)}</b></td>
                              <td className="small">{fmtDate(s.last_sale)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {/* Never folded into the totals — a branch the two systems
                        spell differently, and its money is real. Said out loud
                        because a figure that quietly vanished is unfindable. */}
                    {(sales.unmatched || []).length > 0 && (
                      <div className="warnbox" style={{ marginTop: 12 }}>
                        <h4>{sales.unmatched.length} branch(es) not recognised</h4>
                        <div className="small" style={{ color: 'var(--text-2)' }}>
                          The till sold ₹ {money(sales.unmatched.reduce(
                            (a, u) => a + u.net, 0))} at{' '}
                          {sales.unmatched.map((u) => `“${u.store}”`).join(', ')},
                          which matches no store here. The two are linked by NAME —
                          rename the store under Locations to match, and this money
                          joins the totals above.
                        </div>
                      </div>
                    )}
                    {sales.unplaced?.bills > 0 && (
                      <div className="items-foot">
                        <span className="small">Plus {sales.unplaced.bills} bill(s)
                          worth ₹ {money(sales.unplaced.net)} raised before the till
                          recorded a branch — real money, belonging to no store.</span>
                      </div>
                    )}
                  </>
                )}
            </Section>

            {/* ---- Transfers between our own places ---- */}
            <Section id="cd.transfers" title="Stock Transfers"
              summary={`${tf.totals?.transfers || 0} warehouse transfer(s)`}
              actions={<button className="btn" style={{ padding: '2px 9px' }}
                onClick={() => go && go('reports')}
                title="Open the Stock Transfer Register report">Report →</button>}>
              <div className="dgrid" style={{ marginBottom: 'var(--sp-3)' }}>
                <DashTile label="Warehouse Transfers" value={tf.totals?.transfers ?? 0}
                  accent="count" sub={`last ${s?.days || days} days`}
                  hint="Movements between two of your own warehouses."
                  onClick={() => go && go('outward')} />
                <DashTile label="Sent to Stores" value={tf.totals?.to_store ?? 0}
                  accent="count" sub="dispatch notes"
                  hint="Goods sent to a shop. Its own till database owns them from there."
                  onClick={() => go && go('outward')} />
                <DashTile label="Units Moved" value={fmtQty(tf.totals?.qty_moved)}
                  accent="move" sub="dispatched in the window"
                  hint="Everything that actually left a warehouse — drafts excluded." />
                <DashTile label="In Transit" value={fmtQty(tf.totals?.in_transit)}
                  accent="move" tone={tf.totals?.in_transit ? 'warn' : ''}
                  sub="not yet counted in"
                  hint="Dispatched between warehouses and not yet accepted at the far end — standing in neither building."
                  onClick={() => go && go('inward')} />
              </div>
              <div className="tablewrap">
                <table className="items">
                  <thead><tr><th>Warehouse</th>
                    <th className="num">Sent out</th>
                    <th className="num">To stores</th>
                    <th className="num">Received in</th>
                    <th className="num">In transit to it</th>
                    <th className="num">Notes</th></tr></thead>
                  <tbody>
                    {!(tf.warehouses || []).length && (
                      <tr><td colSpan={6} className="small" style={{ padding: 16 }}>
                        Nothing has moved between places in this window.</td></tr>
                    )}
                    {(tf.warehouses || []).map((w) => (
                      <tr key={w.warehouse_id}>
                        <td><b>{w.name}</b></td>
                        <td className="num mono">{fmtQty(w.sent)}</td>
                        <td className="num mono">{fmtQty(w.to_stores)}</td>
                        <td className="num mono">{fmtQty(w.received)}</td>
                        <td className="num mono"
                          style={{ color: w.in_transit ? 'var(--danger)' : undefined }}>
                          {fmtQty(w.in_transit)}</td>
                        <td className="num">{w.documents}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <div className="vizgrid">
              <ChartCard title="Net Sales by Store"
                note={sales?.available
                  ? `Billed less returns, last ${days} days.`
                  : 'The till could not be read.'}
                columns={['Store', 'Net']}
                rows={(sales?.stores || []).map((s) => [s.store, '₹ ' + money(s.net)])}>
                {(sales?.stores || []).some((s) => s.net > 0)
                  ? <HBars unit="rupees" rows={(sales.stores || [])
                    .filter((s) => s.net > 0)
                    .map((s) => ({ label: s.store, value: s.net }))} />
                  : <div className="empty" style={{ padding: 30 }}>
                      {sales?.available === false
                        ? 'No sales figures — the shop could not be read.'
                        : 'No shop sales in this window.'}</div>}
              </ChartCard>

              <ChartCard title="Shop Sales per Day"
                note={`Net takings across the shops, last ${days} days.`}
                columns={['Day', 'Net']}
                rows={(sales?.series?.labels || []).map((l, i) =>
                  [l, '₹ ' + money(sales.series.net[i])])}>
                {(sales?.series?.net || []).some(Boolean)
                  ? <LineChart labels={sales.series.labels} values={sales.series.net}
                    unit="rupees" valueFmt={(v) => '₹ ' + money(v)} />
                  : <div className="empty" style={{ padding: 30 }}>
                      Nothing sold in this window.</div>}
              </ChartCard>
            </div>

            <div className="vizgrid">
              <ChartCard title="Stores per Warehouse"
                note="How many shops each warehouse supplies. A warehouse with none is stocking, not supplying."
                columns={['Warehouse', 'Stores']}
                rows={rows.map((w) => [w.name, w.store_count])}>
                {rows.some((w) => w.store_count > 0)
                  ? <HBars unit="stores" rows={rows.filter((w) => w.store_count > 0)
                    .sort((a, b) => b.store_count - a.store_count)
                    .map((w) => ({ label: w.name, value: w.store_count }))} />
                  : <div className="empty" style={{ padding: 30 }}>
                      No stores are assigned to a warehouse yet.</div>}
              </ChartCard>

              <ChartCard title="Transfers by Warehouse"
                legend={<Legend items={[
                  { label: 'Sent out', color: 'var(--viz-1)' },
                  { label: 'Received in', color: 'var(--viz-2)' },
                  { label: 'In transit', color: 'var(--viz-3)' }]} />}
                note={`Units moved between your own places over the last ${s?.days || days} days.`}
                columns={['Warehouse', 'Sent', 'Received', 'In transit']}
                rows={(tf.warehouses || []).map((w) => [w.name, fmtQty(w.sent),
                  fmtQty(w.received), fmtQty(w.in_transit)])}>
                {(tf.warehouses || []).length
                  ? <GroupedBars unit="units"
                    labels={(tf.warehouses || []).map((w) => w.name)}
                    series={[
                      { name: 'Sent out', values: tf.warehouses.map((w) => w.sent) },
                      { name: 'Received in', values: tf.warehouses.map((w) => w.received) },
                      { name: 'In transit', values: tf.warehouses.map((w) => w.in_transit) },
                    ]} />
                  : <div className="empty" style={{ padding: 30 }}>
                      Nothing has moved between places in this window.</div>}
              </ChartCard>
            </div>

            <div className="vizgrid">
              <ChartCard title="Stock Value by Warehouse"
                note={scope ? `Scoped to ${scoped?.name}. Clear the filter to compare.` : null}
                columns={['Warehouse', 'Value']}
                rows={valued.map((r) => [r.label, '₹ ' + money(r.value)])}>
                {valued.length
                  ? <HBars rows={valued} unit="rupees" />
                  : <div className="empty" style={{ padding: 30 }}>
                      No stock is valued yet. Post a GRN and it appears here.</div>}
              </ChartCard>

              <ChartCard title="Inward vs Outward"
                legend={<Legend items={[
                  { label: 'Inward', color: 'var(--viz-1)' },
                  { label: 'Outward', color: 'var(--viz-2)' }]} />}
                note={`Units moved per day over the last ${s?.days || days} days`
                  + (scope ? ` at ${scoped?.name}` : '')
                  + `. Σ in ${fmtQty(ov.window?.inward)} · Σ out ${fmtQty(ov.window?.outward)}.`}
                columns={['Day', 'Inward', 'Outward']}
                rows={(s?.labels || []).map((l, i) => [l, fmtQty(s.inward[i]), fmtQty(s.outward[i])])}>
                {s && (s.inward.some(Boolean) || s.outward.some(Boolean))
                  ? <GroupedBars labels={s.labels} unit="units" series={[
                      { name: 'Inward', values: s.inward },
                      { name: 'Outward', values: s.outward }]} />
                  : <div className="empty" style={{ padding: 30 }}>
                      Nothing moved in this window.</div>}
              </ChartCard>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Quantities are floats but are read as counts: 12 rather than 12.0, and 12.5
// kept when a half really is a half.
function fmtQty(v) {
  const n = +v || 0
  return Number.isInteger(n) ? n.toLocaleString('en-IN')
    : n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
}

// ==========================================================================
//  Catalogues — what each warehouse trades in
//  ------------------------------------------------------------------------
//  Essa receives garments and Taqua receives silks. The PROCESS over them is
//  identical — LR entry, invoice entry, GRN, inventory, labels, outward,
//  inward, POS — and none of it differs. What differs is the NOUNS: the
//  categories a receiving clerk picks from, the attributes an item carries,
//  and the values those attributes offer.
//
//  So a catalogue is a business line, not a building. Essa, Palakkad and
//  Madurai can all stock garments and share one list maintained once; Taqua
//  points at its own. See backend/app/services/catalogues.py.
// ==========================================================================
function TagList({ values, onAdd, onRemove, placeholder }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    // A comma-separated paste is how somebody enters twenty colours at once,
    // and splitting it here is the difference between that and twenty clicks.
    const parts = draft.split(',').map((s) => s.trim()).filter(Boolean)
    if (!parts.length) return
    onAdd(parts)
    setDraft('')
  }
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {!values.length && <span className="small" style={{ color: 'var(--text-2)' }}>
          Nothing offered yet — type the first value below.</span>}
        {values.map((v) => (
          <span key={v} className="badge" style={{ display: 'inline-flex', gap: 6 }}>
            {v}
            <button className="link" title="Remove from the list"
              onClick={() => onRemove(v)}>×</button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={draft} placeholder={placeholder || 'Add a value — or paste several, comma separated'}
          style={{ flex: 1 }} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
        <button className="btn" onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
    </div>
  )
}

// Upload a master out of a file, and SHOW WHAT IT FOUND before writing it.
//
// Two steps, always. Reading a spreadsheet is a guess about somebody's layout,
// and a guess that silently added four hundred wrong values to a live master
// would not be noticed until products had been classified against them. So the
// first call previews (the server writes nothing) and the second commits what
// was just shown.
function ImportBox({ label, hint, accept, onPreview, onCommit, onDone, toast }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const input = useRef(null)

  const reset = () => {
    setFile(null); setPreview(null)
    if (input.current) input.current.value = ''
  }

  const pick = async (f) => {
    if (!f) return
    setFile(f); setPreview(null); setBusy(true)
    try { setPreview(await onPreview(f)) }
    catch (e) { toast(e.detail || e.message, 'err'); reset() }
    setBusy(false)
  }

  const commit = async () => {
    setBusy(true)
    try {
      const r = await onCommit(file)
      toast(r.message || 'Imported', 'ok')
      reset()
      onDone && onDone()
    } catch (e) { toast(e.detail || e.message, 'err') }
    setBusy(false)
  }

  return (
    <div className="infobox" style={{ marginTop: 'var(--sp-3)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{label}</b>
        <input ref={input} type="file" accept={accept} style={{ flex: 1, minWidth: 220 }}
          onChange={(e) => pick(e.target.files?.[0])} />
        {busy && <span className="small">Reading…</span>}
      </div>
      <div className="small" style={{ color: 'var(--text-2)', marginTop: 6 }}>{hint}</div>
      {preview && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
          {preview.body}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn primary" disabled={busy || !preview.canCommit}
              onClick={commit}>{preview.cta}</button>
            <button className="btn" disabled={busy} onClick={reset}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// The download half. Two links rather than a format dropdown: there are exactly
// two answers, and a dropdown plus a button is three clicks for what should be
// one. What comes down is a file ImportBox reads back, so this is also how you
// get a correctly-headed template for a master you have not built yet.
function DownloadLinks({ url, label }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span className="small" style={{ color: 'var(--text-2)' }}>{label}</span>
      <a className="btn" style={{ padding: '2px 9px' }} href={url('xlsx')}
        title="Download as an Excel workbook — edit it and upload it back">Excel</a>
      <a className="btn" style={{ padding: '2px 9px' }} href={url('csv')}
        title="Download as CSV">CSV</a>
    </span>
  )
}

const ACCEPT = '.xlsx,.xlsm,.csv,.tsv,.txt,.pdf'
const FILE_HINT = 'Excel (.xlsx), CSV or PDF. A PDF is read as one value per line — '
  + 'a spreadsheet is read properly and is always the better file if you have one.'

function Catalogues({ toast }) {
  const [list, setList] = useState([])
  const [columnAttrs, setColumnAttrs] = useState([])
  const [selId, setSelId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [err, setErr] = useState(null)
  const [creating, setCreating] = useState(false)
  const [nf, setNf] = useState({ code: '', name: '', description: '' })
  const [newAttr, setNewAttr] = useState('')
  const [newCat, setNewCat] = useState('')
  const [openAttr, setOpenAttr] = useState(null)

  const load = useCallback(() => api.listCatalogues()
    .then((r) => {
      setList(r.catalogues || [])
      setColumnAttrs(r.column_attributes || [])
      setErr(null)
      setSelId((cur) => cur || (r.catalogues || []).find((c) => c.is_default)?.id
        || (r.catalogues || [])[0]?.id || null)
    })
    .catch((e) => setErr(e.status === 404 ? 'restart' : (e.detail || e.message))), [])
  useEffect(() => { load() }, [load])

  const loadDetail = useCallback(() => {
    if (!selId) { setDetail(null); return }
    api.getCatalogue(selId).then(setDetail).catch((e) => toast(e.detail || e.message, 'err'))
  }, [selId, toast])
  useEffect(() => { loadDetail() }, [loadDetail])

  const run = async (fn, ok) => {
    try { await fn(); await load(); loadDetail(); if (ok) toast(ok, 'ok') }
    catch (e) { toast(e.detail || e.message, 'err') }
  }

  const create = () => {
    if (!nf.code.trim() || !nf.name.trim()) { toast('A catalogue needs a code and a name', 'err'); return }
    run(async () => {
      const c = await api.createCatalogue({
        code: nf.code.trim(), name: nf.name.trim(),
        description: nf.description.trim() || null })
      setSelId(c.id); setCreating(false); setNf({ code: '', name: '', description: '' })
    }, 'Catalogue created — now add its attributes and categories')
  }

  if (err === 'restart') return (
    <div className="screen scrolls">
      <div className="pagehead"><h2>Catalogues</h2></div>
      <div className="screenbody"><div className="warnbox" style={{ maxWidth: 620 }}>
        <h4>The server needs restarting</h4>
        <div className="small" style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
          <code>/api/catalogues</code> is registered when Python starts, and this
          server was started before catalogues existed. Stop it and run it again.
        </div></div></div>
    </div>
  )

  const known = new Set((detail?.attributes || []).map((a) => a.key))

  return (
    <div className="screen scrolls">
      <div className="pagehead">
        <h2>Catalogues</h2>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>+ New catalogue</button>
      </div>
      <div className="screenbody">
        <div className="infobox" style={{ marginBottom: 'var(--sp-4)' }}>
          A <b>catalogue</b> is a line of business — what a warehouse actually deals
          in. It owns the <b>categories</b> its GRN offers and the <b>attributes</b> its
          items carry, so a silk warehouse is never asked a garment’s sleeve length.
          Any number of warehouses can share one. Assign them under <b>Locations</b>.
        </div>

        {err && <div className="warnbox" style={{ marginBottom: 14 }}>
          <h4>Catalogues could not be read</h4>
          <div className="small" style={{ color: 'var(--text-2)' }}>{err}</div></div>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--sp-4)' }}>
          {list.map((c) => (
            <button key={c.id} className={'btn' + (c.id === selId ? ' primary' : '')}
              onClick={() => setSelId(c.id)}>
              {c.name}
              <span className="small" style={{ marginLeft: 6, opacity: 0.75 }}>
                {c.category_count} cat · {c.attribute_count} attr · {c.warehouse_count} wh</span>
              {c.is_default && <span className="badge" style={{ marginLeft: 6 }}>default</span>}
              {c.active === false && <span className="badge review" style={{ marginLeft: 6 }}>off</span>}
            </button>
          ))}
        </div>

        {detail && (
          <>
            <Section id="cat.about" title={`${detail.name} · ${detail.code}`}
              summary={`${detail.product_count} product(s) filed under it`}>
              <div className="kv" style={{ gridTemplateColumns: '150px 1fr' }}>
                <div className="k">Description</div><div>{detail.description || '—'}</div>
                <div className="k">Warehouses</div>
                <div>{detail.warehouses?.length
                  ? detail.warehouses.map((w) => w.name).join(', ')
                  : <span className="small">None yet — assign one under Locations.</span>}</div>
              </div>
              {!detail.is_default && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={() => run(
                    () => api.updateCatalogue(detail.id, { active: detail.active === false }),
                    detail.active === false ? 'Reopened' : 'Switched off')}>
                    {detail.active === false ? 'Reopen' : 'Switch off'}</button>
                  <button className="btn" onClick={() => {
                    if (!window.confirm(`Delete “${detail.name}”? Only possible while nothing is filed under it.`)) return
                    run(async () => { await api.deleteCatalogue(detail.id); setSelId(null) }, 'Deleted')
                  }}>Delete</button>
                </div>
              )}
            </Section>

            <Section id="cat.attrs" title="Attributes"
              summary={`${detail.attributes?.length || 0} recorded against each item`}
              actions={<DownloadLinks label="Download all"
                url={(f) => api.attributesFileUrl(detail.id, f)} />}>
              <div className="small" style={{ color: 'var(--text-2)', marginBottom: 10 }}>
                What this line records about an item. A name the stock master already
                has a column for — colour, size, brand and the rest — is stored there
                and is visible to every existing screen and label. Anything else is
                stored against the item itself, no release needed.
              </div>
              <div className="tablewrap">
                <table className="items">
                  <thead><tr><th>Attribute</th><th>Key</th><th>Stored</th>
                    <th>Values offered</th><th></th></tr></thead>
                  <tbody>
                    {!(detail.attributes || []).length && (
                      <tr><td colSpan={5} className="small" style={{ padding: 14 }}>
                        No attributes yet. Add the ones this trade actually records.</td></tr>
                    )}
                    {(detail.attributes || []).map((a) => (
                      <tr key={a.key}>
                        <td><b>{a.label}</b></td>
                        <td className="mono small">{a.key}</td>
                        <td className="small" title={a.stored === 'column'
                          ? 'A column on the stock master — shared with every other line and visible to every screen'
                          : 'Stored against the item itself, so this line can record it without a schema change'}>
                          {a.stored === 'column' ? 'stock master column' : 'item attribute'}</td>
                        <td>
                          <button className="link"
                            onClick={() => setOpenAttr(openAttr === a.key ? null : a.key)}>
                            {(detail.options?.[a.key] || []).length} value(s)
                            {openAttr === a.key ? ' ▴' : ' ▾'}</button>
                          {openAttr === a.key && (
                            <div style={{ marginTop: 8 }}>
                              <TagList values={detail.options?.[a.key] || []}
                                onAdd={(vals) => run(
                                  () => api.setAttrOptions(detail.id, a.key, vals))}
                                onRemove={(v) => run(
                                  () => api.removeAttrOption(detail.id, a.key, v))} />
                              <div style={{ marginTop: 8 }}>
                                <DownloadLinks label={`Download ${a.label} list`}
                                  url={(f) => api.attrOptionsFileUrl(detail.id, a.key, f)} />
                              </div>
                              {/* The individual counterpart to the bulk import
                                  below: somebody has this one attribute's list
                                  and only this one. */}
                              <ImportBox toast={toast} accept={ACCEPT}
                                label={`Import ${a.label} values`}
                                hint={`A single column of ${a.label.toLowerCase()} values. `
                                  + `A first row naming the attribute is skipped. ` + FILE_HINT}
                                onPreview={async (f) => {
                                  const r = await api.importAttrOptions(detail.id, a.key, f, false)
                                  return {
                                    canCommit: r.values_new > 0,
                                    cta: `Add ${r.values_new} value(s)`,
                                    body: (
                                      <div className="small">
                                        <b>{r.values_in_file}</b> value(s) in {r.source},
                                        {' '}<b>{r.values_new}</b> not already listed.
                                        {r.sample.length > 0 && <div style={{ marginTop: 6 }}>
                                          {r.sample.join(', ')}
                                          {r.values_new > r.sample.length && ' …'}</div>}
                                      </div>
                                    ),
                                  }
                                }}
                                onCommit={async (f) => {
                                  const r = await api.importAttrOptions(detail.id, a.key, f, true)
                                  return { message: `✓ ${a.label}: ${r.options.length} value(s) now listed` }
                                }}
                                onDone={loadDetail} />
                            </div>
                          )}
                        </td>
                        <td><button className="btn" style={{ padding: '2px 7px' }}
                          title="Stop recording this. Items already carrying a value keep it."
                          onClick={() => run(() => api.removeCatalogueAttr(detail.id, a.key),
                            'Attribute switched off')}>×</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
                <input list="cat-colattrs" value={newAttr} placeholder="e.g. weave, zari, border — or pick a stock master column"
                  style={{ flex: 1 }} onChange={(e) => setNewAttr(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newAttr.trim()) {
                    e.preventDefault()
                    run(() => api.addCatalogueAttr(detail.id, { key: newAttr.trim() }), 'Attribute added')
                    setNewAttr('') } }} />
                <datalist id="cat-colattrs">
                  {columnAttrs.filter((c) => !known.has(c.key))
                    .map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </datalist>
                <button className="btn" disabled={!newAttr.trim()} onClick={() => {
                  run(() => api.addCatalogueAttr(detail.id, { key: newAttr.trim() }), 'Attribute added')
                  setNewAttr('')
                }}>+ Add attribute</button>
              </div>

              <ImportBox toast={toast} accept={ACCEPT}
                label="Import attributes in bulk"
                hint={'One column per attribute with its name as the heading (Colour, Size, Weave…) '
                  + 'and its values beneath — or two columns headed Attribute and Value. '
                  + FILE_HINT}
                onPreview={async (f) => {
                  const r = await api.importAttributes(detail.id, f, false)
                  const some = r.new_attributes > 0 || r.new_values > 0
                  return {
                    canCommit: some,
                    cta: `Import ${r.new_attributes} attribute(s) · ${r.new_values} value(s)`,
                    body: (
                      <>
                        <div className="small" style={{ marginBottom: 8 }}>
                          Found <b>{r.attributes.length}</b> attribute(s) in
                          {' '}<b>{r.source}</b>.
                          {!some && ' Everything in it is already in this catalogue.'}
                        </div>
                        <div className="tablewrap">
                          <table className="items">
                            <thead><tr><th>Attribute</th><th>Stored</th>
                              <th className="num">In file</th><th className="num">New</th>
                              <th>First few new values</th></tr></thead>
                            <tbody>{r.attributes.map((a) => (
                              <tr key={a.key}>
                                <td><b>{a.label}</b> <span className="mono small">{a.key}</span>
                                  {a.new_attribute && <span className="badge" style={{ marginLeft: 6 }}>new</span>}</td>
                                <td className="small">{a.stored === 'column'
                                  ? 'stock master column' : 'item attribute'}</td>
                                <td className="num">{a.values_in_file}</td>
                                <td className="num">{a.values_new}</td>
                                <td className="small">{a.sample.join(', ') || '—'}</td>
                              </tr>
                            ))}</tbody>
                          </table>
                        </div>
                      </>
                    ),
                  }
                }}
                onCommit={async (f) => {
                  const r = await api.importAttributes(detail.id, f, true)
                  return { message: `✓ ${r.new_attributes} attribute(s) and `
                    + `${r.new_values} value(s) imported` }
                }}
                onDone={() => { load(); loadDetail() }} />
            </Section>

            <Section id="cat.cats" title="Categories"
              summary={`${detail.categories?.length || 0} in this line's master`}
              actions={<DownloadLinks label="Download"
                url={(f) => api.categoriesFileUrl(detail.id, f)} />}>
              <div className="small" style={{ color: 'var(--text-2)', marginBottom: 10 }}>
                What a GRN in this line may classify an item as. A warehouse whose
                catalogue has none offers none — which is the prompt to build it,
                not a reason to file its goods under another trade’s list.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {!(detail.categories || []).length && (
                  <span className="small" style={{ color: 'var(--text-2)' }}>
                    Nothing yet — add this trade’s categories below.</span>
                )}
                {(detail.categories || []).map((c) => (
                  <span key={c.id} className="badge" style={{ display: 'inline-flex', gap: 6 }}>
                    {c.name}
                    <button className="link" title="Remove from this master"
                      onClick={() => run(() => api.removeCatalogueCategory(detail.id, c.id),
                        'Removed')}>×</button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={newCat} placeholder="e.g. SILK-SAREE — or paste several, comma separated"
                  style={{ flex: 1 }} onChange={(e) => setNewCat(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCats() } }} />
                <button className="btn" disabled={!newCat.trim()} onClick={() => addCats()}>
                  + Add category</button>
              </div>

              <ImportBox toast={toast} accept={ACCEPT}
                label="Import categories"
                hint={'A column of category names, and a Section column if you have one '
                  + '(OVERALL / KIDS / LADIES / MENS). Names are stored in capitals. '
                  + FILE_HINT}
                onPreview={async (f) => {
                  const r = await api.importCategories(detail.id, f, false)
                  return {
                    canCommit: r.new > 0,
                    cta: `Import ${r.new} categor${r.new === 1 ? 'y' : 'ies'}`,
                    body: (
                      <div className="small">
                        <b>{r.in_file}</b> name(s) in {r.source} — <b>{r.new}</b> new,
                        {' '}{r.already_there} already in this catalogue.
                        {r.sample.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                            {r.sample.map((c) => (
                              <span key={c.name} className="badge">{c.name}
                                {c.section && c.section !== 'OVERALL'
                                  && <span className="text-muted"> · {c.section}</span>}</span>
                            ))}
                            {r.new > r.sample.length && <span className="small">
                              …and {r.new - r.sample.length} more</span>}
                          </div>
                        )}
                      </div>
                    ),
                  }
                }}
                onCommit={async (f) => {
                  const r = await api.importCategories(detail.id, f, true)
                  return { message: `✓ ${r.new} categor${r.new === 1 ? 'y' : 'ies'} imported` }
                }}
                onDone={() => { load(); loadDetail() }} />
            </Section>
          </>
        )}
      </div>

      {creating && (
        <div className="modal-back" onClick={() => setCreating(false)}>
          <div className="modal" style={{ width: 'min(520px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><b>New catalogue</b>
              <button className="modal-x" onClick={() => setCreating(false)}>×</button></div>
            <div className="modal-body">
              <div className="mgrid">
                <div className="field"><label>Code</label>
                  <input autoFocus value={nf.code} placeholder="SILKS"
                    onChange={(e) => setNf({ ...nf, code: e.target.value.toUpperCase() })} /></div>
                <div className="field"><label>Name</label>
                  <input value={nf.name} placeholder="Silks"
                    onChange={(e) => setNf({ ...nf, name: e.target.value })} /></div>
                <div className="field" style={{ gridColumn: '1 / -1' }}><label>Description</label>
                  <input value={nf.description} placeholder="Sarees, dhotis and silk fabric"
                    onChange={(e) => setNf({ ...nf, description: e.target.value })} /></div>
              </div>
              <div className="infobox" style={{ marginTop: 'var(--sp-3)' }}>
                It starts <b>empty</b>. Nobody but the people who trade in this line
                knows what belongs in it, and a guessed list is one somebody has to
                delete before they can build the real one.
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn primary" onClick={create}>Create</button>
              <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  function addCats() {
    const parts = newCat.split(',').map((s) => s.trim()).filter(Boolean)
    if (!parts.length) return
    run(async () => {
      for (const name of parts) await api.addCatalogueCategory(detail.id, { name })
    }, `${parts.length} categor${parts.length === 1 ? 'y' : 'ies'} added`)
    setNewCat('')
  }
}

// ==========================================================================
//  Two altitudes, two menus
//  ------------------------------------------------------------------------
//  COMPANY level is for looking ACROSS the business: how the warehouses
//  compare, where one item is, what the registers say, which places exist and
//  who may sign in. Nothing operational — there is no such thing as "receive
//  goods" without a building to receive them into, and offering GRN with no
//  warehouse chosen is offering a form whose most important field is missing.
//
//  WAREHOUSE level is the day's work, and it is everything else. The two
//  company screens that manage warehouses themselves (the comparison, and the
//  list of places) drop away, because neither has an answer from inside one.
//
//  So the menu is not one list with things greyed out. It is two lists, and
//  which one you get says where you are standing.
// ==========================================================================
const COMPANY_ONLY = new Set(['command', 'audit', 'central', 'locations'])

//: The whole company-level menu. Anything not here needs a warehouse first.
const COMPANY_LEVEL = new Set(['command', 'audit', 'central', 'locator', 'reports',
                               'locations', 'users'])

//: Four ranked roles — services/users.py holds the same four, and everything is
//: compared by RANK so the top one inherits every screen below it.
const ROLE_RANK = { user: 1, admin: 2, superadmin: 3, superboss: 4 }
const ROLE_LABEL = { user: 'User', admin: 'Admin', superadmin: 'Super Admin',
                     superboss: 'Super Boss' }
const rank = (role) => ROLE_RANK[role] || 0
const atLeast = (role, need) => rank(role) >= rank(need)

const MODULES = [
  // Drawn at the very top of the menu, above the warehouse Dashboard — see the
  // sidebar items below, which hoist it out of this list. It stays HERE so it
  // is gated like every other module rather than being a special case.
  // The owner's screen, above the Central Dashboard because it is above it in
  // altitude: the whole business — warehouses, stores, tills, money and people —
  // with one box to ask anything of it.
  { key: 'command', icon: '🧭', label: 'Command Center', blurb: 'The whole business on one screen — ask anything, by voice too', min: 'superadmin' },
  { key: 'central', icon: '🏦', label: 'Central Dashboard', blurb: 'Every warehouse at once — stock, value and what moved', min: 'admin' },
  // First in the menu because it is first in the chain — the order is raised
  // before the lorry is booked in, the invoice read, or the goods received.
  { key: 'purchase_orders', icon: '📝', label: 'Purchase Orders', blurb: 'What we asked for — raise it, confirm it, and receive against it' },
  { key: 'lr', icon: '🚚', label: 'LR Entry', blurb: 'The transport register — consignments as they arrive' },
  { key: 'documents', icon: '🧾', label: 'Invoice Entry', blurb: 'Read a supplier invoice and review what came off it' },
  { key: 'purchases', icon: '📋', label: 'GRN', blurb: 'Receive against an invoice — count, claim shortages, post' },
  { key: 'inventory', icon: '📦', label: 'Inventory', blurb: 'Stock on hand, labels and per-piece codes' },
  // Beside Inventory because it is a question about the same stock — not what
  // we hold, but what has stopped moving and what clearing it is worth.
  // Beside Inventory because it is a question about the same stock, asked from
  // the other end: not what we hold, but what THIS ONE is.
  { key: 'locator', icon: '🔎', label: 'Item Locator', blurb: 'Scan any tag — what it is, where it came from, where it is, where it went' },
  // Beside the Locator because both start with a scanned tag. The Locator asks
  // "what is this one thing"; the audit asks "is everything where we think it
  // is" — one item against its whole history, or the whole shelf against the
  // books. The counting itself is done on the phone at the rack.
  // Named for the building it counts, because there are now two audits and they
  // answer different questions. THIS one walks a warehouse rack with a scanner
  // and asks "is this where we think it is" — a presence check, one row per tag.
  // The STORE's (POS → Physical Stock Audit) counts a shop floor by quantity:
  // how many are there against how many the books say, with the shortage or
  // excess and an approval before anything moves. One word for both would send
  // people to the wrong screen.
  { key: 'stock_audit', icon: '📋', label: 'Warehouse Stock Audit', blurb: 'Scan a rack — is each item where the books say? (a store floor is counted under POS)' },
  // The second warehouse audit, and beside the first because the pair are chosen
  // between rather than found separately. They are two questions about the same
  // racks: that one asks IS IT HERE, one tag at a time, and answers with a
  // presence check; this asks HOW MANY ARE HERE over a chosen set of stock, and
  // ends in a variance somebody approves and that then corrects the books. The
  // labels have to carry the difference, because a menu that said "Stock Audit"
  // twice would be picked from at random.
  { key: 'physical_audit', icon: '🧮', label: 'Physical Stock Audit', blurb: 'Count a rack by quantity against the books, and correct what is wrong' },
  // Beside the audit because both are about the product master rather than the
  // stock in it: one asks whether the count is right, this asks what the thing
  // sells for. Admin-only to change, and the screen says so rather than hiding.
  { key: 'pricing', icon: '🏷', label: 'Price Changer', blurb: 'Change what things sell for — one item or a whole category, with a record you can put back' },
  { key: 'deadstock', icon: '🧊', label: 'Dead Stock & Clearance', blurb: 'Stock nobody is buying, the discount ladder, and whether the clearance worked', min: 'admin' },
  // Design and printing are two entries because they are two jobs, and they are
  // also two roles: the designer is opened when a new roll of label stock is
  // bought, by whoever set the warehouse up, while the printing screen is
  // opened every time goods are put away, by whoever is putting them away.
  { key: 'labels', icon: '🏷', label: 'Label Designer', blurb: 'Lay out the sticker once — which field prints where, and how big the QR is', min: 'admin' },
  { key: 'labelprint', icon: '🖨', label: 'QR / Label Printing', blurb: 'Pick stock, pick a template, print the labels' },
  { key: 'outward', icon: '📤', label: 'Stock Outward', blurb: 'Dispatch stock to a shop or another godown' },
  { key: 'inward', icon: '📥', label: 'Stock Inward', blurb: 'Accept a dispatched transfer, line by line' },
  { key: 'returns', icon: '↩', label: 'Returns', blurb: 'Debit notes raised against a posted GRN', min: 'admin' },
  { key: 'payments', icon: '₹', label: 'Payments', blurb: 'Settle supplier bills and read the ledger', min: 'admin' },
  { key: 'reports', icon: '📊', label: 'Reports', blurb: 'Every register, filtered and exportable', min: 'admin' },
  { key: 'suppliers', icon: '🏭', label: 'Suppliers', blurb: 'Supplier master and trained invoice formats', min: 'admin' },
  { key: 'masters', icon: '⚙', label: 'Masters', blurb: 'Categories, agents, transporters and the dropdown lists', min: 'admin' },
  // Beside Locations because they answer two halves of one question: Locations
  // is WHERE this company trades, Catalogues is WHAT each of those places
  // trades in.
  { key: 'catalogues', icon: '📚', label: 'Catalogues', blurb: 'What each warehouse deals in — its categories, its attributes and their values', min: 'admin' },
  { key: 'locations', icon: '🏢', label: 'Locations', blurb: 'Warehouses, the stores they supply, and the tills at each store', min: 'admin' },
  // Beside Users & Access because they are two halves of accountability: one says
  // who may do what, the other what they did.
  { key: 'audit', icon: '📝', label: 'Audit Trail', blurb: 'Who did what, when and in which warehouse', min: 'admin' },
  { key: 'users', icon: '👤', label: 'Users & Access', blurb: 'Who can sign in, and how much of this they see', min: 'superadmin' },
]

// ==========================================================================
//  Store — the retail side, mounted at /pos
//  ------------------------------------------------------------------------
//  The URL stays /pos because it is the shop app's own mount point and its
//  cookies and links are written against it; only what people READ says Store.
//
//  The store is a finished Flask app with its own database and
//  its own login. It is served by this same backend, at this same origin, and
//  shown here in a frame — not rewritten screen by screen into React. Same
//  origin is the load-bearing part: on a second port its login cookie would be
//  third-party inside the frame and the browser would drop it.
//
//  It sits beside Warehouse rather than inside it because it is the other half
//  of the business, not a twelfth warehouse screen: the warehouse receives
//  goods, the shop sells them. Its screens are listed here for the same reason
//  the warehouse's are — so the way in is the menu, not a tour of the frame's
//  own navigation.
// ==========================================================================

// "Store", not "POS". A till is what the software is; a STORE is what the place
// is, and it is the word the warehouse already uses for these rows
// (models.Store, the Locations screen, the branch a consignment is forwarded
// to). Calling the same place two names in two menus is how somebody comes to
// believe they are two things.
const POS_HOME = { key: 'pos:home', icon: '🏠', label: 'Store Dashboard', path: '/',
  blurb: "Today's sales, low stock and the last few bills" }

// In the shop's own order — the same sequence as the navigation inside the
// frame, so choosing a screen here and then moving around in there does not feel
// like two different products. A sale goes left to right: build it on the floor
// or at the counter, look it up afterwards, take it back, alter it.
//  KEEP THIS IN STEP WITH THE SHOP'S OWN app/modules.py. A screen added there
//  and not here exists, works, and is reachable from inside the frame — and is
//  invisible to anybody who navigates from out here, which is nearly everybody.
//  Four of them had drifted out of this list that way, the Physical Stock Audit
//  among them; `pos_screens_test.py` in backend/tools now fails when the two
//  disagree, so the next one cannot go missing quietly.
const POS_SCREENS = [
  { key: 'pos:floor', icon: '📱', label: 'Floor Sales', path: '/floor/',
    blurb: 'Build a sale on the phone while walking the floor' },
  { key: 'pos:counter', icon: '🧮', label: 'Billing Counter', path: '/pos/',
    blurb: 'Scan, bill and take payment at the counter' },
  { key: 'pos:delivery', icon: '🛍', label: 'Delivery', path: '/delivery/',
    blurb: 'Scan the bill, scan each garment, hand the goods over' },
  { key: 'pos:inventory', icon: '📦', label: 'Store Stock', path: '/inventory/',
    blurb: 'What is on the store floor, with the warehouse QR on every item' },
  { key: 'pos:audits', icon: '📋', label: 'Physical Stock Audit', path: '/audits/',
    blurb: 'Count a store floor item by item and see where the books disagree' },
  { key: 'pos:checker', icon: '🔍', label: 'Stock Check', path: '/stock-check/',
    blurb: 'Scan or filter to find an item and where it is' },
  { key: 'pos:customers', icon: '🧍', label: 'Customers', path: '/customers/',
    blurb: 'Customer master, loyalty points and history' },
  { key: 'pos:invoices', icon: '🧾', label: 'Invoices', path: '/pos/invoices',
    blurb: 'Every bill raised, searchable and reprintable' },
  { key: 'pos:returns', icon: '↩️', label: 'Returns', path: '/returns/',
    blurb: 'Take goods back against a bill and raise a credit note' },
  { key: 'pos:alterations', icon: '✂️', label: 'Alteration', path: '/alterations/',
    blurb: 'Garments out for tailoring, and what each tailor is holding' },
  { key: 'pos:stores', icon: '🏬', label: 'Floors & Tills', path: '/stores/',
    blurb: 'Which storey each till bills from, and what its bills are called' },
  { key: 'pos:promotions', icon: '🎁', label: 'Promotions', path: '/promotions/',
    blurb: 'Offers the till applies by itself, and what they have given away' },
  { key: 'pos:staff', icon: '👥', label: 'Staff', path: '/staff/',
    blurb: 'Attendance, roles and sales commission' },
  { key: 'pos:reports', icon: '📈', label: 'Store Reports', path: '/reports/',
    blurb: 'Sales, tax and low-stock registers' },
]

const POS_ITEMS = [POS_HOME, null, ...POS_SCREENS]

// A Store USER (Users & Access → Store / POS) gets these two and nothing else —
// not the Store Dashboard either, which is the store's takings at a glance. The
// shop refuses every other screen itself (its app/modules.py, told by the /pos
// mount), so this is the menu agreeing with the server, not the enforcement.
const POS_USER_KEYS = new Set(['pos:counter', 'pos:reports'])

// One frame, keyed on the path so choosing another screen from the menu loads
// it rather than leaving the frame on whatever it had drifted to.
function PosScreen({ screen, available, error, warehouse: wh }) {
  if (available === false) return (
    <div className="empty" style={{ margin: 40, maxWidth: 620 }}>
      <p><b>The POS module is not loaded.</b></p>
      <p className="small">{error || 'The server started without it.'}</p>
      <p className="small">It lives in the <b>Textile Retail Shop</b> folder beside this
        project. Install the backend requirements (<code>pip install -r requirements.txt</code>)
        and restart the server.</p>
    </div>
  )
  // `wh` scopes the till to the warehouse this frame was opened from: the shop
  // remembers it and offers only the branches that warehouse supplies. Sent as a
  // query parameter because a frame cannot carry a header, and only on the first
  // load of each screen — the shop keeps it in its own session from there.
  const src = '/pos' + screen.path
    + (wh?.id ? (screen.path.includes('?') ? '&' : '?') + 'wh=' + wh.id : '')
  return (
    <div className="posframe">
      <iframe key={screen.path + ':' + (wh?.id || '')} src={src}
        title={'POS — ' + screen.label} />
    </div>
  )
}

// The Store Dashboard, kept loaded. Every other screen of the shop is a frame
// that loads when it is opened; this one is switched to and from all day, so it
// is mounted OUTSIDE the per-warehouse remount (see the shell) and only hidden
// when somebody looks elsewhere — going to the Central Dashboard and back into
// the same warehouse finds it already drawn. While hidden it is re-read every
// two minutes, so what it shows on the switch is never older than that.
function StoreHomeFrame({ shown, available, error, warehouse: wh }) {
  const box = useRef(null)
  const shownRef = useRef(shown)
  shownRef.current = shown
  useEffect(() => {
    const t = setInterval(() => {
      if (shownRef.current || document.visibilityState === 'hidden') return
      // Same origin (/pos is mounted on this server), so the frame can be
      // told to reload; a frame that has wandered off-site is left alone.
      try { box.current?.querySelector('iframe')?.contentWindow?.location.reload() }
      catch { /* not ours to reload */ }
    }, 2 * 60 * 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="tabpane" hidden={!shown} ref={box}>
      <PosScreen screen={POS_HOME} available={available} error={error} warehouse={wh} />
    </div>
  )
}

// ==========================================================================
//  The shell's own pieces — icons, the sidebar, the jump-to-screen palette
//  ------------------------------------------------------------------------
//  Line icons drawn inline (24px grid, 2px stroke) rather than a dependency:
//  the shell needs forty of them, and a package several times the size of this
//  set is not worth it for the chrome.
// ==========================================================================
const ICONS = {
  dashboard: <><rect width="7" height="9" x="3" y="3" rx="1" /><rect width="7" height="5" x="14" y="3" rx="1" /><rect width="7" height="9" x="14" y="12" rx="1" /><rect width="7" height="5" x="3" y="16" rx="1" /></>,
  grid: <><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></>,
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  spreadsheet: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M8 13h2M14 13h2M8 17h2M14 17h2" /></>,
  filetext: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8M16 13H8M16 17H8" /></>,
  pin: <><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
  usercheck: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="m16 11 2 2 4-4" /></>,
  cart: <><circle cx="8" cy="21" r="1" /><circle cx="19" cy="21" r="1" /><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" /></>,
  truck: <><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" /><circle cx="17" cy="18" r="2" /><circle cx="7" cy="18" r="2" /></>,
  clipcheck: <><rect width="8" height="4" x="8" y="2" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" /></>,
  boxes: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></>,
  shield: <><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></>,
  calc: <><rect width="16" height="20" x="4" y="2" rx="2" /><path d="M8 6h8M16 14v4M16 10h.01M12 10h.01M8 10h.01M12 14h.01M8 14h.01M12 18h.01M8 18h.01" /></>,
  tag: <><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r="1" /></>,
  octagon: <><path d="M12 16h.01M12 8v4" /><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z" /></>,
  qr: <><rect width="5" height="5" x="3" y="3" rx="1" /><rect width="5" height="5" x="16" y="3" rx="1" /><rect width="5" height="5" x="3" y="16" rx="1" /><path d="M21 16h-3a2 2 0 0 0-2 2v3M21 21v.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 16v.01M16 12h1M21 12v.01M12 21v-1" /></>,
  printer: <><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" /><rect x="6" y="14" width="12" height="8" rx="1" /></>,
  outward: <path d="m18 9-6-6-6 6M12 3v14M5 21h14" />,
  inward: <path d="M12 17V3M6 11l6 6 6-6M19 21H5" />,
  undo: <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>,
  rupee: <path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3M9 13c6.667 0 6.667-10 0-10" />,
  factory: <><path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" /><path d="M17 18h1M12 18h1M7 18h1" /></>,
  sliders: <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />,
  book: <><path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /></>,
  building: <><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" /><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4" /></>,
  store: <><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" /><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4M2 7h20M22 7v3a2 2 0 0 1-2 2 2.7 2.7 0 0 1-2-1 2.7 2.7 0 0 1-2 1 2.7 2.7 0 0 1-2-1 2.7 2.7 0 0 1-2 1 2.7 2.7 0 0 1-2-1 2.7 2.7 0 0 1-2 1 2.7 2.7 0 0 1-2-1 2.7 2.7 0 0 1-2 1 2 2 0 0 1-2-2V7" /></>,
  trending: <path d="M22 7 13.5 15.5 8.5 10.5 2 17M16 7h6v6" />,
  card: <><rect width="20" height="14" x="2" y="5" rx="2" /><path d="M2 10h20" /></>,
  receipt: <><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" /><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 17.5v-11" /></>,
  scissors: <><circle cx="6" cy="6" r="3" /><path d="M8.12 8.12 12 12M20 4 8.12 15.88" /><circle cx="6" cy="18" r="3" /><path d="M14.8 14.8 20 20" /></>,
  layers: <><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" /><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" /></>,
  percent: <><path d="M19 5 5 19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  pencil: <><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></>,
  trash: <><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><path d="M10 11v6M14 11v6" /></>,
  panelClose: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18M16 15l-3-3 3-3" /></>,
  panelOpen: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18M14 9l3 3-3 3" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  menu: <path d="M4 12h16M4 6h16M4 18h16" />,
  bell: <><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></>,
  eye: <><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" /></>,
  cpu: <><rect width="16" height="16" x="4" y="4" rx="2" /><rect width="6" height="6" x="9" y="9" rx="1" /><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5M12 3v12" /></>,
  plus: <path d="M5 12h14M12 5v14" />,
  compass: <><circle cx="12" cy="12" r="10" /><path d="m16.24 7.76-1.8 5.41a2 2 0 0 1-1.27 1.27L7.76 16.24l1.8-5.41a2 2 0 0 1 1.27-1.27z" /></>,
  history: <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5M12 7v5l3.5 2" /></>,
  sparkle: <><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="3" /></>,
}

function Icon({ name, size = 16, className }) {
  return (
    <svg className={'ico-svg' + (className ? ' ' + className : '')} width={size} height={size}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name] || ICONS.dashboard}
    </svg>
  )
}

// Which mark each screen wears in the sidebar, the palette and the module cards.
const NAV_ICON = {
  command: 'compass', audit: 'history',
  central: 'dashboard', dashboard: 'dashboard', pickwh: 'building',
  purchase_orders: 'cart', lr: 'truck', documents: 'filetext', purchases: 'clipcheck',
  inventory: 'boxes', locator: 'search', stock_audit: 'shield', physical_audit: 'calc',
  pricing: 'tag', deadstock: 'octagon', labels: 'qr', labelprint: 'printer',
  outward: 'outward', inward: 'inward', returns: 'undo', payments: 'rupee',
  reports: 'spreadsheet', suppliers: 'factory', masters: 'sliders', catalogues: 'book',
  locations: 'pin', users: 'users',
  'pos:home': 'dashboard', 'pos:floor': 'trending', 'pos:counter': 'card',
  'pos:delivery': 'truck', 'pos:inventory': 'boxes', 'pos:audits': 'clipcheck',
  'pos:checker': 'search', 'pos:customers': 'usercheck', 'pos:invoices': 'receipt',
  'pos:returns': 'undo', 'pos:alterations': 'scissors', 'pos:stores': 'layers',
  'pos:promotions': 'percent', 'pos:staff': 'users', 'pos:reports': 'spreadsheet',
  'ws:central': 'grid', 'ws:warehouse': 'building', 'ws:store': 'store',
}

// Two letters for the avatar: the initials of a two-word name, or the first two
// letters of a one-word login.
const initialsOf = (u) => {
  const words = String(u || '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  if (!words.length) return '?'
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase()
}

// A rule is only worth drawing BETWEEN two groups — never first, last or twice.
const tidyRules = (items) => items.filter((m, i, a) =>
  m || (i > 0 && i < a.length - 1 && a[i - 1] && a.slice(i + 1).some(Boolean)))

// The navigation. It lists the screens of the altitude you are standing at —
// the company, one warehouse, or that warehouse's store — and marks the one that
// is open, so where you are is on screen whether or not you are looking for it.
// `items` may hold a null, which draws a rule between the dashboard and the
// modules it leads into.
//
// Drawn twice from the same list: fixed beside the screen on a wide window, and
// as a slide-out drawer behind the header's menu button on a narrow one.
//
// The fixed one minimizes to a rail of icons rather than disappearing: every
// screen is still one click away, the open one is still marked, and the way back
// out is the button at the top of the rail. Folded, each icon's tooltip carries the
// name that is no longer on screen. Remembered across reloads through the
// same store the other panels use (useMinimized), so someone who works with it
// folded finds it folded every morning.
function NavSidebar({ kind, context, items, tab, go, online, foot, drawer, onClose }) {
  const [wide, toggleWide] = useMinimized('nav.sidebar', true)
  const mini = !drawer && !wide
  useEffect(() => {
    if (!drawer) return
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [drawer, onClose])

  const panel = (
    <aside className={'navside' + (drawer ? '' : ' fixed') + (mini ? ' folded' : '')}
      role={drawer ? 'dialog' : undefined} aria-modal={drawer ? 'true' : undefined}
      aria-label={drawer ? 'Navigation menu' : undefined}>
      {drawer && (
        <div className="navdrawer-head">
          <div className="th-brand">
            <span className="th-logo" aria-hidden="true">E</span>
            <div className="brand">Essa <span>· ERP</span><small style={{ display: 'block' }}>{kind}</small></div>
          </div>
          <button className="th-icon" onClick={onClose} aria-label="Close navigation menu">
            <Icon name="x" size={20} /></button>
        </div>
      )}
      <div className="navside-head">
        {!mini && (
          <div className="navside-headtx">
            <div className="navside-kind">{drawer ? 'Active context' : kind}</div>
            <div className="navside-ctx" title={context}>{context}</div>
          </div>
        )}
        {!drawer && (
          <button className="navside-toggle" onClick={toggleWide} aria-expanded={wide}
            title={wide ? 'Minimize the menu to icons — the screen gets the room'
              : `Show the full menu (${kind} · ${context})`}
            aria-label={wide ? 'Minimize the menu' : 'Show the full menu'}>
            <Icon name={wide ? 'panelClose' : 'panelOpen'} size={16} />
          </button>
        )}
      </div>
      <nav className="navside-list" aria-label={kind}>
        {tidyRules(items).map((m, i) => (m ? (
          <button key={m.key} className={'navitem' + (m.key === tab ? ' on' : '')}
            title={mini ? (m.blurb ? `${m.label} — ${m.blurb}` : m.label) : m.blurb}
            aria-current={m.key === tab ? 'page' : undefined}
            onClick={() => { go(m.key); if (drawer) onClose() }}>
            <Icon name={NAV_ICON[m.key]} />
            <span className="nm">{m.label}</span>
            {m.badge && <span className="nb">{m.badge}</span>}
          </button>
        ) : <div key={'sep' + i} className="navsep" role="separator" />))}
      </nav>
      <div className="navside-foot">
        <span className={'live' + (online ? '' : ' off')}
          title={online ? 'Server connected' : 'Connecting…'}><i aria-hidden="true" />
          <span className="lbl">{online ? 'Server connected' : 'Connecting…'}</span></span>
        <span className="ver">{foot}</span>
      </div>
    </aside>
  )
  if (!drawer) return panel
  return (
    <div className="navdrawer">
      <div className="navdrawer-back" onClick={onClose} aria-hidden="true" />
      {panel}
    </div>
  )
}

// Ctrl+K from anywhere: type part of a screen's name and press Enter. It only
// offers screens this account can already reach from the sidebar — it is a
// faster way through the same doors, never a way round them.
function JumpPalette({ groups, onGo, onClose }) {
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const s = q.trim().toLowerCase()
  const shown = groups
    .map((g) => ({ ...g, items: g.items.filter((m) => !s
      || String(m.label).toLowerCase().includes(s)
      || String(m.blurb || '').toLowerCase().includes(s)) }))
    .filter((g) => g.items.length)
  const flat = shown.flatMap((g) => g.items)
  useEffect(() => { setHi(0) }, [s])
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(flat.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)) }
    else if (e.key === 'Enter' && flat[hi]) { e.preventDefault(); onGo(flat[hi].key) }
  }
  let n = -1
  return (
    <div className="jump-back" onMouseDown={onClose}>
      <div className="jump" role="dialog" aria-modal="true" aria-label="Jump to a screen"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="jump-in">
          <Icon name="search" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key}
            placeholder="Jump to a screen…" aria-label="Screen name" />
          <kbd>Esc</kbd>
        </div>
        <div className="jump-list">
          {!flat.length && <div className="jump-empty">No screen matches “{q}”.</div>}
          {shown.map((g) => (
            <div key={g.title}>
              <div className="jump-group">{g.title}</div>
              {g.items.map((m) => {
                n += 1
                const i = n
                return (
                  <button key={g.title + m.key} className={'jump-item' + (i === hi ? ' hi' : '')}
                    onMouseEnter={() => setHi(i)} onClick={() => onGo(m.key)}>
                    <Icon name={NAV_ICON[m.key]} />
                    <span className="tx">{m.label}{m.blurb && <span className="bl">{m.blurb}</span>}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ==========================================================================
//  Charts
//  ------------------------------------------------------------------------
//  Hand-drawn SVG rather than a charting library. Five chart types on one
//  screen do not justify a dependency several times the size of this entire
//  bundle, and the specs below — 2px lines, ≤24px bars with a 4px rounded
//  data-end, a 2px surface gap between touching marks, hairline solid grid —
//  are easier to hold exactly when they are written out than when they are
//  configured through someone else's theme object.
//
//  Fixed rules these all keep:
//    * The form is chosen by the data's job, not by variety. One series over
//      time is a line; two series compared is grouped columns; magnitude across
//      names is bars in ONE colour (colouring those by value would encode the
//      bar length twice and waste the only free channel); an ordered band is one
//      hue getting darker; part-to-whole with few slices is a ring.
//    * Never two y-scales on one plot. Two measures of different size are two
//      charts.
//    * Text never wears the series colour — a swatch beside the label carries
//      identity, so a pale hue is never asked to be legible as type.
//    * Every chart has a table twin. A value that only exists inside a tooltip
//      is a value someone cannot read, print or check.
// ==========================================================================

const VB = { w: 620, h: 240 }                    // viewBox; charts scale to their cell
const PAD = { t: 16, r: 16, b: 34, l: 58 }       // bottom band sized to hold the x labels
const PLOT = { w: VB.w - PAD.l - PAD.r, h: VB.h - PAD.t - PAD.b }
const VIZ = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)']
const SEQ = 'var(--viz-2)'                       // single-series / sequential default

// Axis ticks land on clean numbers — a gridline at 83,417 is a gridline nobody
// reads a value off.
const niceTicks = (max, count = 4) => {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].find((m) => mag * m >= raw) * mag
  const out = []
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v)
  return out
}
const compact = (v) => {
  const n = Math.abs(v)
  if (n >= 1e7) return (v / 1e7).toFixed(n >= 1e8 ? 0 : 1) + 'Cr'
  if (n >= 1e5) return (v / 1e5).toFixed(n >= 1e6 ? 0 : 1) + 'L'
  if (n >= 1000) return (v / 1000).toFixed(n >= 1e4 ? 0 : 1) + 'k'
  return String(Math.round(v * 100) / 100)
}

// The frame every plotted chart shares: hairline solid gridlines (never dashed —
// dashing reads as "projection" when it is just a grid), clean ticks, and axis
// text in the muted ink rather than in any series colour.
function Grid({ ticks, max }) {
  return (
    <g>
      {ticks.map((t) => {
        const y = PAD.t + PLOT.h - (max ? (t / max) * PLOT.h : 0)
        return (
          <g key={t}>
            <line x1={PAD.l} x2={PAD.l + PLOT.w} y1={y} y2={y}
              stroke="var(--viz-grid)" strokeWidth="1" />
            <text x={PAD.l - 8} y={y + 3.5} textAnchor="end" className="viztick">{compact(t)}</text>
          </g>
        )
      })}
    </g>
  )
}

// x labels thin out rather than overlap — a collided axis is unreadable, and
// every value is still in the tooltip and the table.
const everyNth = (n, keep = 6) => Math.max(1, Math.ceil(n / keep))

function ChartCard({ title, note, legend, rows, columns, children }) {
  const [table, setTable] = useState(false)
  return (
    <div className="vizcard">
      {/* Title and the table switch hold the first row on their own; the legend
          takes its own line below. Sharing one row made the switch wrap under the
          legend on the cards that have one, so the control sat in a different
          place on different cards. */}
      <div className="vizhead">
        <h5>{title}</h5>
        <span className="spacer" />
        <button className="vizswap" onClick={() => setTable((t) => !t)}
          title={table ? 'Back to the chart' : 'Show these numbers as a table'}>
          {table ? 'Chart' : 'Table'}
        </button>
      </div>
      {legend && <div className="vizlegendrow">{legend}</div>}
      {note && <div className="viznote">{note}</div>}
      {/* The table twin is the same numbers, not a summary of them — so a value
          is never reachable only by hovering. */}
      {table ? (
        <div className="vizscroll">
          <table className="items">
            <thead><tr>{columns.map((c) => <th key={c} className={c === columns[0] ? '' : 'num'}>{c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i}>{r.map((cell, j) => (
                <td key={j} className={j ? 'num mono' : ''}>{cell}</td>
              ))}</tr>
            ))}</tbody>
          </table>
        </div>
      ) : children}
    </div>
  )
}

function Legend({ items }) {
  return (
    <span className="vizlegend">
      {items.map((it) => (
        <span key={it.label} className="vizkey">
          <i style={{ background: it.color }} /> {it.label}
        </span>
      ))}
    </span>
  )
}

// Tooltip in HTML over the SVG rather than SVG text: it needs a background,
// padding and wrapping, all of which are free here and fiddly in SVG.
function VizTip({ at, children }) {
  if (!at) return null
  return (
    <div className="viztip" style={{ left: `${at.x}%`, top: `${at.y}%` }}>{children}</div>
  )
}

// ---- one series over time ----
function LineChart({ labels, values, unit, valueFmt }) {
  const [hover, setHover] = useState(null)
  const max = Math.max(...values, 0)
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1] || 1
  const x = (i) => PAD.l + (values.length === 1 ? PLOT.w / 2 : (i / (values.length - 1)) * PLOT.w)
  const y = (v) => PAD.t + PLOT.h - (v / top) * PLOT.h
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const nth = everyNth(labels.length)
  const peak = values.indexOf(max)
  const fmt = valueFmt || compact
  return (
    <div className="vizplot">
      <svg viewBox={`0 0 ${VB.w} ${VB.h}`} className="vizsvg" role="img"
        aria-label={`${unit} over ${labels.length} months`}>
        <Grid ticks={ticks} max={top} />
        {/* area wash at ~10%, never a saturated block */}
        <polygon fill={SEQ} fillOpacity="0.10"
          points={`${PAD.l},${PAD.t + PLOT.h} ${pts} ${PAD.l + PLOT.w},${PAD.t + PLOT.h}`} />
        <polyline points={pts} fill="none" stroke={SEQ} strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round" />
        {/* the peak is direct-labelled; every other value rides the axis and the
            tooltip, because a number on every point goes unread */}
        {max > 0 && (() => {
          // The label flips below the point when there is no room above it.
          // Drawn above unconditionally it escapes the plot and lands on the card
          // title — a label clipped by, or overflowing, its own chart.
          const above = y(max) - PAD.t > 16
          const lx = Math.min(Math.max(x(peak), PAD.l + 16), PAD.l + PLOT.w - 16)
          return (
            <g>
              <circle cx={x(peak)} cy={y(max)} r="4.5" fill={SEQ}
                stroke="var(--panel)" strokeWidth="2" />
              <text x={lx} y={y(max) + (above ? -10 : 18)} textAnchor="middle"
                className="vizlabel">{fmt(max)}</text>
            </g>
          )
        })()}
        {labels.map((l, i) => i % nth === 0 && (
          <text key={l} x={x(i)} y={VB.h - 12} textAnchor="middle" className="viztick">{l}</text>
        ))}
        {/* hit bands are the full plot height and far wider than the 2px line */}
        {labels.map((l, i) => (
          <rect key={'h' + i} x={x(i) - PLOT.w / (labels.length * 2)} y={PAD.t}
            width={PLOT.w / labels.length} height={PLOT.h} fill="transparent"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
        {hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + PLOT.h}
              stroke="var(--viz-axis)" strokeWidth="1" />
            <circle cx={x(hover)} cy={y(values[hover])} r="4.5" fill={SEQ}
              stroke="var(--panel)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover != null && (
        <VizTip at={{ x: (x(hover) / VB.w) * 100, y: (y(values[hover]) / VB.h) * 100 }}>
          <b>{labels[hover]}</b><br />{fmt(values[hover])} {unit}
        </VizTip>
      )}
    </div>
  )
}

// ---- two series compared over time ----
function GroupedBars({ labels, series, unit }) {
  const [hover, setHover] = useState(null)
  const max = Math.max(...series.flatMap((s) => s.values), 0)
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1] || 1
  const band = PLOT.w / labels.length
  const GAP = 2                                   // the surface gap between neighbours
  const bw = Math.min(24, (band - 14 - GAP) / series.length)
  const nth = everyNth(labels.length)
  return (
    <div className="vizplot">
      <svg viewBox={`0 0 ${VB.w} ${VB.h}`} className="vizsvg" role="img"
        aria-label={`${series.map((s) => s.name).join(' and ')} by month`}>
        <Grid ticks={ticks} max={top} />
        {labels.map((l, i) => {
          const groupW = bw * series.length + GAP * (series.length - 1)
          const x0 = PAD.l + band * i + (band - groupW) / 2
          return (
            <g key={l}>
              {series.map((s, si) => {
                const v = s.values[i] || 0
                const h = (v / top) * PLOT.h
                const bx = x0 + si * (bw + GAP)
                return v > 0 ? (
                  // rounded at the data end, square at the baseline
                  <path key={s.name} fill={VIZ[si]} d={roundedTop(bx, PAD.t + PLOT.h - h, bw, h, 4)} />
                ) : null
              })}
              <rect x={PAD.l + band * i} y={PAD.t} width={band} height={PLOT.h} fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            </g>
          )
        })}
        {labels.map((l, i) => i % nth === 0 && (
          <text key={l} x={PAD.l + band * i + band / 2} y={VB.h - 12} textAnchor="middle"
            className="viztick">{l}</text>
        ))}
      </svg>
      {hover != null && (
        <VizTip at={{ x: ((PAD.l + band * hover + band / 2) / VB.w) * 100, y: 8 }}>
          <b>{labels[hover]}</b>
          {series.map((s, si) => (
            <div key={s.name}><i className="tipkey" style={{ background: VIZ[si] }} />
              {s.name}: {compact(s.values[hover] || 0)} {unit}</div>
          ))}
        </VizTip>
      )}
    </div>
  )
}

// A bar rounded on the data end only — square where it meets the baseline, so
// the bar reads as growing from the axis rather than floating.
const roundedTop = (x, y, w, h, r) => {
  const rr = Math.min(r, h, w / 2)
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} `
    + `L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`
}

// ---- magnitude across names: one colour for every bar ----
function HBars({ rows, unit, ordinal }) {
  const [hover, setHover] = useState(null)
  const max = Math.max(...rows.map((r) => r.value), 0) || 1
  const H = Math.max(120, rows.length * 34 + 20)
  const LW = 140                                  // room for the name
  const barW = VB.w - LW - 80
  const ORD = ['var(--viz-ord-1)', 'var(--viz-ord-2)', 'var(--viz-ord-3)', 'var(--viz-ord-4)']
  return (
    <div className="vizplot">
      <svg viewBox={`0 0 ${VB.w} ${H}`} className="vizsvg" role="img" aria-label={unit}>
        {rows.map((r, i) => {
          const y = 12 + i * 34
          const w = Math.max(2, (r.value / max) * barW)
          // ordinal = an ordered scale (ageing bands), so one hue gets darker.
          // Otherwise every bar is slot-1 blue: these names have no order, and
          // shading them by value would encode the length twice.
          const fill = ordinal ? ORD[Math.min(i, ORD.length - 1)] : SEQ
          return (
            <g key={r.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <text x={LW - 10} y={y + 15} textAnchor="end" className="vizname">{r.label}</text>
              <path fill={fill} d={roundedRight(LW, y, w, 20, 4)} />
              <text x={LW + w + 8} y={y + 15} className="vizlabel">{compact(r.value)}</text>
              <rect x={0} y={y - 6} width={VB.w} height={32} fill="transparent" />
            </g>
          )
        })}
      </svg>
      {hover != null && (
        <VizTip at={{ x: 50, y: ((12 + hover * 34) / H) * 100 }}>
          <b>{rows[hover].label}</b><br />{compact(rows[hover].value)} {unit}
          {rows[hover].bills != null && <> · {rows[hover].bills} bill(s)</>}
        </VizTip>
      )}
    </div>
  )
}

const roundedRight = (x, y, w, h, r) => {
  const rr = Math.min(r, w, h / 2)
  return `M${x},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} `
    + `L${x + w},${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} L${x},${y + h} Z`
}

// ---- part-to-whole, at a glance ----
// A ring is only honest for a few slices read as shares, so the tail is folded
// into one neutral "Other" rather than spawning more hues — and the fold is
// counted in its label so the ring still visibly totals the whole.
function Donut({ rows, unit }) {
  const [hover, setHover] = useState(null)
  const total = rows.reduce((a, r) => a + r.value, 0) || 1
  const R = 82, r0 = 50, cx = 110, cy = 110
  let angle = -Math.PI / 2
  const arcs = rows.map((row, i) => {
    const frac = row.value / total
    const a0 = angle
    const a1 = angle + frac * Math.PI * 2
    angle = a1
    // a 2px gap in the surface separates touching segments — no stroke around
    // the mark, which would add ink that is not data
    const gap = rows.length > 1 ? 0.012 : 0
    return { row, i, a0: a0 + gap, a1: Math.max(a0 + gap, a1 - gap), frac }
  })
  const arcPath = (a0, a1) => {
    const big = a1 - a0 > Math.PI ? 1 : 0
    const p = (a, rad) => `${cx + Math.cos(a) * rad},${cy + Math.sin(a) * rad}`
    return `M${p(a0, R)} A${R},${R} 0 ${big} 1 ${p(a1, R)} L${p(a1, r0)} A${r0},${r0} 0 ${big} 0 ${p(a0, r0)} Z`
  }
  return (
    <div className="vizplot donut">
      <svg viewBox="0 0 620 224" className="vizsvg" role="img" aria-label={unit}>
        {arcs.map(({ row, i, a0, a1 }) => (
          <path key={row.label} d={arcPath(a0, a1)}
            fill={row.other ? 'var(--viz-other)' : VIZ[i % VIZ.length]}
            opacity={hover == null || hover === i ? 1 : 0.45}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
        {/* the whole, in the hole */}
        <text x={cx} y={cy - 2} textAnchor="middle" className="vizhero">{compact(total)}</text>
        <text x={cx} y={cy + 16} textAnchor="middle" className="viztick">{unit}</text>
        {/* labels sit outside the ring in ink, never in the slice colour */}
        {arcs.map(({ row, i, frac }) => (
          <g key={'l' + row.label} transform={`translate(238, ${18 + i * 30})`}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect x="-6" y="-12" width="380" height="26" fill="transparent" />
            <rect x="0" y="-7" width="12" height="12" rx="3"
              fill={row.other ? 'var(--viz-other)' : VIZ[i % VIZ.length]} />
            <text x="20" y="3" className="vizname">{row.label}</text>
            <text x="330" y="3" textAnchor="end" className="vizlabel">
              {compact(row.value)} · {(frac * 100).toFixed(frac < 0.01 ? 2 : 0)}%
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// A figure and the screen that clears it. `tone` is 'warn' only when there is
// something to do — a tile that shouts at zero teaches people to ignore it.
// `accent` is what the figure is ABOUT and never changes; `tone` is how it is
// DOING and changes with the data. They are separate props because those are
// separate questions: a tile counting money stays green whatever the number, and
// goes amber only when that number needs somebody. Both land as classes, and the
// CSS orders `.warn` after the families so attention always wins.
//
// Families: count · stock · move · money · back · adjust. What each means, and
// why amber is deliberately not among them, is in the tile accent block in
// styles.css.
function DashTile({ label, value, sub, tone, accent, hint, onClick }) {
  return (
    <button className={'dtile' + (accent ? ' t-' + accent : '') + (tone ? ' ' + tone : '')}
      onClick={onClick} title={hint || `Open ${label}`}>
      <span className="lbl">{label}</span>
      <span className={'val' + (longValue(value) ? ' long' : '')}>{value}</span>
      <span className="sub">{sub || ' '}</span>
    </button>
  )
}

const sum = (rows, f) => rows.reduce((a, r) => a + (+f(r) || 0), 0)

// The graphical half. Kept in its own component so its data is fetched only when
// someone actually opens it — the aggregation walks every product and movement,
// and the static view has no use for it.
function DashboardCharts({ money }) {
  // Held in the dashboard cache with the figures, per warehouse.
  const wh = warehouse.get()?.id
  const cq = useCached(DASH.charts(wh).key, () => DASH.charts(wh).read())
  const c = cq.data || null
  const e = cq.error
  // Only when there is nothing to draw: charts already held stay up through a
  // failed refresh, the way the figures do.
  const err = c || !e ? ''
    // The frontend is read off disk and refreshes with the browser, but routes
    // are registered when Python starts. A backend left running from before
    // this endpoint existed serves the new screen and 404s its calls — a
    // restart, not a fault, and a bare "404" sends someone hunting the wrong thing.
    : (e.status === 404 || e.status === 405)
      ? 'the server is still running the code from before the charts were added — '
        + 'restart the backend (Ctrl-C in the run window, then run.bat again) and reload this page'
      : `${e.message || 'the request failed'} — the figures on the static view are unaffected`

  if (err) return <div className="warnbox"><h4>The charts could not be loaded</h4>
    <div className="small" style={{ color: 'var(--text-2)' }}>{err}</div></div>
  if (!c) return <div className="empty" style={{ marginTop: 60 }}>Building the charts…</div>

  const mv = c.movement
  const hasAny = c.purchases.values.some((v) => v > 0) ||
    mv.series.some((s) => s.values.some((v) => v > 0)) || c.stock_by_category.length > 0
  if (!hasAny) return (
    <div className="empty" style={{ marginTop: 60 }}>Nothing to plot yet.</div>
  )

  return (
    <div className="vizgrid">
      <ChartCard title="Purchases per month"
        note="Posted receipts, on the invoice date rather than the day they were keyed."
        columns={['Month', 'Purchases (₹)']}
        rows={c.purchases.labels.map((l, i) => [l, money(c.purchases.values[i])])}>
        <LineChart labels={c.purchases.labels} values={c.purchases.values} unit="₹" />
      </ChartCard>

      <ChartCard title="Stock received and dispatched"
        note="Pieces moved per month. Both are counted positive so the two can be compared."
        legend={<Legend items={[{ label: mv.series[0].name, color: VIZ[0] },
                                { label: mv.series[1].name, color: VIZ[1] }]} />}
        columns={['Month', mv.series[0].name, mv.series[1].name]}
        rows={mv.labels.map((l, i) => [l, mv.series[0].values[i], mv.series[1].values[i]])}>
        <GroupedBars labels={mv.labels} series={mv.series} unit="pcs" />
      </ChartCard>

      <ChartCard title="Stock value by category"
        note="Only stock a posted GRN created — the same rule behind the Stock value tile, so the ring totals it."
        columns={['Category', 'Value (₹)']}
        rows={c.stock_by_category.map((r) => [r.label, money(r.value)])}>
        <Donut rows={c.stock_by_category} unit="₹ stock value" />
      </ChartCard>

      <ChartCard title="Top suppliers by purchase value"
        note="Posted receipts, all periods."
        columns={['Supplier', 'Purchases (₹)']}
        rows={c.top_suppliers.map((r) => [r.label, money(r.value)])}>
        <HBars rows={c.top_suppliers} unit="₹" />
      </ChartCard>

      <ChartCard title="Payables by age"
        note="What is owed, by how long it has been owed. An unreadable invoice date counts as oldest rather than being dropped, so this totals the payables tile."
        columns={['Age', 'Outstanding (₹)', 'Bills']}
        rows={c.payables_ageing.map((r) => [r.label, money(r.value), r.bills])}>
        <HBars rows={c.payables_ageing} unit="₹ outstanding" ordinal />
      </ChartCard>
    </div>
  )
}

// The dead-stock headline on the main dashboard: the alert, four KPIs, the ageing
// shape and whether clearance is working. Reads the module's OWN summary — one
// arithmetic, two screens, so the dashboard can never quote a figure the register
// disagrees with.
function DashDeadStock({ sum, open }) {
  const t = sum.totals, c = sum.counts, cash = sum.cash_impact
  const dead = c.dead_total
  const trend = sum.trend || []
  const bands = (sum.by_bucket || []).map((b) => ({ label: b.bucket, value: b.qty }))
  const critical = c.critical

  if (!dead.lines) {
    return (
      <Section id="dash-dead" title="Dead Stock & Clearance" summary="all clear">
        <div className="warnbox clean">
          <h4 style={{ border: 'none', margin: 0 }}>
            Nothing has been still for {c.thresholds.dead}+ days — every stocked line is moving.
          </h4>
          <div className="small" style={{ color: 'var(--text-2)', marginTop: 4 }}>
            {c.approaching.lines
              ? <>{c.approaching.lines} line(s) have been quiet for {c.thresholds.approaching}+ days and
                  will cross the line within a month. <button className="btn" style={{ padding: '2px 9px' }}
                    onClick={() => open({ tab: 'register', status: 'approaching' })}>See them</button></>
              : 'Nothing is approaching the line either.'}
          </div>
        </div>
      </Section>
    )
  }

  return (
    <Section id="dash-dead" title="Dead Stock & Clearance"
      summary={`${dead.lines} product line(s) · ${rupees(t.stock_value)} locked`}
      actions={<button className="btn primary" style={{ padding: '3px 11px' }}
        onClick={() => open({ tab: 'register', status: 'dead' })}>Review dead stock</button>}>

      {/* The notification management actually reads, with the two things they can
          do about it beside it rather than in another module's menu. */}
      <div className="warnbox" style={{ borderColor: 'var(--danger-line)', background: 'var(--danger-bg)', marginBottom: 14 }}>
        <h4 style={{ border: 'none', margin: 0, color: 'var(--danger)' }}>
          🔴 {dead.lines} product{dead.lines === 1 ? '' : 's'} have crossed {c.thresholds.dead} days without a sale
        </h4>
        <div className="small" style={{ color: 'var(--text-2)', marginTop: 4 }}>
          {rupees(t.stock_value)} of stock value requires clearance review
          {critical.lines ? <> · <b>{critical.lines}</b> of them unsold for {c.thresholds.critical}+ days</> : null}
          {sum.pos && !sum.pos.available
            ? <> · <b>the till is not readable here</b>, so these ages come from dispatches and receipts only</>
            : null}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn" onClick={() => open({ tab: 'register', status: 'dead' })}>Review dead stock</button>
          <button className="btn" onClick={() => open({ tab: 'worksheet' })}>Clearance worksheets</button>
          {critical.lines > 0 && (
            <button className="btn" onClick={() => open({ tab: 'register', status: 'critical' })}>
              {critical.lines} critical</button>
          )}
        </div>
      </div>

      <div className="dgrid">
        <DashTile label="Dead stock" value={dead.qty + ' pcs'} accent="stock" tone="warn"
          sub={`${t.skus} SKU${t.skus === 1 ? '' : 's'} with no sale for ${c.thresholds.dead}+ days`}
          hint="Open the Dead Stock Register"
          onClick={() => open({ tab: 'register', status: 'dead' })} />
        <DashTile label="Stock value" value={rupees(t.stock_value)} accent="money" tone="warn"
          sub="locked — capital sitting on the shelf"
          hint="Open the products holding it"
          onClick={() => open({ tab: 'register', status: 'dead' })} />
        <DashTile label="Clearance" value={rupees(t.expected_realisation)} accent="money"
          sub="expected at the ladder's prices"
          hint="Open the Clearance Worksheet"
          onClick={() => open({ tab: 'worksheet' })} />
        <DashTile label="Recovery" value={t.recovery_pct == null ? '—' : t.recovery_pct + '%'}
          accent="adjust" sub="expected cash against what it cost"
          hint="Open the Cash Impact"
          onClick={() => open({ tab: 'cash' })} />
        <DashTile label="Critical" value={critical.lines} accent="stock" tone={critical.lines ? 'warn' : ''}
          sub={critical.lines
            ? `unsold for ${c.thresholds.critical}+ days — ${rupees(critical.stock_value)}`
            : 'nothing past the critical line'}
          hint="Open the register filtered to the worst of it"
          onClick={() => open({ tab: 'register', status: 'critical' })} />
        <DashTile label="Approaching" value={c.approaching.lines} accent="stock"
          tone={c.approaching.lines ? 'warn' : ''}
          sub={c.approaching.lines
            ? `quiet ${c.thresholds.approaching}+ days — dead within a month`
            : 'nothing about to go dead'}
          hint="Open the register filtered to what is about to go dead"
          onClick={() => open({ tab: 'register', status: 'approaching' })} />
      </div>

      <div className="vizgrid" style={{ marginTop: 16 }}>
        <ChartCard title="Dead stock by age"
          note={`Pieces past ${c.thresholds.dead} days, by how long they have been still. One hue darkening, because the bands are an ordered scale.`}
          columns={['Age band', 'Pieces', 'Lines', 'Stock value', 'Expected']}
          rows={(sum.by_bucket || []).map((b) => [b.bucket, b.qty, b.lines,
            money(b.stock_value), money(b.expected_realisation)])}>
          {bands.length
            ? <HBars rows={bands} unit="pcs" ordinal />
            : <div className="empty" style={{ margin: '20px 0' }}>Nothing dead to band.</div>}
        </ChartCard>

        <ChartCard title="Clearance performance"
          note="What each month's worksheets promised against what the till has actually taken for those products, inside those dates. The gap is the shortfall, and it closes on its own as the goods sell."
          legend={<Legend items={[{ label: 'Expected', color: VIZ[0] },
                                  { label: 'Realised', color: VIZ[1] }]} />}
          columns={['Month', 'Campaigns', 'Expected', 'Realised', 'Realised %', 'Sell-through %']}
          rows={trend.map((r) => [r.month, r.campaigns, money(r.expected), money(r.actual),
            r.realisation_pct == null ? '—' : r.realisation_pct + '%',
            r.sell_through_pct == null ? '—' : r.sell_through_pct + '%'])}>
          {trend.length
            ? <GroupedBars labels={trend.map((r) => r.month)}
                series={[{ name: 'Expected', values: trend.map((r) => r.expected) },
                         { name: 'Realised', values: trend.map((r) => r.actual) }]} unit="₹" />
            : <div className="empty" style={{ margin: '20px 0', lineHeight: 1.6 }}>
                No clearance worksheet has been run yet — so there is nothing to judge.<br />
                <button className="btn" style={{ marginTop: 10 }}
                  onClick={() => open({ tab: 'register', status: 'dead' })}>Build the first one</button>
              </div>}
        </ChartCard>
      </div>
    </Section>
  )
}

function Dashboard({ modules, go, company, docs, refreshDocs, user, openDeadStock, here }) {
  // Which half is showing. Remembered, because someone who works from the charts
  // wants the charts every morning, not the tiles again.
  const [view, setViewState] = useState(() => {
    try { return localStorage.getItem('essa_dash_view') || 'static' } catch { return 'static' }
  })
  const setView = (v) => {
    setViewState(v)
    try { localStorage.setItem('essa_dash_view', v) } catch { /* private mode */ }
  }

  // The figures come out of the dashboard cache: leaving for the Store or the
  // Central Dashboard and coming back draws them at once, and they re-read
  // behind the screen. The read itself is readWarehouseDash, shared with the
  // shell's warm-up so both hold the same thing under the same key.
  const dq = useCached(DASH.warehouse(here?.id).key, () => DASH.warehouse(here?.id).read())
  const d = dq.data?.d || null
  const partial = !!dq.data?.partial
  const busy = dq.busy
  const load = () => dq.refresh().catch(() => {})

  if (!d) return <div className="empty" style={{ marginTop: 120 }}>Loading the dashboard…</div>

  const toReview = docs.filter((x) => x.status === 'needs_review').length
  const grnDrafts = d.grns.drafts || []
  const grnPostedCount = d.grns.posted || 0
  const shortLines = d.grns.short_lines || 0
  const shortValue = d.grns.short_value || 0
  const lrPending = d.lr.pending || 0
  const lrUnlinked = d.lr.unlinked || 0
  const payable = sum(d.bills, (b) => b.outstanding)
  const overdue = d.bills.filter((b) => (b.days || 0) > 30)
  const retDrafts = d.returns.filter((r) => r.status === 'draft').length
  const pendingDetail = d.stock.pending_detail || 0
  const transitQty = sum(d.transit, (o) => o.total_qty)
  // dead + critical: both are past the line, and a headline that left out the
  // worst rows would be the one figure nobody could reconcile against the module
  const notices = d.notifs?.notices || []
  const deadBands = notices.filter((n) => n.key === 'deadstock.dead' || n.key === 'deadstock.critical')
  const deadLines = sum(deadBands, (n) => n.count)
  const deadValue = sum(deadBands, (n) => n.value)
  const criticalLines = sum(notices.filter((n) => n.key === 'deadstock.critical'), (n) => n.count)

  const attention = [
    { key: 'documents', label: 'Invoices to review', value: toReview, tone: toReview ? 'warn' : '',
      accent: 'count',
      sub: toReview ? 'read, but something did not reconcile' : 'nothing waiting',
      hint: 'Open Invoice Entry — documents extracted but not yet confirmed' },
    { key: 'purchases', label: 'GRNs in draft', value: grnDrafts.length, tone: grnDrafts.length ? 'warn' : '',
      accent: 'count',
      sub: grnDrafts.length ? `₹ ${money(sum(grnDrafts, (g) => g.grand_total))} not yet in stock` : 'all receipts posted',
      hint: 'Open GRN — receipts counted but not posted, so the goods are not stock yet' },
    { key: 'inward', label: 'Transfers in transit', value: d.transit.length, tone: d.transit.length ? 'warn' : '',
      accent: 'move',
      sub: d.transit.length ? `${transitQty} pcs dispatched, not accepted` : 'nothing on the road',
      hint: 'Open Stock Inward — dispatched transfers no destination has checked in' },
    { key: 'lr', label: 'Consignments not received', value: lrPending, tone: lrPending ? 'warn' : '',
      accent: 'move',
      sub: lrPending ? 'in the register, not taken in' : 'register is clear',
      hint: 'Open LR Entry — consignments booked but nobody has signed for them' },
    { key: 'purchases', label: 'Open shortage claims', value: shortLines, tone: shortLines ? 'warn' : '',
      accent: 'back',
      sub: shortLines ? `₹ ${money(shortValue)} billed and not delivered` : 'no open claims',
      hint: 'Open GRN — goods billed that the boxes did not hold, not yet waived or claimed' },
    { key: 'payments', label: 'Payable to suppliers', value: '₹ ' + money(payable),
      tone: overdue.length ? 'warn' : '', accent: 'money',
      sub: d.bills.length ? `${d.bills.length} bill${d.bills.length === 1 ? '' : 's'}${overdue.length ? ` · ${overdue.length} over 30 days` : ''}` : 'nothing outstanding',
      hint: 'Open Payments — unpaid supplier invoices' },
    { key: 'deadstock', label: 'Dead stock', value: deadLines,
      tone: deadLines ? 'warn' : '', accent: 'stock',
      sub: deadLines
        ? `₹ ${money(deadValue)} of capital asleep${criticalLines ? ` · ${criticalLines} line(s) critical` : ''}`
        : 'every stocked line is still moving',
      hint: 'Open Dead Stock & Clearance — products with no sale inside the window' },
  ]
  const open = attention.filter((a) => a.tone === 'warn').length

  const recentDocs = docs.slice(0, 6)
  const recentGrns = d.grns.recent || []

  return (
    <div className="screen scrolls">
      <div className="pagehead">
        <h2>{here?.code && <span className="codechip">{here.code}</span>}
          {here?.name || 'Dashboard'}</h2>
        <div className="pagesub small">
          {here ? 'Warehouse dashboard' : (company || 'Essa')} — {open
            ? `${open} thing${open === 1 ? '' : 's'} waiting on someone`
            : 'nothing is waiting — every queue is clear'}
        </div>
        {/* Two ways of reading the same warehouse: the figures, or their shape
            over time. A segmented control rather than tabs — it is one thing
            with two states, not two screens. */}
        <div className="segbar" role="tablist" aria-label="Dashboard view">
          <button role="tab" aria-selected={view === 'static'}
            className={'seg' + (view === 'static' ? ' on' : '')} onClick={() => setView('static')}
            title="Figures, counts and what is waiting on someone">▦ Figures</button>
          <button role="tab" aria-selected={view === 'graphical'}
            className={'seg' + (view === 'graphical' ? ' on' : '')} onClick={() => setView('graphical')}
            title="The same warehouse as trends and shares over time">📈 Charts</button>
        </div>
        <button className="btn" onClick={() => { refreshDocs(); load() }} disabled={busy}
          title="Re-read every figure on this screen">{busy ? 'Refreshing…' : '↻ Refresh'}</button>
      </div>

      <div className="dash">
        {view === 'graphical' && <DashboardCharts money={money} />}
        {view === 'static' && <>
        {partial && <div className="warnbox" style={{ marginBottom: 'var(--sp-5)' }}>
          <h4>Some figures did not load</h4>
          <div className="small" style={{ color: 'var(--text-2)' }}>
            The tiles below show what the server did return. Refresh to try the rest again —
            a blank tile here means unread, not zero.
          </div>
        </div>}

        {/* The notification centre, on the screen people already open. The bell
            in the header carries the same feed for everywhere else — this is it
            in full, where there is room to read the sentence under each line. */}
        <Section id="dash-notices" title="Notifications"
          summary={notices.length
            ? `${d.notifs.counts.unread || 0} unread of ${notices.length}`
            : 'nothing open'}
          actions={(d.notifs.counts?.unread || 0) > 0 ? (
            <button className="btn" onClick={() => api.notificationsReadAll(user).then(load)}>
              Mark all read</button>
          ) : null}>
          {!notices.length && (
            <div className="empty" style={{ padding: '18px 0' }}>
              Nothing is waiting. A notice appears the moment a queue stops being empty —
              and clears itself when the queue does.
            </div>
          )}
          {notices.map((n) => (
            <NoticeRow key={n.key} n={n} compact
              onOpen={(x) => go(x.module)}
              onRead={() => {}} />
          ))}
        </Section>

        <Section id="dash-attention" title="Waiting on someone"
          summary={open ? `${open} queue${open === 1 ? '' : 's'} not clear` : 'all clear'}>
          <div className="dgrid">
            {attention.map((a, i) => (
              <DashTile key={i} label={a.label} value={a.value} sub={a.sub} tone={a.tone}
                accent={a.accent} hint={a.hint} onClick={() => go(a.key)} />
            ))}
          </div>
        </Section>

        {/* Dead stock, for the people who decide about it rather than the people
            who clear it. Four figures, the ageing shape, and whether the last
            clearance actually worked — every one of them a link into the module
            already filtered, because a number management cannot open is a number
            they have to ask somebody about. The worksheet itself stays where it
            belongs; this is its headline. */}
        {d.dead && <DashDeadStock sum={d.dead} open={openDeadStock} />}

        <Section id="dash-stock" title="Stock at a glance"
          summary={`${d.stock.product_count || 0} records · ₹ ${money(d.stock.total_stock_value)}`}>
          <div className="dgrid">
            <DashTile label="Stock value" value={'₹ ' + money(d.stock.total_stock_value)}
              accent="money" sub="at purchase cost, posted receipts only" onClick={() => go('inventory')}
              hint="Open Inventory — only records a posted GRN created are counted" />
            <DashTile label="Pieces on hand" value={(d.stock.total_units || 0).toLocaleString('en-IN')}
              accent="stock" sub={`${d.stock.product_count || 0} inventory records`} onClick={() => go('inventory')} />
            <DashTile label="Awaiting physical detail" value={pendingDetail}
              accent="count" tone={pendingDetail ? 'warn' : ''}
              sub={pendingDetail ? 'colour, size and fit not recorded yet' : 'every item detailed'}
              hint="Open Inventory — items received but never looked at on the phone"
              onClick={() => go('inventory')} />
            <DashTile label="Purchase returns in draft" value={retDrafts}
              accent="back" tone={retDrafts ? 'warn' : ''}
              sub={retDrafts ? 'debit notes not yet raised' : 'no open debit notes'}
              onClick={() => go('returns')} />
            <DashTile label="Outward drafts" value={d.outDrafts.length}
              accent="move" tone={d.outDrafts.length ? 'warn' : ''}
              sub={d.outDrafts.length ? 'packed but not dispatched' : 'nothing packed'}
              onClick={() => go('outward')} />
            <DashTile label="LR rows without an invoice" value={lrUnlinked}
              accent="count" sub={lrUnlinked ? 'no invoice matched to them yet' : 'every row is linked'}
              hint="Open LR Entry — register rows no invoice has been matched against"
              onClick={() => go('lr')} />
          </div>
          <div className="items-foot">
            <span>Posted GRNs <b>{grnPostedCount.toLocaleString('en-IN')}</b></span>
            <span>Suppliers <b>{d.suppliers.length}</b></span>
            <span>Documents <b>{docs.length}</b></span>
            <span>LR entries <b>{(d.lr.total || 0).toLocaleString('en-IN')}</b></span>
            {d.stock.excluded_products > 0 && <span title="Records not traceable to a posted GRN — debris, or kept at zero after an unpost. They are not stock, so they are not valued.">
              Excluded from stock <b>{d.stock.excluded_products}</b></span>}
          </div>
        </Section>

        <Section id="dash-modules" title="Warehouse modules" summary={`${modules.length} screens`}>
          <div className="modgrid">
            {modules.map((m) => (
              <button key={m.key} className="modcard" onClick={() => go(m.key)} title={m.blurb}>
                <span className="ico" aria-hidden="true"><Icon name={NAV_ICON[m.key]} /></span>
                <span className="lbl">{m.label}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section id="dash-recent" title="Latest activity" defaultOpen={false}
          summary={`${recentDocs.length} documents · ${recentGrns.length} receipts`}>
          <div className="drecent">
            <div>
              <h5>Documents</h5>
              {recentDocs.length === 0 && <div className="small">Nothing uploaded yet.</div>}
              {recentDocs.map((x) => (
                <button key={x.id} className="drow" onClick={() => go('documents')}
                  title="Open Invoice Entry">
                  <span className="nm">{x.supplier_name || x.filename}</span>
                  <span className={'badge ' + x.status}>{x.status.replace('_', ' ')}</span>
                  <span className="amt">₹ {money(x.grand_total)}</span>
                </button>
              ))}
            </div>
            <div>
              <h5>Goods receipts</h5>
              {recentGrns.length === 0 && <div className="small">No GRN has been created yet.</div>}
              {recentGrns.map((g) => (
                <button key={g.id} className="drow" onClick={() => go('purchases')}
                  title="Open GRN">
                  <span className="nm">{g.grn_no || '#' + g.id} · {g.supplier_name || '—'}</span>
                  {/* same two colours the GRN screen uses for the same two states */}
                  <span className={'badge ' + (g.status === 'posted' ? 'confirmed' : 'uploaded')}>{g.status}</span>
                  <span className="amt">₹ {money(g.grand_total)}</span>
                </button>
              ))}
            </div>
          </div>
        </Section>
        </>}
      </div>
    </div>
  )
}

// ==========================================================================
//  Several modules open at once — and only where it earns its place
//  ------------------------------------------------------------------------
//  A tab that stays alive is a component that stays MOUNTED, which is the only
//  way React keeps its state. That is not free: a mounted screen keeps its
//  timers, its polling and its memory, and doing it to all twenty-two would
//  multiply the open requests on a warehouse tablet by however many tabs
//  somebody had left open — for screens where nothing is ever half-finished.
//
//  So it is an ALLOW-LIST of the screens that genuinely hold unfinished work:
//
//    pos:*             a till mid-sale. The strongest case by far — the shop is
//                      a separate app in a frame, and unmounting the frame
//                      destroys the cart with no way to get it back.
//    purchase_orders   an order half typed, with its lines
//    lr                a consignment half keyed
//    documents         an invoice being reviewed against its photograph
//    purchases         a GRN being counted, with breakdowns entered
//    stock_audit       a count in progress. The readings themselves are on the
//                      server, so those survive regardless — what is kept here
//                      is the filter and the place in a long register, which is
//                      exactly what somebody loses by stepping away to the till
//                      halfway through a rack.
//
//  Everything else — reports, masters, dashboards, locations — is read, acted
//  on and left. Re-opening one costs a fetch, which is what it costs today.
const KEEPALIVE = new Set(['purchase_orders', 'lr', 'documents', 'purchases',
                           'stock_audit'])
const keepAlive = (k) => KEEPALIVE.has(k) || String(k).startsWith('pos:')

// Which open tabs hold work somebody has not saved. A registry rather than a
// prop threaded through every module: only the screens that actually carry a
// draft need to say so, and the ones that do not are left completely alone.
const dirtyTabs = new Map()

/** A screen tells the shell it is holding unsaved work, so closing asks first. */
function useUnsavedGuard(key, dirty) {
  useEffect(() => {
    if (dirty) dirtyTabs.set(key, true)
    else dirtyTabs.delete(key)
    return () => dirtyTabs.delete(key)
  }, [key, dirty])
}

// The open-tabs strip. On a wide window it always names the screen that is open,
// the way the design's workspace tabs do; a tab only offers to close once there
// is another to land on. On a phone it is absent until a second tab exists (see
// `.tabstrip.single`) — one tab is not a set of tabs, and there the row is room
// the scanner and the forms need.
//
// It scrolls horizontally rather than wrapping, which is what keeps it to ONE
// line on a phone: §12's requirement is that this must not eat the room the
// scanner and the forms need, and a strip that grows to three rows is exactly
// how that happens.
function TabStrip({ open, active, setTab, close, label }) {
  if (!open || !open.length) return null
  const many = open.length > 1
  return (
    <div className={'tabstrip' + (many ? '' : ' single')} role="tablist">
      {open.map((k) => (
        <div key={k} role="tab" aria-selected={k === active} title={label(k)}
          className={'opentab' + (k === active ? ' on' : '')}
          onClick={() => setTab(k)}>
          <span className="ot-dot" aria-hidden="true" />
          <span className="ot-label">{label(k)}</span>
          {many && <button className="ot-x" title={`Close ${label(k)}`} aria-label={`Close ${label(k)}`}
            onClick={(e) => { e.stopPropagation(); close(k) }}>×</button>}
        </div>
      ))}
    </div>
  )
}

// ---------- app shell ----------
export default function App() {
  // the open tab survives a reload — a warehouse screen is left on the module
  // someone works in, and losing it on every refresh is a small daily tax
  const [tab, setTabState] = useState(() => localStorage.getItem('essa_tab') || 'dashboard')
  // ------------------------------------------------------------------------
  //  Open tabs belong to ONE WAREHOUSE, and are kept per warehouse
  //  ----------------------------------------------------------------------
  //  Every screen a tab can hold is one building's work: an order raised at
  //  Erode, a consignment booked in at Erode, a GRN counted at Erode. Carrying
  //  that set of tabs into Karur would be offering somebody the shape of a job
  //  they were doing somewhere else — and the tab would open empty anyway,
  //  because the content is keyed on the warehouse and remounts when it changes.
  //
  //  So the store is a MAP, warehouse id -> open tabs, and each building keeps
  //  its own strip. Walk out of Erode mid-order and into Karur and Karur's
  //  strip is whatever Karur had; walk back and Erode's tabs are as they were.
  //
  //  Held as a map rather than one list per key so a single read and a single
  //  write cover every warehouse — a key per building would need a migration
  //  every time one was added, and would leak keys for buildings since closed.
  const [openByWh, setOpenByWh] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('essa_open_tabs') || '{}')
      // An earlier build stored a flat ARRAY for the whole session. There is no
      // way to know which warehouse those tabs belonged to, and guessing would
      // put one building's work in another's strip — the exact fault this shape
      // fixes. Dropped instead: a tab costs one click to reopen.
      if (!raw || Array.isArray(raw) || typeof raw !== 'object') return {}
      const out = {}
      for (const [wh, list] of Object.entries(raw)) {
        if (Array.isArray(list)) out[wh] = list.filter(keepAlive)
      }
      return out
    } catch { return {} }
  })
  // Which warehouse this session is working INSIDE, or null for the whole
  // company. Every API call carries it as a header (see api.js), so the screens
  // below need no per-screen plumbing — but they DO need to refetch when it
  // changes, which is what keying the content on `here.id` achieves: React
  // remounts them and each one loads its own data again. Anything subtler would
  // leave one screen showing the warehouse you just left.
  const [here, setHere] = useState(() => warehouse.get())

  //: Which building's strip is on screen. `company` is a real key rather than a
  //: skipped case so the code has one shape — nothing keep-alive is reachable at
  //: company level, so that list stays empty and the strip never draws there.
  const whKey = here?.id ? String(here.id) : 'company'
  const openTabs = openByWh[whKey] || []
  const rememberOpen = (list) => {
    const next = { ...openByWh, [whKey]: list }
    if (!list.length) delete next[whKey]      // don't keep empty buildings around
    setOpenByWh(next)
    try { localStorage.setItem('essa_open_tabs', JSON.stringify(next)) }
    catch { /* private mode */ }
  }
  const setTab = (t) => {
    setTabState(t)
    try { localStorage.setItem('essa_tab', t) } catch { /* private mode */ }
    // Opening a keep-alive screen adds it to THIS warehouse's strip. Everything
    // else leaves the strip alone — a report opened between two half-finished
    // jobs must not push either of them out or grow the strip with something
    // nobody will return to.
    if (keepAlive(t) && !openTabs.includes(t)) rememberOpen([...openTabs, t])
  }
  // `alive` — which tabs are mounted right now — is computed BELOW, beside
  // `modules`: deciding it needs the role and the grant map, and reading a
  // `const` above its declaration is a TDZ throw, not undefined. See the note on
  // `canCentral` for the same trap caught the same way.
  const labelFor = (k) => (POS_ITEMS.find((p) => p && p.key === k)
    || MODULES.find((m) => m.key === k)
    || (k === DASHBOARD.key && DASHBOARD)
    || (k === 'pickwh' && { label: 'Choose a warehouse' }) || {}).label || k
  // The shell's own state: the drawer on a narrow window, the Ctrl+K palette,
  // the buildings the context bar can switch between, and — when somebody asks
  // for the Warehouse or Store workspace before choosing a building — which of
  // the two the warehouse picker should land them in afterwards.
  const [navOpen, setNavOpen] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [whList, setWhList] = useState([])
  const [pickFor, setPickFor] = useState(null)
  const closeTab = (k) => {
    // §11: unsaved work is protected. Only screens that registered a guard can
    // answer this, which is why an unregistered one closes silently — it has
    // nothing to lose, and asking anyway would train people to click through.
    if (dirtyTabs.get(k)
        && !window.confirm(`${labelFor(k)} has unsaved changes. Close it and lose them?`)) return
    const left = openTabs.filter((x) => x !== k)
    rememberOpen(left)
    // Closing the tab you are looking at has to land somewhere. The next open
    // tab is the least surprising place; the dashboard when there is none.
    if (k === tab) setTab(left[left.length - 1] || (here ? 'dashboard' : homeTab))
  }
  const enterWarehouse = (w, land) => {
    // The dashboard's rows key their id as `warehouse_id`, the Locations tree as
    // `id`. Normalised here so callers can hand over whichever row they have
    // rather than every one of them remembering which shape it holds.
    warehouse.set(w && { id: w.id || w.warehouse_id, name: w.name,
                         code: w.code, catalogue: w.catalogue })
    setHere(warehouse.get())
    setSel(null); setSelPurchase(null)
    // Entering lands on the workspace that was asked for — the store's own
    // dashboard when somebody chose Store before they chose a building.
    // Leaving lands on whichever company screen this account can actually have:
    // the Central Dashboard for an admin, the warehouse picker for the floor.
    setTab(w ? (land || (pickFor === 'store' ? storeHome : 'dashboard'))
      : (atLeast(role, 'admin') ? 'central' : 'pickwh'))
    setPickFor(null)
  }
  // Both the warehouse and the open tab survive a reload, and they can come back
  // contradicting each other — signed out on the Central Dashboard while inside
  // Taqua, then signed back in. Hiding the menu entry is not enough on its own:
  // it would leave somebody looking at a company screen with no way to see they
  // had left the warehouse behind. So the tab is corrected, not just the menu.
  // NOTE: the tab/warehouse reconciliation that used to sit here has moved
  // BELOW `role` — it reads it, and `const` is not hoisted like `var`, so
  // running it up here threw "Cannot access 'role' before initialization" on
  // every render. The whole app came up blank.
  const [status, setStatus] = useState(null)
  const [docs, setDocs] = useState([])
  const [sel, setSel] = useState(null)
  const [selPurchase, setSelPurchase] = useState(null)
  const [toastMsg, setToastMsg] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  // The notification panel is mounted at the root (see below) while its bell
  // sits on the chrome, so the open flag lives here. `notifTick` is bumped when
  // the panel changes something, which is what makes the badge re-read.
  const [notifsOpen, setNotifsOpen] = useState(false)
  const [notifTick, setNotifTick] = useState(0)
  // Which Dead Stock screen a dashboard card asked for. Held here because the
  // card and the module are siblings — see the useEffect in DeadStock.
  const [dsIntent, setDsIntent] = useState(null)
  const openDeadStock = (intent) => { setDsIntent(intent || null); setTab('deadstock') }
  const [scanning, setScanning] = useState(null)   // {url, name} while extracting
  const [docQuery, setDocQuery] = useState('')
  const [docScope, setDocScope] = useState('all')
  // scope chip + search, applied together — the same pairing every list uses
  const shownDocs = docs
    .filter((d) => docScope === 'all' || d.status === docScope)
    .filter((d) => matches(d, docQuery, ['supplier_name', 'filename', 'invoice_number', 'status']))
  const docPage = usePaged(shownDocs, 50)
  const [authed, setAuthed] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [user, setUser] = useState('')
  const [role, setRole] = useState('')
  //: what this ACCOUNT may open, screen by screen. Empty means unrestricted and
  //: the role decides on its own — see services/permissions.has_map.
  const [perms, setPerms] = useState({})
  // Narrowed to billing and reports in the Store — see POS_USER_KEYS. Where the
  // Store opens for them is the counter, since its dashboard is not theirs.
  const storeUser = perms?.store === 'user'
  const storeHome = storeUser ? 'pos:counter' : 'pos:home'
  const posItems = storeUser ? POS_ITEMS.filter((p) => p && POS_USER_KEYS.has(p.key)) : POS_ITEMS
  const [showPassword, setShowPassword] = useState(false)

  // Where an account lands when it is outside every warehouse. The Central
  // Dashboard is the natural home, but it is ADMIN — and for a floor user it
  // would be a dead end: the menu offers them almost nothing at company level,
  // the effect would send them to `central`, and the "needs Admin access" panel's
  // only button sends them back again. A loop with no way into any building. So
  // an account that cannot open `central` gets the warehouse PICKER instead.
  //
  // Placed AFTER `role` deliberately — it reads it, and reading a `const` above
  // its declaration is a TDZ throw, not undefined.
  const canCentral = atLeast(role, 'admin')
  // Where each rank lands. The Command Center is the owner's and the super
  // admin's first screen — it is the whole business, and everything else is a
  // way into a part of it.
  const canCommand = atLeast(role, 'superadmin')
  const homeTab = canCommand ? 'command' : canCentral ? 'central' : 'pickwh'
  // The warehouse and the open tab are remembered separately and can come back
  // contradicting each other, so the tab is corrected, not just the menu.
  useEffect(() => {
    if (here && COMPANY_ONLY.has(tab)) { setTab('dashboard'); return }
    if (!here && tab !== 'pickwh' && !COMPANY_LEVEL.has(tab)) setTab(homeTab)
    if (!here && tab === 'central' && !canCentral) setTab('pickwh')
    // The same for the Command Center: a terminal left on it by the owner must
    // not greet an admin with a screen the server will refuse.
    if (!here && tab === 'command' && !canCommand) setTab(homeTab)
    if (!here && tab === 'audit' && !canCentral) setTab(homeTab)
    // A remembered Store tab this account is no longer given — the last person
    // at this terminal was an admin, or the access was narrowed since.
    if (here && storeUser && String(tab).startsWith('pos:') && !POS_USER_KEYS.has(tab)) setTab(storeHome)
  }, [here, tab, canCentral, canCommand, homeTab, storeUser, storeHome])

  // The stores this warehouse supplies, so the menu can call them by the names
  // somebody gave them. Re-read when the warehouse changes — a store belongs to
  // one building, and carrying Erode's branch name into Karur's menu would name
  // the wrong shop. Failures are swallowed: an unreachable list costs a name,
  // and the menu falls back to the plain word rather than disappearing.
  const [stores, setStores] = useState([])
  useEffect(() => {
    if (!here?.id) { setStores([]); return }
    let live = true
    api.stores(here.id).then((rows) => { if (live) setStores(rows || []) })
      .catch(() => { if (live) setStores([]) })
    return () => { live = false }
  }, [here?.id])

  const refreshStatus = useCallback(() => api.status().then(setStatus), [])
  const refresh = useCallback(() => api.listDocuments().then(setDocs), [])

  // verify any stored token on load (so a refresh doesn't force re-login).
  // The role comes back from the server on every verify rather than being kept
  // beside the token: a role changed by the super admin then takes effect on
  // the next reload, instead of waiting for the person to sign out.
  useEffect(() => {
    const t = session.get()
    if (!t) { setAuthChecked(true); return }
    api.verifyToken(t).then((r) => {
      if (r.ok) {
        setAuthed(true); setUser(r.user); setRole(r.role || '')
        setPerms(r.permissions || {})
      } else session.clear()
    }).catch(() => {}).finally(() => setAuthChecked(true))
  }, [])

  // A token that expires, or an account deactivated mid-shift, comes back as a
  // 401 on whatever call happens next. Handled once here so it returns the
  // whole app to the login screen, rather than leaving each panel to show its
  // own failure and the person to guess why everything stopped working.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      session.clear(); resetCache(); setAuthed(false); setSel(null)
    })
  }, [])

  useEffect(() => { if (authed) { refreshStatus(); refresh() } }, [authed, refresh, refreshStatus])
  const toast = (m, kind) => { setToastMsg({ m, kind }); setTimeout(() => setToastMsg(null), 3000) }
  const handleLogin = (token, u, r, perms) => {
    // The dashboards held in memory are the last account's figures — possibly
    // for warehouses this one is not allotted. Never shown to the next person.
    resetCache()
    session.set(token); setUser(u); setRole(r || ''); setPerms(perms || {}); setAuthed(true)
  }
  const logout = () => {
    // Clears the cookie as well as the stored token. Without the call the
    // cookie outlives the logout, and the invoice images on a shared terminal
    // stay fetchable by the next person to open the tab.
    api.logout()
    session.clear(); resetCache(); setAuthed(false); setSel(null); setTab('dashboard')
  }
  const gotoPurchase = (id) => { setSelPurchase(id); setTab('purchases') }

  // The way in for a bill that never was a photograph. It creates the document
  // and selects it, which drops straight into the same review form an upload
  // lands on — with every field blank rather than extracted.
  const onNewEntry = async () => {
    setTab('documents')
    try {
      const res = await api.createManualDocument()
      await refresh()
      setSel(res.document.id)
      toast('✓ Blank invoice — key it in and Confirm', 'ok')
    } catch (err) {
      // A backend started before this endpoint existed 404s here while serving
      // the new screen off disk. That is a restart, not a fault, and saying so
      // is the difference between a two-minute fix and a bug report.
      toast(err.status === 404
        ? 'Manual entry needs the server restarted — it was started before this existed'
        : 'Could not start a manual entry: ' + (err.detail || err.message), 'err')
    }
  }

  const onUpload = async (e) => {
    // Several pages of ONE invoice, in the order they were picked. A bill of
    // sixty lines prints as two pages and only the last carries the totals, so
    // uploading them separately produced two half-documents and left the second
    // to be keyed into the first by hand.
    const files = Array.from(e.target.files || []); if (!files.length) return
    const file = files[0]
    // show the first page being "scanned" while the backend extracts
    const url = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    setScanning({ url, name: files.length > 1 ? `${files.length} pages` : file.name })
    setTab('documents')
    try {
      const res = await api.upload(files)
      await refresh()
      setSel(res.document.id)
      toast(res.supplier_recognised
        ? `✓ Recognised ${res.document.supplier_name}${res.profile_used ? ' (using trained format)' : ''}`
        : '✓ Extracted — supplier not recognised, review & train', 'ok')
      if (res.lr_filled && res.lr_filled.length) {
        toast(`🔗 Matched & filled ${res.lr_filled.length} LR row(s) from this invoice`, 'ok')
        const conflicts = res.lr_filled.reduce((n, x) => n + ((x.mismatches && x.mismatches.length) || 0), 0)
        if (conflicts) toast(`⚠ ${conflicts} value(s) disagree with the register — see LR Entry (conflict flag)`, 'err')
      }
    } catch (err) { toast('Upload failed: ' + (err.detail || err.message), 'err') }
    finally {
      setScanning(null)
      if (url) URL.revokeObjectURL(url)
    }
    e.target.value = ''
  }

  const delOne = async (e, id) => {
    e.stopPropagation()
    if (!window.confirm('Delete this document and its extraction?')) return
    try {
      await api.deleteDocument(id)
      if (sel === id) setSel(null)
      await refresh(); toast('Document deleted', 'ok')
    } catch (err) { toast(err.detail || 'Delete failed', 'err') }
  }
  const clearAll = async () => {
    if (!window.confirm('Clear ALL transaction data — documents, LR entries, GRNs, inventory, outwards, returns and payments?\nThis cannot be undone.')) return
    const wipeMasters = window.confirm('Also wipe the MASTERS (suppliers, trained formats, agents, transporters)?\n\nOK = fully empty database (only the category master stays).\nCancel = keep suppliers & trained formats.')
    const res = await api.clearAllDocuments(wipeMasters)
    setSel(null); await refresh()
    toast(wipeMasters ? '✓ Database emptied — only category master kept' : '✓ Transactions cleared — suppliers & training kept', 'ok')
    return res
  }

  const providers = status?.providers || {}
  // A module above this person's rank is absent from the menu and from the
  // dashboard grid, rather than present and refusing when clicked.
  //
  // …and so is one their ACCOUNT has been restricted out of. An empty grant map
  // means unrestricted — see services/permissions.has_map — so this narrows only
  // for accounts somebody has deliberately narrowed. Courtesy, not enforcement:
  // the server refuses either way (backend/app/security.py). The point of hiding
  // it is that nobody is shown twelve buttons that answer "not for you".
  const granted = perms?.screens || null
  const modules = MODULES.filter((m) => (!m.min || atLeast(role, m.min))
    && (!granted || (granted[m.key] || []).length)
    // Company-level screens are hidden once you are standing inside a warehouse.
    // Neither has an answer at that altitude: the Central Dashboard compares
    // every warehouse, and Locations is where warehouses are created and closed.
    // Offering them from inside one invites the reading that they are showing
    // that warehouse — and a person who opens Locations expecting Taqua's
    // settings and edits the company's list has been misled by the menu.
    && (here ? !COMPANY_ONLY.has(m.key) : COMPANY_LEVEL.has(m.key)))
  const isSuper = atLeast(role, 'superadmin')

  // ------------------------------------------------------------------------
  //  Which open tabs belong WHERE YOU ARE STANDING
  //  ----------------------------------------------------------------------
  //  A tab is not portable between altitudes. Purchase Orders, LR Entry,
  //  Invoice Entry and GRN are one warehouse's work; at company level they have
  //  no answer at all, and the menu has always hidden them there. The strip has
  //  to obey the same rule, for a stronger reason than tidiness: a kept tab is
  //  a MOUNTED screen, so a warehouse module left open at company level would
  //  be sitting there rendering the warehouse you just left. That is the exact
  //  failure the remount-on-warehouse-change exists to prevent, and the strip
  //  had quietly reintroduced it.
  //
  //  Same predicate as `modules` above, so the strip can never offer a screen
  //  the menu does not — including one this ACCOUNT is not granted.
  //
  //  The stored list is left alone. Coming back into a warehouse brings its
  //  tabs back, freshly loaded, which is what "reopen a module" means; what
  //  does not survive the trip is their STATE, and it never could — the content
  //  is keyed on the warehouse and remounts when it changes.
  const availableHere = (k) => {
    // The shop is reached from inside the warehouse that supplies it.
    if (String(k).startsWith('pos:')) return !!here && posItems.some((p) => p && p.key === k)
    const m = MODULES.find((x) => x.key === k)
    if (!m) return false
    return modules.includes(m)
  }
  //: The tabs actually mounted right now — the open keep-alive ones that belong
  //: here, plus the active screen whatever it is. The active one is always in
  //: the list, so it always renders; that is what lets a non-keep-alive screen
  //: (Reports) show normally while two kept tabs sit hidden behind it.
  const alive = Array.from(new Set([...openTabs.filter(availableHere), tab]))
  // The Store Dashboard is not one of the panes: it has a frame of its own that
  // outlives the per-warehouse remount (StoreHomeFrame). It is for the last
  // warehouse entered, so leaving for the company screens keeps it loaded and
  // coming back to the same building finds it drawn.
  const lastWh = useRef(null)
  if (here?.id) lastWh.current = here
  const storeWh = lastWh.current
  const storeFrameOn = !!storeWh && posItems.some((p) => p && p.key === POS_HOME.key)
  const panes = storeFrameOn ? alive.filter((k) => k !== POS_HOME.key) : alive
  // More than one pane to keep, or one kept pane behind the Store Dashboard.
  const multiPane = panes.length > 1 || (panes.length === 1 && panes[0] !== tab)
  // The open tab is remembered across sessions, so the person who signs in at
  // this terminal is not always the one who left it on Payments. One guard in
  // front of the whole chain rather than a check inside each branch: a screen
  // added later is covered by its MODULES entry alone, and cannot be forgotten.
  const wanted = MODULES.find((m) => m.key === tab)
  const denied = wanted && wanted.min && !atLeast(role, wanted.min) ? wanted : null

  // What this warehouse's selling side is actually CALLED. A store is created
  // with a name — "Taqua shop Tirupur 1" — and that name is the one the person
  // who typed it will look for. Naming the menu "POS" instead tells them what
  // the software is rather than which place they are opening, and a warehouse
  // that supplies two branches needs to know which of them it is billing from.
  //
  // One store: it IS the name. Several: the count, because no single name is
  // the honest answer. None: the plain word, so the entry still reads as a
  // place rather than as a piece of equipment.
  const storeLabel = stores.length === 1 ? stores[0].name
    : stores.length > 1 ? `Stores · ${stores.length}` : 'Store'

  // The buildings the context bar can switch between. The same read the
  // warehouse picker makes, narrowed by the server to this account's allotment —
  // so the dropdown can never offer a warehouse the picker would not. Re-read on
  // a switch so a renamed or closed one does not linger.
  useEffect(() => {
    if (!authed) { setWhList([]); return }
    let live = true
    api.locationTree()
      .then((t) => { if (live) setWhList((t.warehouses || []).filter((w) => w.id && w.active !== false)) })
      .catch(() => { if (live) setWhList([]) })
    return () => { live = false }
  }, [authed, here?.id])

  // Reports are warmed only for an account the menu offers them to.
  const canReports = modules.some((m) => m.key === 'reports')
  // ------------------------------------------------------------------------
  //  The dashboards, kept warm
  //  ----------------------------------------------------------------------
  //  The Command Center, the Central Dashboard and this warehouse's dashboard
  //  are read into the cache (dashcache.js) before anybody asks for them, and
  //  re-read every two minutes while the window is in front — so switching
  //  between them draws at once, with figures at most a couple of minutes old
  //  until the screen's own re-read lands. Reports get the same: their lists
  //  and the one report the screen will open on (warmReports). The store's
  //  dashboard is a frame, kept loaded instead (StoreHomeFrame, below).
  useEffect(() => {
    if (!authed || !role) return
    const warm = () => {
      if (document.visibilityState === 'hidden') return
      warmDashboards({ command: canCommand, central: canCentral,
                       warehouses: here?.id ? [here.id] : [], charts: true })
      // Reports too, for the workspace on screen, when this account has it
      if (canReports) warmReports(here?.id || null)
    }
    warm()
    const t = setInterval(warm, 2 * 60 * 1000)
    document.addEventListener('visibilitychange', warm)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', warm) }
  }, [authed, role, here?.id, canCommand, canCentral, canReports])
  // Every other warehouse this account can enter, once, so picking one from the
  // company screens opens on its figures too. One building at a time rather
  // than all at once — ten reads per warehouse, fired together at sign-in, is a
  // queue the server would make the screen on display wait behind.
  useEffect(() => {
    if (!authed) return
    const others = whList.map((w) => w.id)
      .filter((id) => String(id) !== String(here?.id)).slice(0, 8)
    let live = true
    ;(async () => {
      for (const id of others) {
        if (!live) return
        await warmDashboards({ warehouses: [id], fresh: 5 * 60 * 1000 })
      }
    })()
    return () => { live = false }
  }, [authed, whList])

  // Ctrl+K (⌘K) opens the jump palette from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault(); setJumpOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ------------------------------------------------------------------------
  //  Which workspace you are standing in
  //  ----------------------------------------------------------------------
  //  Central is the company, with no building chosen. Warehouse is one
  //  building's own screens. Store is that building's shop — the till frame.
  //  It is DERIVED from where you are rather than stored beside it, so the
  //  switch in the context bar can never disagree with the screen under it.
  const ws = !here ? 'central' : String(tab).startsWith('pos:') ? 'store' : 'warehouse'
  // while the picker is open on behalf of Warehouse or Store, that is the
  // segment that reads as chosen
  const wsShown = !here && tab === 'pickwh' && pickFor ? pickFor : ws
  const goWs = (target) => {
    setNavOpen(false)
    if (target === 'central') {
      setPickFor(null)
      if (here) enterWarehouse(null); else setTab(homeTab)
      return
    }
    if (here) { setTab(target === 'store' ? storeHome : 'dashboard'); return }
    // A building has to be chosen first. With only one to choose from, choosing
    // it for them is not a decision taken away — it is a click saved.
    if (whList.length === 1) { enterWarehouse(whList[0], target === 'store' ? storeHome : 'dashboard'); return }
    setPickFor(target); setTab('pickwh')
  }
  const pickWarehouse = (id) => {
    const w = whList.find((x) => String(x.id) === String(id))
    if (w && String(w.id) !== String(here?.id)) enterWarehouse(w, ws === 'store' ? storeHome : 'dashboard')
  }

  // What the sidebar lists at each altitude.
  const navItems = ws === 'store'
    ? posItems.map((p) => (p && p.key === 'pos:counter' ? { ...p, badge: 'POS' } : p))
    : here
      ? [DASHBOARD, null, ...modules]
      // The two whole-company screens are hoisted to the top, in altitude order:
      // the Command Center is the business, the Central Dashboard is its stock.
      : [...modules.filter((m) => m.key === 'command' || m.key === 'central'),
         ...(canCentral ? [] : [{ key: 'pickwh', label: 'Choose a warehouse',
           blurb: 'Pick the building you are working in' }]),
         null, ...modules.filter((m) => m.key !== 'central' && m.key !== 'command')]
  const companyName = status?.company?.name || 'Essa'
  const navKind = ws === 'store' ? 'Retail Store' : ws === 'warehouse' ? 'Warehouse Ops' : 'Central Admin'
  const navContext = ws === 'store' ? `${storeLabel} · ${here.name}`
    : ws === 'warehouse' ? `${here.name}${here.code ? ` (${here.code})` : ''}`
    : companyName
  const navFoot = ROLE_LABEL[role] || role || ''
  // Every door the sidebar offers, grouped — and nothing it does not.
  const jumpGroups = [
    ...(here
      ? [{ title: `Warehouse · ${here.name}`, items: [DASHBOARD, ...modules] },
         { title: storeLabel, items: posItems.filter(Boolean) }]
      : [{ title: 'Central', items: tidyRules(navItems).filter(Boolean) }]),
    { title: 'Workspaces', items: [
      { key: 'ws:central', label: 'Central', blurb: 'The whole company — every warehouse at once' },
      { key: 'ws:warehouse', label: 'Warehouse', blurb: here ? `Everything at ${here.name}` : 'Choose a building to work inside' },
      { key: 'ws:store', label: 'Store / POS', blurb: here ? `${storeLabel} — billing, floor sales and store stock` : 'Choose a building, then open its store' },
    ] },
  ]
  const jumpTo = (k) => {
    setJumpOpen(false)
    if (String(k).startsWith('ws:')) goWs(k.slice(3)); else setTab(k)
  }

  if (!authChecked) return <div className="login-wrap"><div className="login-bg" /></div>
  if (!authed) return <LoginScreen onLogin={handleLogin} />

  return (
    <div className="app">
      {/* 1. The header: what system this is, the switches that change how it
          behaves, and who is signed in. */}
      <div className="topbar">
        <button className="th-icon th-menu" onClick={() => setNavOpen(true)}
          aria-label="Open navigation menu" title="Menu"><Icon name="menu" size={20} /></button>
        <div className="th-brand">
          <span className="th-logo" aria-hidden="true">E</span>
          <div className="brand">Essa <span>· Enterprise ERP</span>
            <small>{companyName} — multi-warehouse inventory &amp; retail supply chain</small></div>
        </div>
        <div className="spacer" />
        <button className="th-ctl th-search" onClick={() => setJumpOpen(true)}
          title="Jump to any screen (Ctrl + K)" aria-label="Jump to a screen">
          <Icon name="search" size={14} /><span className="ph">Search screens…</span><kbd>Ctrl K</kbd>
        </button>
        {/* The vision key and model are server-wide settings, so the gear is a
            super admin's. For everyone else the pill still reports whether
            vision is on — that changes how an upload behaves and is worth
            knowing — but it does not open a screen the server would refuse. */}
        {isSuper ? (
          <button className={'pill ' + (providers.claude_vision ? 'on' : 'off')}
            title="Configure vision extraction" onClick={() => setShowSettings(true)}>
            <Icon name="eye" size={14} /> Vision {providers.claude_vision ? 'on' : 'off'}
            <span className="dot" aria-hidden="true" /></button>
        ) : (
          <span className={'pill ' + (providers.claude_vision ? 'on' : 'off')}
            title="Vision extraction — a super admin configures this">
            <Icon name="eye" size={14} /> Vision {providers.claude_vision ? 'on' : 'off'}
            <span className="dot" aria-hidden="true" /></span>
        )}
        <span className={'pill ocr ' + (providers.tesseract ? 'on' : 'off')}
          title="Offline OCR extraction engine">
          <Icon name="cpu" size={14} /> OCR {providers.tesseract ? 'on' : 'off'}</span>
        <NotificationBell onOpen={() => setNotifsOpen(true)} tick={notifTick} />
        <span className="th-div" aria-hidden="true" />
        {/* Who you are signed in as, and at what level. On a shared warehouse
            terminal the second half is the load-bearing one: it is the answer
            to "why can I not see Reports today", visible without asking. */}
        <button className="th-user" onClick={() => setShowPassword(true)}
          title={`${user} · ${ROLE_LABEL[role] || role}${ROLE_HELP[role] ? ' — ' + ROLE_HELP[role] : ''}\nClick to change your password`}>
          <span className="th-avatar" aria-hidden="true">{initialsOf(user)}</span>
          <span className="th-who">
            <span className="th-role">{ROLE_LABEL[role] || role}</span>
            <span className="th-name">{user}</span>
          </span>
        </button>
        <button className="th-icon th-logout" title={'Sign out of ' + user} aria-label="Sign out"
          onClick={logout}><Icon name="logout" /></button>
      </div>

      {/* 2. The context bar. WHERE YOU ARE, loud on purpose: every screen below
          is showing one altitude's work, and a person who has forgotten which
          warehouse they are inside will post a receipt into the wrong building. */}
      <div className="ctxbar">
        <div className="ctx-left">
          <div className="wsseg" role="tablist" aria-label="Workspace">
            <button role="tab" aria-selected={wsShown === 'central'} className={wsShown === 'central' ? 'on' : ''}
              onClick={() => goWs('central')}
              title={canCentral ? 'The whole company — every warehouse at once' : 'Leave the building you are in'}>
              <Icon name="grid" size={14} /> Central</button>
            <button role="tab" aria-selected={wsShown === 'warehouse'} className={wsShown === 'warehouse' ? 'on' : ''}
              onClick={() => goWs('warehouse')}
              title={here ? `Everything at ${here.name}` : 'Choose a building to work inside'}>
              <Icon name="building" size={14} /> Warehouse</button>
            {/* A till belongs to a STORE, and a store belongs to a warehouse. So
                the Store is reached through the warehouse that supplies it, and
                the frame is told which — see the `wh` parameter, which limits
                the till's own branch picker to that warehouse's shops. */}
            <button role="tab" aria-selected={wsShown === 'store'} className={wsShown === 'store' ? 'on' : ''}
              onClick={() => goWs('store')}
              title={here
                ? (stores.length > 1
                  ? `The ${stores.length} stores ${here.name} supplies — ${stores.map((s) => s.name).join(', ')}`
                  : `${storeLabel} — billing, floor sales and store stock`)
                : 'Choose a building, then open its store'}>
              <Icon name="store" size={14} /> Store / POS</button>
          </div>
          <span className="ctx-chev" aria-hidden="true"><Icon name="chevron" size={14} /></span>
          {!here ? (
            <span className="ctx-chip">
              <Icon name={tab === 'pickwh' ? 'building' : 'layers'} size={14} />
              {tab === 'pickwh' ? 'Choose the warehouse you are working in' : 'Headquarters · Central Administration'}
            </span>
          ) : (
            <label className="ctx-pick" title="Switch to another warehouse — every screen reloads for it">
              <span>{ws === 'store' ? 'Supplied by' : 'Facility'}</span>
              <select value={String(here.id)} onChange={(e) => pickWarehouse(e.target.value)}>
                {!whList.some((w) => String(w.id) === String(here.id)) && (
                  <option value={String(here.id)}>{here.name}{here.code ? ' · ' + here.code : ''}</option>
                )}
                {whList.map((w) => (
                  <option key={w.id} value={String(w.id)}>{w.name}{w.code ? ' · ' + w.code : ''}</option>
                ))}
              </select>
            </label>
          )}
          {ws === 'store' && (
            <span className="ctx-chip" title={stores.map((s) => s.name).join(', ') || 'No store is set up for this warehouse yet'}>
              <Icon name="store" size={14} />{storeLabel}</span>
          )}
        </div>
        <div className="ctx-right">
          <span className="meta">
            {ws === 'central' && <>Company: <b>{companyName}</b>
              <span className="sep"> | </span>Signed in as <b>{ROLE_LABEL[role] || role}</b></>}
            {ws === 'warehouse' && <>Code: <b className="mono">{here.code || '—'}</b>
              <span className="sep"> | </span>Trades in: <b>{here.catalogue || '—'}</b>
              <span className="sep"> | </span>Stores supplied: <b className="mono">{stores.length}</b></>}
            {ws === 'store' && <>Warehouse: <b>{here.name}</b>
              <span className="sep"> | </span>Stores: <b className="mono">{stores.length}</b></>}
          </span>
          {/* Both of these CREATE AN INVOICE, and an invoice belongs to the
              warehouse whose desk keyed it — that is what stamps
              Document.warehouse_id (see routers/documents). Raised from the
              company view they would land unassigned, showing up on every
              warehouse's queue and belonging to none; raised from Inventory or
              Reports they are a gesture with no obvious home.

              So they appear where they mean something: inside a warehouse, on the
              Invoice Entry screen. Hidden rather than disabled — a permanently
              greyed button on nine screens out of ten is furniture nobody reads.

              "New entry" sits beside the upload, not instead of it, and quieter
              than it: reading a photograph is still the way this screen is meant
              to be used, and typing a bill out is the fallback for the one that
              has no usable picture. */}
          {here && tab === 'documents' && <>
            <button className="btn" onClick={onNewEntry}
              title={`Key an invoice in by hand for ${here.name} — for one with no scan, or dictated over the phone`}>
              <Icon name="plus" size={14} /> New entry</button>
            <label className="btn primary uploadbtn"
              title={`One invoice for ${here.name}. Pick both pages together if it is printed on more than one.`}>
              <Icon name="upload" size={14} /> Upload invoice
              <input type="file" accept="image/*,.pdf" multiple onChange={onUpload} /></label>
          </>}
        </div>
      </div>

      {/* 3. The open tabs. */}
      <TabStrip open={alive} active={tab} setTab={setTab} close={closeTab}
        label={labelFor} />

      {/* 4. The sidebar beside the open screen. */}
      <div className="shell">
      <NavSidebar kind={navKind} context={navContext} items={navItems} tab={tab} go={setTab}
        online={!!status} foot={navFoot} />
      <main className="shellmain">
      {/* Keyed on the warehouse. Switching one remounts every screen below, so
          each refetches its own data under the new context — the alternative is
          asking fifty components to notice a change, and the one that forgets
          quietly shows the warehouse you just left. */}
      <React.Fragment key={'wh-' + (here?.id || 'all')}>
      {denied ? (
        <div className="body"><div className="empty" style={{ margin: 'auto', maxWidth: 420, lineHeight: 1.7 }}>
          <div style={{ fontSize: 26, marginBottom: 6 }}>{denied.icon}</div>
          <b>{denied.label}</b> needs {ROLE_LABEL[denied.min]} access.<br />
          You are signed in as <b>{user}</b> ({ROLE_LABEL[role] || role}).
          <div style={{ marginTop: 12 }}>
            {/* Back to somewhere this account can actually be. Sending them to
                'dashboard' bounced a floor user straight back here. */}
            <button className="btn primary"
              onClick={() => setTab(here ? 'dashboard' : homeTab)}>
              {here ? 'Back to the dashboard' : 'Choose a warehouse'}</button>
          </div>
        </div></div>
      ) : multiPane ? (
        // MORE THAN ONE TAB OPEN. Each is mounted and only the active one is
        // shown, which is the entire mechanism behind keeping a half-written
        // order alive while somebody serves a customer at the till — React keeps
        // the state of a component that stays mounted, and loses it the moment
        // it does not.
        //
        // Below, with a single tab, the module is rendered bare and this wrapper
        // never exists. That is deliberate: it keeps the ordinary
        // one-screen-at-a-time case byte-for-byte what it has always been, so
        // multi-tab cannot regress the layout of a warehouse that never opens a
        // second one.
        panes.map((k) => (
          <div key={k} className="tabpane" hidden={k !== tab}>{screenFor(k)}</div>
        ))
      ) : storeFrameOn && tab === POS_HOME.key ? null : screenFor(tab)}
      </React.Fragment>
      {/* Outside the keyed fragment on purpose: it survives the trip to the
          company screens and back. See StoreHomeFrame. */}
      {storeFrameOn && <StoreHomeFrame warehouse={storeWh}
        shown={!denied && tab === POS_HOME.key && String(here?.id) === String(storeWh.id)}
        available={status?.pos?.available} error={status?.pos?.error} />}
      </main>
      </div>

      {navOpen && <NavSidebar drawer kind={navKind} context={navContext} items={navItems}
        tab={tab} go={setTab} online={!!status} foot={navFoot}
        onClose={() => setNavOpen(false)} />}
      {jumpOpen && <JumpPalette groups={jumpGroups} onGo={jumpTo}
        onClose={() => setJumpOpen(false)} />}
      {scanning && <ScanningOverlay url={scanning.url} name={scanning.name}
        vision={!!providers.claude_vision} />}
      {/* At the app root, not in the header the bell sits in: everything under
          .topbar is styled for the dark chrome, and a light panel mounted there
          inherits white button text on a white card. */}
      {notifsOpen && <NotificationPanel go={setTab} user={user} toast={toast}
        onClose={() => setNotifsOpen(false)}
        onChanged={() => setNotifTick((t) => t + 1)} />}
      {showSettings && <VisionSettings onClose={() => setShowSettings(false)}
        onChanged={refreshStatus} toast={toast} />}
      {showPassword && <ChangePassword onClose={() => setShowPassword(false)} toast={toast} />}
      {toastMsg && <div className={'toast ' + toastMsg.kind}>{toastMsg.m}</div>}
    </div>
  )

  // ==========================================================================
  //  One module, rendered by key
  //  ------------------------------------------------------------------------
  //  This was an inline ternary chain on `tab`. It takes the key as an ARGUMENT
  //  now, which is the only change: every branch maps the same key to the same
  //  screen it always did. Taking a parameter is what lets an open-but-inactive
  //  tab be rendered at all.
  // ==========================================================================
  function screenFor(k) {
    // A `pos:` tab is a screen of the shop rather than one of ours, and is
    // served in a frame — so it is answered before the warehouse chain.
    const ps = posItems.find((p) => p && p.key === k)
    if (ps) return <PosScreen screen={ps} available={status?.pos?.available}
      error={status?.pos?.error} warehouse={here} />
    // A Store screen this account is not given draws nothing for the one render
    // before the reconciling effect above moves it to the counter — rather than
    // loading a frame the shop would only refuse.
    if (String(k).startsWith('pos:')) return null
    return (
      k === 'dashboard' ? (
        <Dashboard modules={modules} go={setTab} company={status?.company?.name}
          docs={docs} refreshDocs={refresh} user={user} openDeadStock={openDeadStock}
          here={here} />
      ) : k === 'purchase_orders' ? (
        <PurchaseOrdersView toast={toast} />
      ) : k === 'lr' ? (
        <div className="body"><LREntryView toast={toast} /></div>
      ) : k === 'documents' ? (
        <div className="body">
          <Sidebar id="documents" label="Documents">
            <div className="head"><h3>Documents · {docs.length}</h3>
              {/* Back to the saved-invoice search — every GRN invoice, not only
                  the documents listed here. */}
              <button className="btn" style={{ padding: '3px 9px', fontSize: 11 }}
                onClick={() => setSel(null)} title="Search every saved invoice by number, supplier or GRN">🔍 Find invoice</button>
              {/* Emptying every transaction table is irreversible and global,
                  so it is a super admin's button even though this screen is
                  the floor's. The server refuses it for anyone else too. */}
              {docs.length > 0 && isSuper && <button className="btn" style={{ padding: '3px 9px', fontSize: 11 }}
                onClick={clearAll} title="Delete all documents & transaction data">Clear all</button>}</div>
            {docs.length > 0 && <>
              <SearchBox value={docQuery} onChange={setDocQuery}
                placeholder="Search supplier, invoice, status…" />
              <div className="toolbar"><FilterChips value={docScope} onChange={setDocScope} options={[
                ['needs_review', 'To review', docs.filter((d) => d.status === 'needs_review').length, 'Read, but something did not reconcile'],
                ['confirmed', 'Confirmed', docs.filter((d) => d.status === 'confirmed').length, 'Corrected and saved'],
                ['posted', 'Posted', docs.filter((d) => d.status === 'posted').length, 'Already booked into stock'],
                ['all', 'All', docs.length, 'Every document'],
              ]} /></div>
            </>}
            <div className="list">
              {docs.length === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>
                No documents. Click “Upload invoice” to read one from a scan,
                or “New entry” to key one in by hand.</div>}
              {docs.length > 0 && shownDocs.length === 0 && <div className="empty" style={{ marginTop: 30, fontSize: 13 }}>
                Nothing matches. Try “All” or clear the search.</div>}
              {docPage.slice.map((d) => (
                <div key={d.id} className={'doc-row' + (sel === d.id ? ' sel' : '')} onClick={() => setSel(d.id)}>
                  <div className="t" style={{ display: 'flex', alignItems: 'center' }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.supplier_name || d.filename}</span>
                    <button className="rowdel" title="Delete document" onClick={(e) => delOne(e, d.id)}>×</button>
                  </div>
                  <div className="m">
                    <span className={'badge ' + d.status}>{d.status.replace('_', ' ')}</span>
                    <span>#{d.invoice_number || '—'}</span>
                    {/* a hand-keyed row says so instead of wearing a red 0% —
                        see the same swap on the review panel's header */}
                    {d.has_image === false
                      ? <span style={{ marginLeft: 'auto' }} title="Keyed in by hand — there is no scan behind this one">✍ typed</span>
                      : <span style={{ marginLeft: 'auto' }} className={'conf ' + confClass(d.confidence)}>{d.confidence != null ? Math.round(d.confidence * 100) + '%' : ''}</span>}
                  </div>
                  <div className="m"><span>₹ {money(d.grand_total)}</span></div>
                </div>
              ))}
            </div>
            <Pager {...docPage} noun="document" />
          </Sidebar>
          {/* nothing picked: the saved-invoice search, not an empty pane */}
          {sel ? <Review docId={sel} onSaved={refresh} onCreateGrn={gotoPurchase} toast={toast} />
            : <InvoiceFinder onOpenGrn={gotoPurchase} />}
        </div>
      ) : k === 'purchases' ? (
        <Purchases selId={selPurchase} setSelId={setSelPurchase} toast={toast} />
      ) : k === 'inventory' ? (
        <Inventory toast={toast} />
      ) : k === 'deadstock' ? (
        <DeadStock toast={toast} go={setTab} intent={dsIntent}
          onIntentUsed={() => setDsIntent(null)} />
      ) : k === 'labels' ? (
        <LabelDesigner toast={toast} role={role} />
      ) : k === 'locator' ? (
        <ItemLocator toast={toast} />
      ) : k === 'stock_audit' ? (
        <StockAuditView toast={toast} />
      ) : k === 'physical_audit' ? (
        // `role` because Apply — the only act here that moves stock — is admin,
        // and the button says so rather than failing on a press.
        <PhysicalAuditView toast={toast} role={role} />
      ) : k === 'pricing' ? (
        <PriceChanger toast={toast} role={role} />
      ) : k === 'labelprint' ? (
        <LabelPrinting toast={toast} />
      ) : k === 'outward' ? (
        <StockOutward toast={toast} />
      ) : k === 'inward' ? (
        <StockInward toast={toast} />
      ) : k === 'returns' ? (
        <Returns toast={toast} />
      ) : k === 'payments' ? (
        <Payments toast={toast} />
      ) : k === 'reports' ? (
        <Reports />
      ) : k === 'masters' ? (
        // No role check here any more — the guard above the chain covers every
        // module from its MODULES entry, so this cannot drift out of step with
        // the menu the way a second copy of the rule would.
        <Masters toast={toast} />
      ) : k === 'pickwh' ? (
        <ChooseWarehouse onEnter={enterWarehouse} user={user} />
      ) : k === 'command' ? (
        <CommandCenter go={setTab} toast={toast} user={user} role={role}
          onEnter={enterWarehouse} />
      ) : k === 'audit' ? (
        <AuditTrail go={setTab} />
      ) : k === 'central' ? (
        <CentralDashboard toast={toast} go={setTab} onEnter={enterWarehouse} />
      ) : k === 'catalogues' ? (
        <Catalogues toast={toast} />
      ) : k === 'locations' ? (
        <Locations toast={toast} />
      ) : k === 'users' ? (
        <Users toast={toast} me={user} />
      ) : k === 'suppliers' ? (
        <Suppliers toast={toast} />
      ) : (
        // an unknown saved tab (a module renamed since it was stored) lands on
        // the dashboard rather than on a blank screen
        <Dashboard modules={modules} go={setTab} company={status?.company?.name}
          docs={docs} refreshDocs={refresh} user={user} openDeadStock={openDeadStock}
          here={here} />
      )
    )
  }
}
