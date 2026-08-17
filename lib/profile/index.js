'use strict'

// Per-boat profile (routes, polars, settings), served from the boat itself.
//
// The app reads and writes routes through /api/profile/routes. On the cloud that
// router is requireBoat-gated, and the mirror can never satisfy it: the GET cache path
// forwards no headers at all, and even if it did, the browser is on the boat's LAN
// origin and holds no cloud cookie to forward. So every /api/profile call through the
// mirror returned 401 — the route panel showed nothing, mobile route-weather silently
// fell back to dead reckoning, and saving a route failed. Offline it was a 504.
//
// Same answer as history and AIS: serve it locally. The boat is single-tenant, so
// there is nothing to authenticate; and route planning offshore is exactly when the
// cloud is unreachable, which makes local the more useful copy rather than a
// compromise.
//
// Contract: byte-for-byte the envelopes of the cloud's server/routes/profile.js, over
// the same storage shape as server/profile/store.js (one JSON file, atomic writes,
// serialized so concurrent saves can't clobber). public/ui/route-panel.js and
// public/mobile/route-weather.js cannot tell the difference.
//
// Boat-local is AUTHORITATIVE here and does not sync: a route saved on board stays on
// board, a route saved in the webapp stays in the cloud. That divergence is deliberate
// for now — merging the two needs conflict resolution that is worth designing on its
// own rather than guessing at.

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { randomBytes } = require('crypto')

const SECTIONS = ['polars', 'routes'] // item sections, as the cloud router defines them
const MAX_BODY_BYTES = 4 * 1024 * 1024 // a polar table is the big one; well under this
const emptyProfile = () => ({ polars: [], activePolar: null, routes: [], settings: {} })
const newId = () => randomBytes(8).toString('hex')
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function createProfile (app, options = {}) {
  const log = (m) => (app.debug ? app.debug('[profile] ' + m) : console.log('[sailkick-boat:profile]', m))
  const warn = (m) => (app.error ? app.error('[sailkick-boat:profile] ' + m) : console.error('[sailkick-boat:profile]', m))

  const dataDir = options.dataDir || (app.getDataDirPath && app.getDataDirPath()) || '.'
  const file = options.file || path.join(dataDir, 'profile.json')
  let queue = Promise.resolve() // serializes read-modify-write, as the cloud store does
  let lastError = null
  let writes = 0

  async function load () {
    try {
      return { ...emptyProfile(), ...JSON.parse(await fsp.readFile(file, 'utf8')) }
    } catch (e) {
      if (e.code === 'ENOENT') return emptyProfile() // first use
      throw e // corrupt or unreadable — surface it rather than silently resetting
    }
  }

  async function save (profile) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(profile, null, 2), { mode: 0o600 })
    await fsp.rename(tmp, file) // atomic on POSIX — a yanked power cable can't truncate it
    writes++
    return profile
  }

  // mutator(profile) may mutate in place and/or return the next profile.
  function update (mutator) {
    const run = async () => {
      const p = await load()
      return save((await mutator(p)) || p)
    }
    const next = queue.then(run, run) // run regardless of how the previous one ended
    queue = next.then(() => {}, () => {}) // the tail must never reject
    return next
  }

  // ---- HTTP ------------------------------------------------------------------
  const send = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const notFound = (res, what) => send(res, 404, { ok: false, code: 'not-found', message: `${what} not found` })
  const badBody = (res, what) => send(res, 400, { ok: false, code: 'bad-body', message: `${what} must be a JSON object` })
  const failed = (res, e) => { lastError = e.message; warn(e.message); send(res, 500, { ok: false, code: 'profile-error', message: e.message }) }

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
        try { resolve(JSON.parse(raw)) } catch { resolve(undefined) } // undefined = malformed
      })
    })
  }

  // True for anything this module owns, so the mirror can hand it over before the
  // cache/proxy path sees it.
  function handles (reqPath) {
    const p = String(reqPath).split('?')[0]
    return p === '/api/profile' || p.startsWith('/api/profile/')
  }

  async function handle (req, res) {
    try {
      const [rawPath, query] = String(req.url).split('?')
      const rest = rawPath.slice('/api/profile'.length).replace(/^\//, '') // '' | 'settings' | 'routes' | 'routes/<id>'
      const [head, rawId] = rest.split('/')
      const id = rawId ? decodeURIComponent(rawId) : null
      const method = req.method === 'HEAD' ? 'GET' : req.method

      // GET /api/profile[?section=…] — whole profile or one section
      if (head === '' && method === 'GET') {
        const section = new URLSearchParams(query || '').get('section')
        const p = await load()
        return send(res, 200, { ok: true, profile: section ? p[section] : p })
      }

      if (head === 'settings') {
        if (method === 'GET') return send(res, 200, { ok: true, settings: (await load()).settings || {} })
        if (method === 'PUT') {
          const body = await readJson(req)
          if (!isObj(body)) return badBody(res, 'settings')
          await update((p) => { p.settings = body; return p })
          return send(res, 200, { ok: true })
        }
      }

      if (head === 'active-polar' && method === 'PUT') {
        const body = await readJson(req)
        await update((p) => { p.activePolar = (body && body.id != null) ? body.id : null; return p })
        return send(res, 200, { ok: true })
      }

      if (SECTIONS.includes(head)) {
        if (method === 'GET' && !id) {
          const arr = (await load())[head]
          return send(res, 200, { ok: true, [head]: Array.isArray(arr) ? arr : [] })
        }
        if (method === 'GET') {
          const item = ((await load())[head] || []).find((x) => x && x.id === id)
          return item ? send(res, 200, { ok: true, item }) : notFound(res, `${head}/${id}`)
        }
        if (method === 'POST' && !id) {
          const body = await readJson(req)
          if (!isObj(body)) return badBody(res, `${head} item`)
          const item = { ...body, id: newId(), updatedAt: Date.now() }
          await update((p) => { (Array.isArray(p[head]) ? p[head] : (p[head] = [])).push(item); return p })
          return send(res, 201, { ok: true, item })
        }
        if (method === 'PUT' && id) {
          const body = await readJson(req)
          if (!isObj(body)) return badBody(res, `${head} item`)
          let missing = false
          const item = { ...body, id, updatedAt: Date.now() }
          await update((p) => {
            const arr = Array.isArray(p[head]) ? p[head] : (p[head] = [])
            const i = arr.findIndex((x) => x && x.id === id)
            if (i < 0) { missing = true; return p } // 404, and nothing is written
            arr[i] = { ...arr[i], ...item }
            return p
          })
          return missing ? notFound(res, `${head}/${id}`) : send(res, 200, { ok: true, item })
        }
        if (method === 'DELETE' && id) {
          await update((p) => { p[head] = (p[head] || []).filter((x) => x && x.id !== id); return p })
          return send(res, 200, { ok: true })
        }
      }

      send(res, 404, { ok: false, code: 'not-found', message: `${req.method} ${rawPath} not found` })
    } catch (e) { failed(res, e) }
  }

  function start () { log(`serving /api/profile from ${file} (boat-local; not synced with the cloud copy)`) }
  function stop () {}
  function available () { return true } // a local file — no reason it would not be
  function status () {
    return `profile: local${writes ? `, ${writes} save(s)` : ''}${lastError ? ` (last error: ${lastError})` : ''}`
  }

  return { start, stop, status, available, handles, handle, _load: load, _file: () => file }
}

module.exports = { createProfile, SECTIONS }
