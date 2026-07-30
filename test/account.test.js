'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { resolveAccountConfig, accountConfigured } = require('../lib/account')

let seq = 0
const tmpApp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sk-acct-${process.pid}-${seq++}-`))
  return { app: { debug () {}, getDataDirPath: () => dir }, dir }
}
const listen = (srv) => new Promise((r) => srv.listen(0, r))

// Fake /api/auth/signup, matching sailkick/server/routes/auth.js:36-75. Counts calls so
// tests can prove the plugin never signs up twice, and burns the invite like the real
// one does (single-use), so a second call fails exactly as production would.
function signupServer () {
  const state = { calls: 0, invites: new Set(['INV-1']), slugs: new Set() }
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url !== '/api/auth/signup') { res.statusCode = 404; res.end('{}'); return }
      state.calls++
      let b = {}
      try { b = JSON.parse(body) } catch {}
      const fail = (status, code, message) => {
        res.statusCode = status
        res.end(JSON.stringify({ ok: false, code, message }))
      }
      if (!state.invites.has(b.invite)) return fail(403, 'bad-invite', 'invite is not valid')
      if (state.slugs.has(b.slug)) return fail(409, 'slug-taken', 'that boat name is taken')
      if (!b.password || b.password.length < 8) return fail(400, 'weak-password', 'password must be at least 8 characters')
      state.invites.delete(b.invite) // single-use
      state.slugs.add(b.slug)
      res.end(JSON.stringify({
        ok: true,
        boat: { slug: b.slug, name: b.name || b.slug },
        ingest: { url: 'https://sync.sailkick.example', org: 'sailkick', bucket: `${b.slug}_raw`, writeToken: 'WTOK' }
      }))
    })
  })
  return { srv, state }
}

const creds = { invite: 'INV-1', slug: 'mimi', password: 'longenough' }

test('accountConfigured: needs invite + slug + password, or an existing cache', () => {
  const { app, dir } = tmpApp()
  assert.strictEqual(accountConfigured(app, null), false)
  assert.strictEqual(accountConfigured(app, { slug: 'a', password: 'longenough' }), false, 'no invite, no cache')
  assert.strictEqual(accountConfigured(app, creds), true)
  // A cached bundle alone is enough — the invite is spent and no longer needed.
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ slug: 'mimi', writeToken: 'WTOK' }))
  assert.strictEqual(accountConfigured(app, null), true, 'cache alone counts as configured')
})

test('resolveAccountConfig: pairs once via signup and caches the bundle (0600)', async () => {
  const { app, dir } = tmpApp()
  const { srv, state } = signupServer(); await listen(srv)
  const appUrl = `http://127.0.0.1:${srv.address().port}`

  const r = await resolveAccountConfig(app, creds, { appUrl })
  assert.strictEqual(r.source, 'paired')
  assert.strictEqual(r.bundle.writeToken, 'WTOK')
  assert.strictEqual(r.bundle.bucket, 'mimi_raw')
  assert.strictEqual(r.bundle.influxUrl, 'https://sync.sailkick.example', 'influxUrl comes from ingest.url')
  assert.strictEqual(r.bundle.org, 'sailkick')
  assert.strictEqual(r.bundle.slug, 'mimi')
  assert.strictEqual(state.calls, 1)

  const cacheFile = path.join(dir, 'account.json')
  assert.ok(fs.existsSync(cacheFile), 'bundle cached')
  assert.strictEqual(fs.statSync(cacheFile).mode & 0o777, 0o600, 'cache is 0600')

  await new Promise((res) => srv.close(res))
})

test('resolveAccountConfig: once paired, later starts never call signup again', async () => {
  const { app } = tmpApp()
  const { srv, state } = signupServer(); await listen(srv)
  const appUrl = `http://127.0.0.1:${srv.address().port}`

  await resolveAccountConfig(app, creds, { appUrl })
  assert.strictEqual(state.calls, 1)

  // Three more "restarts" — all must be pure disk reads. Signup is single-use, so a
  // second call would burn the invite and 403/409 for real.
  for (let i = 0; i < 3; i++) {
    const r = await resolveAccountConfig(app, creds, { appUrl })
    assert.strictEqual(r.source, 'cache')
    assert.strictEqual(r.bundle.writeToken, 'WTOK')
  }
  assert.strictEqual(state.calls, 1, 'signup called exactly once, ever')

  await new Promise((res) => srv.close(res))
})

test('resolveAccountConfig: cached bundle is served with the server unreachable', async () => {
  const { app } = tmpApp()
  const { srv } = signupServer(); await listen(srv)
  const appUrl = `http://127.0.0.1:${srv.address().port}`
  await resolveAccountConfig(app, creds, { appUrl }) // pair while online
  await new Promise((res) => srv.close(res)) // boat goes to sea

  const r = await resolveAccountConfig(app, creds, { appUrl, timeoutMs: 500 })
  assert.strictEqual(r.source, 'cache')
  assert.strictEqual(r.bundle.writeToken, 'WTOK', 'sync keeps working offline')
  assert.ok(!r.error, 'no network was attempted, so no error')
})

test('resolveAccountConfig: bad invite is terminal (no retry loop)', async () => {
  const { app } = tmpApp()
  const { srv } = signupServer(); await listen(srv)
  const appUrl = `http://127.0.0.1:${srv.address().port}`

  const r = await resolveAccountConfig(app, { ...creds, invite: 'NOPE' }, { appUrl })
  assert.strictEqual(r.bundle, null)
  assert.strictEqual(r.terminal, true)
  assert.match(r.error, /bad-invite/)

  await new Promise((res) => srv.close(res))
})

test('resolveAccountConfig: a burnt invite on a second boat reports slug-taken/bad-invite', async () => {
  const a = tmpApp()
  const b = tmpApp()
  const { srv, state } = signupServer(); await listen(srv)
  const appUrl = `http://127.0.0.1:${srv.address().port}`

  const first = await resolveAccountConfig(a.app, creds, { appUrl })
  assert.strictEqual(first.source, 'paired')

  // Same invite, fresh data dir (e.g. a re-flashed Pi) — the invite is spent.
  const second = await resolveAccountConfig(b.app, creds, { appUrl })
  assert.strictEqual(second.bundle, null)
  assert.strictEqual(second.terminal, true)
  assert.strictEqual(state.calls, 2)

  await new Promise((res) => srv.close(res))
})

test('resolveAccountConfig: unreachable server with no cache is retryable, not terminal', async () => {
  const { app } = tmpApp()
  const r = await resolveAccountConfig(app, creds, { appUrl: 'http://127.0.0.1:1', timeoutMs: 500 })
  assert.strictEqual(r.bundle, null)
  assert.strictEqual(r.source, null)
  assert.strictEqual(r.terminal, false, 'a flaky uplink must not strand the boat unpaired')
  assert.ok(r.error)
})

test('resolveAccountConfig: not configured is a no-op, not an error', async () => {
  const { app } = tmpApp()
  const r = await resolveAccountConfig(app, { slug: 'mimi' }, { appUrl: 'http://127.0.0.1:1' })
  assert.strictEqual(r.bundle, null)
  assert.strictEqual(r.source, null)
  assert.strictEqual(r.error, undefined, 'no invite entered yet is not a failure')
})
