'use strict'

// Cloud account session — the credential holder behind the Sync page.
//
// The whole reason this lives in the plugin: the cloud session cookie is
// `HttpOnly; SameSite=Lax; Secure`, and the boat serves the app over plain HTTP on a LAN
// address. A browser refuses to store a Secure cookie on an http origin, refuses to send
// a Lax cookie cross-site, and blocks an https page from fetching http at all. Those are
// all BROWSER rules — the plugin is an ordinary HTTP client, so none apply.
//
// COOKIE ONLY: the password buys a session and is never written to disk.

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createCloud } = require('../lib/cloud')

const app = { debug () {}, error () {} }
let seq = 0
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), `sk-cloud-${process.pid}-${seq++}-`))
const COOKIE = 'sk_session=abc.def.ghi'

// A stand-in for the cloud: /api/auth/login mints the same cookie shape the real server
// does, and /api/profile/* requires it.
function fakeCloud (opts = {}) {
  const seen = { logins: 0, authed: 0, cookies: [] }
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      if (req.url === '/api/auth/login') {
        seen.logins++
        const { slug, password } = JSON.parse(body || '{}')
        if (password !== 'right') { res.statusCode = 401; res.end('{"ok":false,"code":"bad-credentials"}'); return }
        res.setHeader('Set-Cookie', `${COOKIE}; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=2592000`)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, boat: { slug, name: slug } }))
        return
      }
      seen.cookies.push(req.headers.cookie || null)
      if (opts.expired || req.headers.cookie !== COOKIE) { res.statusCode = 401; res.end('{"ok":false}'); return }
      seen.authed++
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, polars: [{ id: 'c1', name: 'Addiction', csv: 'x' }] }))
    })
  })
  return { srv, seen }
}
const listen = (s) => new Promise((r) => s.listen(0, r))
const shut = (s) => new Promise((r) => { s.closeAllConnections && s.closeAllConnections(); s.close(r) })

// Drive handle() over real HTTP so routing, bodies and status codes are all real.
function serve (cloud) {
  const srv = http.createServer((req, res) => {
    const m = /^\/cloud\/?(.*)$/.exec(req.url.split('?')[0])
    if (!m) { res.statusCode = 404; res.end(); return }
    cloud.handle(m[1], req, res)
  })
  return new Promise((r) => srv.listen(0, () => r(srv)))
}
async function call (srv, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, json, text }
}

test('cloud: a good login stores the SESSION and never the password', async () => {
  const f = fakeCloud(); await listen(f.srv)
  const dir = tmpDir()
  const cloud = createCloud(app, { upstream: `http://127.0.0.1:${f.srv.address().port}`, dataDir: dir })
  cloud.start()
  assert.strictEqual(cloud.status().loggedIn, false, 'starts logged out')

  const r = await cloud.login('addiction', 'right')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(cloud.status().loggedIn, true)
  assert.strictEqual(cloud.status().slug, 'addiction')
  assert.ok(cloud.status().expiresInDays >= 29, 'the 30-day TTL is carried through')

  const onDisk = fs.readFileSync(cloud._file(), 'utf8')
  assert.match(onDisk, /sk_session=/, 'the session is persisted')
  assert.doesNotMatch(onDisk, /right/, 'THE PASSWORD IS NOT ON DISK')
  assert.strictEqual(fs.statSync(cloud._file()).mode & 0o777, 0o600, 'and the file is owner-only')
  await shut(f.srv)
})

test('cloud: a bad password is reported, not stored', async () => {
  const f = fakeCloud(); await listen(f.srv)
  const cloud = createCloud(app, { upstream: `http://127.0.0.1:${f.srv.address().port}`, dataDir: tmpDir() })
  cloud.start()
  const r = await cloud.login('addiction', 'wrong')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'bad-credentials')
  assert.strictEqual(cloud.status().loggedIn, false)
  assert.strictEqual(fs.existsSync(cloud._file()), false, 'nothing written')
  await shut(f.srv)
})

test('cloud: the session survives a restart, and requests carry the cookie', async () => {
  const f = fakeCloud(); await listen(f.srv)
  const dir = tmpDir()
  const up = `http://127.0.0.1:${f.srv.address().port}`
  const first = createCloud(app, { upstream: up, dataDir: dir })
  first.start()
  await first.login('addiction', 'right')
  first.stop()

  const second = createCloud(app, { upstream: up, dataDir: dir }) // a plugin restart
  second.start()
  assert.strictEqual(second.status().loggedIn, true, 'reloaded from disk — no second login')
  const r = await second.request('/api/profile/polars')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(f.seen.logins, 1, 'logged in exactly once')
  assert.strictEqual(f.seen.cookies[f.seen.cookies.length - 1], COOKIE, 'the cookie was attached')
  await shut(f.srv)
})

test('cloud: a 401 clears the session so the page shows a login form again', async () => {
  const f = fakeCloud({ expired: true }); await listen(f.srv)
  const dir = tmpDir()
  const cloud = createCloud(app, { upstream: `http://127.0.0.1:${f.srv.address().port}`, dataDir: dir })
  cloud.start()
  // seed a session by hand, as if it had been valid yesterday
  fs.writeFileSync(cloud._file(), JSON.stringify({ cookie: COOKIE, slug: 'addiction', expiresAt: Date.now() + 8.64e7 }))
  cloud.stop(); cloud.start()
  assert.strictEqual(cloud.status().loggedIn, true)

  const r = await cloud.request('/api/profile/polars')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'logged-out')
  assert.strictEqual(cloud.status().loggedIn, false, 'cleared')
  assert.strictEqual(fs.existsSync(cloud._file()), false, 'and removed from disk')
  await shut(f.srv)
})

test('cloud: an expired session is discarded on load, not offered', async () => {
  const dir = tmpDir()
  const cloud = createCloud(app, { upstream: 'http://127.0.0.1:1', dataDir: dir })
  const file = cloud._file()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ cookie: COOKIE, slug: 'x', expiresAt: Date.now() - 1000 }))
  cloud.start()
  assert.strictEqual(cloud.status().loggedIn, false)
  assert.strictEqual(fs.existsSync(file), false)
})

test('cloud: offline is reported plainly, and never throws', async () => {
  const cloud = createCloud(app, { upstream: 'http://127.0.0.1:1', dataDir: tmpDir(), timeoutMs: 300 })
  cloud.start()
  const r = await cloud.login('addiction', 'right')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'offline')
  assert.match(r.message, /cannot reach/)
})

test('cloud: the HTTP surface — status, login, relay, logout', async () => {
  const f = fakeCloud(); await listen(f.srv)
  const cloud = createCloud(app, { upstream: `http://127.0.0.1:${f.srv.address().port}`, dataDir: tmpDir() })
  cloud.start()
  const srv = await serve(cloud)

  assert.strictEqual((await call(srv, 'GET', '/cloud/status')).json.loggedIn, false)

  // relaying while logged out must be a clean 401, not a stack trace
  const before = await call(srv, 'GET', '/cloud/profile/polars')
  assert.strictEqual(before.status, 401)
  assert.strictEqual(before.json.code, 'logged-out')

  assert.strictEqual((await call(srv, 'POST', '/cloud/login', { slug: 'addiction', password: 'wrong' })).status, 401)
  const ok = await call(srv, 'POST', '/cloud/login', { slug: 'addiction', password: 'right' })
  assert.strictEqual(ok.status, 200)
  assert.strictEqual(ok.json.loggedIn, true)

  const relayed = await call(srv, 'GET', '/cloud/profile/polars')
  assert.strictEqual(relayed.status, 200)
  assert.deepStrictEqual(relayed.json.polars, [{ id: 'c1', name: 'Addiction', csv: 'x' }], 'the cloud body passes through verbatim')

  assert.strictEqual((await call(srv, 'POST', '/cloud/logout')).json.loggedIn, false)
  assert.strictEqual((await call(srv, 'GET', '/cloud/status')).json.loggedIn, false)

  await shut(srv); await shut(f.srv)
})

test('cloud: a malformed login body is a 400, not a crash', async () => {
  const cloud = createCloud(app, { upstream: 'http://127.0.0.1:1', dataDir: tmpDir(), timeoutMs: 200 })
  cloud.start()
  const srv = await serve(cloud)
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/cloud/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json'
  })
  assert.strictEqual(r.status, 400)
  await shut(srv)
})

// --- the Sync page's matching rules -------------------------------------------------
// Ids are assigned independently on each side (newId() on the boat, the same on the
// cloud), so an item present in both has TWO different ids and only its name is stable
// across the boundary. These are the rules public/sync.html implements; pinning them
// here because getting them wrong silently duplicates or overwrites a user's polars.
const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'sync.html'), 'utf8')
const key = (i) => String((i && i.name) || '').trim().toLowerCase()
const same = (a, b, section) => section === 'polars'
  ? String(a.csv || '') === String(b.csv || '')
  : JSON.stringify(a.path || null) === JSON.stringify(b.path || null) &&
    JSON.stringify(a.destination || null) === JSON.stringify(b.destination || null)

test('sync page: matches by name, never by id', () => {
  assert.strictEqual(key({ id: 'boat-1', name: 'Addiction' }), key({ id: 'cloud-9', name: 'addiction' }),
    'same polar, different ids and casing — still one row')
  assert.notStrictEqual(key({ name: 'Addiction' }), key({ name: 'Addiction 2024' }))
  assert.match(pageSrc, /function key/, 'the page uses the same rule')
})

test('sync page: sameness compares the authored content, not the wrapper', () => {
  const a = { id: 'boat-1', updatedAt: 1, name: 'P', csv: 'twa,6\n40,5.1' }
  const b = { id: 'cloud-9', updatedAt: 999999, name: 'P', csv: 'twa,6\n40,5.1' }
  assert.strictEqual(same(a, b, 'polars'), true, 'differing ids/updatedAt must not read as a conflict')
  assert.strictEqual(same(a, { ...b, csv: 'twa,6\n40,9.9' }, 'polars'), false, 'a real edit does')

  const r1 = { id: 'x', updatedAt: 1, name: 'R', path: [{ lat: 1, lon: 2 }], destination: null }
  const r2 = { id: 'y', updatedAt: 2, name: 'R', path: [{ lat: 1, lon: 2 }], destination: null }
  assert.strictEqual(same(r1, r2, 'routes'), true)
  assert.strictEqual(same(r1, { ...r2, path: [{ lat: 9, lon: 9 }] }, 'routes'), false)
})

test('sync page: a copy carries the authored fields only — never a foreign id', () => {
  // Sending the source id would either collide or resurrect a deleted item; updatedAt
  // belongs to the side it came from.
  const from = { id: 'cloud-9', updatedAt: 12345, name: 'Addiction', csv: 'a,b' }
  const body = {}
  Object.keys(from).forEach((k) => { if (k !== 'id' && k !== 'updatedAt') body[k] = from[k] })
  assert.deepStrictEqual(body, { name: 'Addiction', csv: 'a,b' })
  assert.match(pageSrc, /k !== 'id' && k !== 'updatedAt'/, 'the page strips them too')
})

test('sync page: is served, reads BOTH sides through the auth-protected plugin router', () => {
  // Not the mirror on :8080 — that is open to anyone on the boat wifi, and this page
  // holds a cloud session. Verified on the boat: /plugins/sailkick-boat/* answers 401
  // unauthenticated while the mirror answers 200.
  assert.match(pageSrc, /var API = '\/plugins\/sailkick-boat'/, 'both sides go through the plugin router')
  // strip the explanatory comment before asserting — it names :8080 to say why it is
  // NOT used, and the point is that no request ever goes there.
  const code = pageSrc.replace(/<!--[\s\S]*?-->/g, '')
  assert.doesNotMatch(code, /:8080|http:\/\//, 'no request escapes the plugin router')
  assert.match(pageSrc, /\/cloud\/profile\//, 'cloud side')
  assert.match(pageSrc, /j\('\/profile\/polars'\)/, 'boat side, same shape as the cloud side')
  assert.match(pageSrc, /confirm\(/, 'an existing item is never overwritten without asking')
  const pkg = require('../package.json')
  assert.ok(pkg.files.includes('public/'), 'ships in the tarball')
})

// --- the "Signing in… forever" bug (v0.22.1) ----------------------------------------
// Signal K mounts plugin routers AFTER its own bodyParser.json() (signalk-server
// dist/index.js:77). By the time a handler runs, the body is parsed onto req.body and the
// request stream is SPENT — so waiting for 'data'/'end' waits for events that will never
// fire. No error, no timeout: the request simply hangs, which is exactly what the Sync
// page did on sign-in. The mirror has no body parser, so both shapes must work.
const express = (() => { try { return require('express') } catch { return null } })()

test('a pre-parsed body (Signal K router) does not hang', { skip: !express && 'express not installed' }, async () => {
  const f = fakeCloud(); await listen(f.srv)
  const cloud = createCloud(app, { upstream: `http://127.0.0.1:${f.srv.address().port}`, dataDir: tmpDir() })
  cloud.start()

  const a = express()
  a.use(express.json()) // exactly what Signal K does before plugin routers
  a.all('/cloud/*', (req, res) => cloud.handle(String(req.params[0] || ''), req, res))
  const h = a.listen(0)
  await new Promise((r) => h.once('listening', r))
  const base = `http://127.0.0.1:${h.address().port}`

  // Before the fix this promise never settled.
  const r = await Promise.race([
    fetch(`${base}/cloud/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'addiction', password: 'right' })
    }).then(async (x) => ({ status: x.status, body: await x.json() })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG — the request never completed')), 4000))
  ])
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.loggedIn, true)
  assert.strictEqual(cloud.status().slug, 'addiction')

  h.closeAllConnections && h.closeAllConnections()
  await new Promise((r) => h.close(r))
  await shut(f.srv)
})

test('the boat profile survives a pre-parsed body too', { skip: !express && 'express not installed' }, async () => {
  // Same trap: POST /profile/polars from the Sync page goes through the same router.
  const { createProfile } = require('../lib/profile')
  const dir = tmpDir()
  const profile = createProfile(app, { dataDir: dir })
  const a = express()
  a.use(express.json())
  a.all('/profile*', (req, res) => {
    const rest = String(req.params[0] || '')
    const qs = req.url.indexOf('?')
    const url = '/api/profile' + rest + (qs >= 0 ? req.url.slice(qs) : '')
    profile.handle(new Proxy(req, { get: (t, k) => (k === 'url' ? url : t[k]) }), res)
  })
  const h = a.listen(0)
  await new Promise((r) => h.once('listening', r))
  const base = `http://127.0.0.1:${h.address().port}`

  const made = await Promise.race([
    fetch(`${base}/profile/polars`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Addiction', csv: 'twa,6' })
    }).then(async (x) => ({ status: x.status, body: await x.json() })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG')), 4000))
  ])
  assert.strictEqual(made.status, 201)
  assert.strictEqual(made.body.item.name, 'Addiction')

  const listed = await (await fetch(`${base}/profile/polars`)).json()
  assert.strictEqual(listed.polars.length, 1, 'and it really persisted')

  h.closeAllConnections && h.closeAllConnections()
  await new Promise((r) => h.close(r))
})
