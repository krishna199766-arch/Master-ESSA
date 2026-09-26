// ==========================================================================
//  The dashboards, held between visits
//  ------------------------------------------------------------------------
//  The Command Center, the Central Dashboard, a warehouse's dashboard and its
//  charts are the screens people flick between all day, and each used to open
//  on "Loading…" every time — the component unmounts when you leave it, and the
//  Central/Warehouse switch remounts everything under the new context.
//
//  So their data lives HERE, outside React, keyed on who is signed in, which
//  workspace it was read in and the screen's own parameters. A screen that
//  opens draws whatever is held at once and re-reads in the background
//  (stale-while-revalidate); the shell warms every key ahead of time (see
//  warmDashboards in App.jsx), so even the first visit usually has something.
//
//  Memory only, never localStorage: the next person at a shared terminal must
//  not be shown the last one's figures, and a sign-out empties it (reset).
// ==========================================================================
import { useEffect, useRef, useState } from 'react'

const entries = new Map()     // key -> { data, error, at }
const inflight = new Map()    // key -> promise
const listeners = new Map()   // key -> Set of re-render callbacks
// Small things a screen wants back when it is opened again — which report was
// on screen, with which filters. Emptied with everything else by reset().
const memory = new Map()
// Bumped by reset(). A read that was in flight across a sign-out lands in a
// generation that no longer exists and is dropped rather than cached.
let generation = 0

const notify = (key) => (listeners.get(key) || new Set()).forEach((fn) => fn())

/** Forget everything — on sign-out, and when a different account signs in. */
export function reset() {
  generation += 1
  entries.clear()
  inflight.clear()
  memory.clear()
  listeners.forEach((set, key) => notify(key))
}

export const peek = (key) => entries.get(key)

export const remember = (key, value) => { memory.set(key, value) }
export const recall = (key) => memory.get(key)

/**
 * Hold at most `max` entries whose key starts with `prefix`, dropping the
 * least recently read first. For the report results: a year's stock register
 * is thousands of rows, and somebody clicking down the list of thirty-three
 * reports should not end the day holding every one of them. An entry a screen
 * is showing right now is never the one dropped.
 */
export function trim(prefix, max) {
  const keys = [...entries.keys()].filter((k) => k.startsWith(prefix))
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) {
    if (!listeners.get(k)?.size && !inflight.has(k)) entries.delete(k)
  }
}

/**
 * Read `key` through `fetcher`, sharing a read already in flight. `fresh` (ms)
 * skips the read when what is held is younger than that — which is what stops
 * a warm-up and the screen opening a moment later from asking twice.
 *
 * `fetcher` is called SYNCHRONOUSLY, never from a .then: asWarehouse pins the
 * warehouse header only for the length of the call, and a deferred call would
 * go out under whatever workspace is on screen instead.
 */
export function load(key, fetcher, { fresh = 0 } = {}) {
  const held = entries.get(key)
  if (held && !held.error && fresh && Date.now() - held.at < fresh) return Promise.resolve(held.data)
  if (inflight.has(key)) return inflight.get(key)
  const gen = generation
  let p
  try { p = Promise.resolve(fetcher()) } catch (e) { p = Promise.reject(e) }
  const done = p.then((data) => {
    if (gen !== generation) return data
    entries.delete(key)      // re-inserted at the end: Map order is recency, for trim()
    entries.set(key, { data, error: null, at: Date.now() })
    return data
  }, (error) => {
    // What was held stays on screen; the error sits beside it for the screen
    // to mention. A dashboard that blanked because one refresh failed would be
    // worse than one that is a minute old.
    if (gen === generation) entries.set(key, { ...(entries.get(key) || {}), error, at: Date.now() })
    throw error
  }).finally(() => {
    if (inflight.get(key) === done) inflight.delete(key)
    if (gen === generation) notify(key)
  })
  inflight.set(key, done)
  notify(key)
  return done
}

/**
 * The hook a dashboard reads through. `data` is whatever is held for `key`
 * (undefined only on a true first visit), `busy` is true while a read is out,
 * and `refresh` re-reads regardless of age. Opening the screen always
 * revalidates unless the held copy is younger than `fresh`. A null `key` reads
 * nothing — for a screen that cannot say what it wants until something else
 * has loaded.
 */
export function useCached(key, fetcher, { fresh = 5000 } = {}) {
  const [, bump] = useState(0)
  const fref = useRef(fetcher)
  fref.current = fetcher
  useEffect(() => {
    if (!key) return undefined         // nothing to read yet
    const fn = () => bump((n) => n + 1)
    if (!listeners.has(key)) listeners.set(key, new Set())
    listeners.get(key).add(fn)
    load(key, () => fref.current(), { fresh }).catch(() => {})
    return () => { listeners.get(key)?.delete(fn) }
  }, [key, fresh])
  const held = key ? entries.get(key) : undefined
  return {
    data: held?.data,
    error: held?.error || null,
    busy: !!key && inflight.has(key),
    refresh: () => (key ? load(key, () => fref.current()) : Promise.resolve()),
  }
}
