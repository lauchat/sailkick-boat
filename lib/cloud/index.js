'use strict'

// Authenticated client for the boat's own cloud account, so the app on board can copy
// polars and routes to and from the cloud copy.
//
// Why the PLUGIN holds the credential rather than the browser: the cloud session cookie
// is `HttpOnly; SameSite=Lax; Secure` (server/auth/session.js), and the boat serves the
// app over plain HTTP on a LAN address. A browser will not store a Secure cookie on an
// http origin, will not send a Lax cookie cross-site, and blocks an https page from
// fetching http at all — so no arrangement of buttons in the browser can bridge the two.
// Every one of those is a BROWSER rule. Here the plugin is an ordinary HTTP client
// talking https to the cloud, so none of them apply, and the browser only ever talks to
// the boat, same-origin.
//
// COOKIE ONLY. The password is used once to obtain a session and is never written to
// disk: a stored password would let the boat act as the account indefinitely, which is a
// large escalation over the bucket-scoped write token sync uses. The cost is that the
// session expires (30 days, server/auth/session.js TTL_SEC) and has to be renewed by
// hand. That trade was chosen deliberately.
//
// These endpoints are mounted on the PLUGIN ROUTER, not the open mirror on :8080. The
// plugin router sits behind Signal K's own security (verified: /plugins/sailkick-boat/*
// answers 401 unauthenticated, the mirror answers 200), so the cloud session is no more
// exposed than the admin UI itself. On the mirror it would be handed to anyone on the
// boat's wifi.

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
// Named to avoid shadowing this module's own request() below.
const { request: httpRequest } = require('../net')

const COOKIE_NAME = 'sk_session'
const MAX_BODY_BYTES = 8 * 1024 * 1024 // a polar CSV is tiny; this is just a sane ceiling

function createCloud (app, options = {}) {
  const log = (m) => (app.debug ? app.debug('[cloud] ' + m) : console.log('[sailkick-boat:cloud]', m))
  const warn = (m) => (app.error ? app.error('[sailkick-boat:cloud] ' + m) : console.error('[sailkick-boat:cloud]', m))

  const upstream = String(options.upstream || '').replace(/\/+$/, '')
  const dataDir = options.dataDir || (app.getDataDirPath && app.getDataDirPath()) || '.'
  const file = options.sessionFile || path.join(dataDir, 'cloud-session.json')
  const timeoutMs = options.timeoutMs || 20000

  let session = null // { cookie, slug, expiresAt }

  function load () {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (j && j.cookie) session = j
    } catch { /* absent or corrupt — simply logged out */ }
    if (session && session.expiresAt && Date.now() > session.expiresAt) {
      log('stored cloud session had expired — logged out')
      session = null
      remove()
    }
  }

  async function persist () {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      await fsp.writeFile(tmp, JSON.stringify(session), { mode: 0o600 })
      await fsp.rename(tmp, file)
    } catch (e) { warn('could not persist the cloud session: ' + e.message) }
  }
  function remove () { try { fs.unlinkSync(file) } catch {} }

  // Pull our cookie out of a Set-Cookie response. getSetCookie() is the correct API when
  // several cookies come back; fall back for older runtimes.
  function readCookie (headers) {
    const all = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean)
    for (const raw of all) {
      const first = String(raw).split(';')[0]
      if (first.startsWith(COOKIE_NAME + '=')) {
        const maxAge = /max-age=(\d+)/i.exec(raw)
        return { cookie: first, expiresAt: maxAge ? Date.now() + Number(maxAge[1]) * 1000 : null }
      }
    }
    return null
  }

  // Node wraps every transport failure as the useless message "fetch failed" and hides
  // the real reason in e.cause — ENOTFOUND, ECONNRESET, ETIMEDOUT and a TLS failure are
  // very different problems and want different fixes, so say which.
  const why = (e) => {
    const c = e && e.cause
    const code = c && (c.code || c.message)
    return code ? `${e.message}: ${code}` : (e ? e.message : 'unknown')
  }

  // Retry TRANSPORT failures only — never an HTTP status, so a 401 stays a 401. This
  // boat's link drops for a second or two at a time (live sync recovers after a single
  // attempt), and a button that dead-ends on the first blip is needlessly fragile.
  async function attempt (fn, tries = 3) {
    let last
    for (let i = 0; i < tries; i++) {
      try { return { ok: true, value: await fn() } } catch (e) {
        last = e
        if (i < tries - 1) await new Promise((resolve) => setTimeout(resolve, 400 * Math.pow(3, i)))
      }
    }
    return { ok: false, error: last }
  }

  async function login (slug, password) {
    if (!upstream) return { ok: false, code: 'no-upstream', message: 'no cloud host configured' }
    const got = await attempt(() => httpRequest(`${upstream}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, password }),
      timeoutMs
    }))
    if (!got.ok) {
      warn(`login could not reach ${upstream} after 3 attempts — ${why(got.error)}`)
      return { ok: false, code: 'offline', message: `cannot reach ${upstream} — ${why(got.error)}. The boat's link may have dropped; try again.` }
    }
    const r = got.value
    if (r.status === 401) return { ok: false, code: 'bad-credentials', message: 'wrong boat name or password' }
    if (!r.ok) return { ok: false, code: 'login-failed', message: `the cloud replied HTTP ${r.status}` }
    const cookie = readCookie(r.headers)
    if (!cookie) return { ok: false, code: 'no-session', message: 'the cloud accepted the login but sent no session' }

    let name = slug
    try { const j = await r.json(); name = (j && j.boat && (j.boat.slug || j.boat.name)) || slug } catch {}
    session = { cookie: cookie.cookie, slug: name, expiresAt: cookie.expiresAt }
    await persist()
    log(`logged in to ${upstream} as ${name}${cookie.expiresAt ? `; session valid until ${new Date(cookie.expiresAt).toISOString().slice(0, 10)}` : ''}`)
    return { ok: true, ...status() }
  }

  function logout () {
    session = null
    remove()
    log('cloud session cleared')
    return { ok: true, ...status() }
  }

  function status () {
    if (!session) return { loggedIn: false, upstream }
    return {
      loggedIn: true,
      upstream,
      slug: session.slug,
      expiresAt: session.expiresAt || null,
      expiresInDays: session.expiresAt ? Math.max(0, Math.round((session.expiresAt - Date.now()) / 86400000)) : null
    }
  }

  // One authenticated request against the cloud. Never throws: the caller is an HTTP
  // handler and a boat is offline most of the time.
  async function request (apiPath, { method = 'GET', body = null } = {}) {
    if (!session) return { ok: false, status: 401, code: 'logged-out', message: 'not logged in to the cloud' }
    const got = await attempt(() => httpRequest(upstream + apiPath, {
      method,
      headers: {
        Cookie: session.cookie,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body || null,
      timeoutMs
    }))
    if (!got.ok) {
      return { ok: false, status: 0, code: 'offline', message: `cannot reach the cloud — ${why(got.error)}. The boat's link may have dropped; try again.` }
    }
    const r = got.value
    // A 401 means the session died (expired, or revoked by a logout elsewhere). Clear it
    // so the page shows a login form instead of silently failing every button.
    if (r.status === 401) {
      session = null
      remove()
      warn('the cloud session is no longer valid — log in again on the Sync page')
      return { ok: false, status: 401, code: 'logged-out', message: 'the cloud session expired — log in again' }
    }
    const text = await r.text().catch(() => '')
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { ok: r.ok, status: r.status, json, text }
  }

  // ---- HTTP surface, mounted on the plugin router --------------------------------
  const send = (res, code, obj) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(obj))
  }

  // Signal K mounts plugin routers AFTER its own bodyParser.json(), so on that path the
  // body is already parsed and the request stream is spent — listening for 'data'/'end'
  // waits for events that will never fire, and the request hangs for ever with no error.
  // (That is exactly what happened: the Sync page sat on "Signing in…".) On the mirror
  // there is no body parser and the stream is live, so both paths must be handled.
  function readJson (req) {
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') {
        if (!req.body.trim()) return Promise.resolve(null)
        try { return Promise.resolve(JSON.parse(req.body)) } catch { return Promise.resolve(undefined) }
      }
      if (typeof req.body === 'object') {
        // bodyParser.json() gives {} for an absent body; treat that as "nothing sent".
        return Promise.resolve(Object.keys(req.body).length || Array.isArray(req.body) ? req.body : null)
      }
    }
    if (req.readableEnded || req.complete) return Promise.resolve(null) // stream already drained
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY_BYTES) { req.destroy(); resolve(undefined); return }
        chunks.push(c)
      })
      req.on('error', () => resolve(undefined))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw.trim()) return resolve(null)
        try { resolve(JSON.parse(raw)) } catch { resolve(undefined) }
      })
    })
  }

  // `rest` is the path after /cloud — '', 'status', 'login', 'logout', 'profile/...'
  async function handle (rest, req, res) {
    const [head, ...tail] = String(rest || '').replace(/^\/+/, '').split('/')
    const method = req.method === 'HEAD' ? 'GET' : req.method

    if (head === 'status' && method === 'GET') return send(res, 200, { ok: true, ...status() })

    if (head === 'logout' && method === 'POST') return send(res, 200, logout())

    if (head === 'login' && method === 'POST') {
      const body = await readJson(req)
      if (!body || typeof body !== 'object') return send(res, 400, { ok: false, code: 'bad-body', message: 'send {slug, password}' })
      const r = await login(String(body.slug || '').trim(), String(body.password || ''))
      return send(res, r.ok ? 200 : (r.code === 'bad-credentials' ? 401 : 502), r)
    }

    // Everything under /cloud/profile is relayed verbatim to the cloud's own profile API,
    // so polars and routes need no per-section code here — the shapes already match the
    // boat's local copy (lib/profile/index.js mirrors the same router).
    if (head === 'profile') {
      const body = (method === 'POST' || method === 'PUT') ? JSON.stringify(await readJson(req)) : null
      const target = '/api/profile' + (tail.length ? '/' + tail.map(encodeURIComponent).join('/') : '')
      const r = await request(target, { method, body })
      if (!r.ok && r.code) return send(res, r.status === 401 ? 401 : 502, { ok: false, code: r.code, message: r.message })
      res.statusCode = r.status
      res.setHeader('Content-Type', 'application/json')
      return res.end(r.text || '{}')
    }

    send(res, 404, { ok: false, code: 'not-found', message: `${req.method} /cloud/${rest} not found` })
  }

  function start () {
    load()
    log(session ? `cloud session for "${session.slug}" loaded` : 'no cloud session — log in on the Sync page to copy polars and routes')
  }
  function stop () { session = null }

  return { start, stop, handle, status, login, logout, request, _file: () => file }
}

module.exports = { createCloud, COOKIE_NAME }
