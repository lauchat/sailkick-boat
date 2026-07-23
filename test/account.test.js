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

// fake /api/boat/config: returns the bundle for the right creds, 401 otherwise
function configServer (creds = { slug: 'mimi', password: 'pw' }) {
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let b = {}
      try { b = JSON.parse(body) } catch {}
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/boat/config' && b.slug === creds.slug && b.password === creds.password) {
        res.end(JSON.stringify({ ok: true, influxUrl: 'https://influx.sailkick.example', org: 'sailkick', bucket: 'mimi_raw', writeToken: 'WTOK', readToken: 'RTOK' }))
      } else { res.statusCode = 401; res.end(JSON.stringify({ ok: false, code: 'bad-credentials' })) }
    })
  })
  return srv
}

test('accountConfigured: needs sailkickUrl + slug + password', () => {
  assert.strictEqual(accountConfigured(null), false)
  assert.strictEqual(accountConfigured({ sailkickUrl: 'x', slug: 'a' }), false)
  assert.strictEqual(accountConfigured({ sailkickUrl: 'x', slug: 'a', password: 'p' }), true)
})

test('resolveAccountConfig: live fetch returns the bundle and caches it (0600)', async () => {
  const { app, dir } = tmpApp()
  const srv = configServer(); await listen(srv)
  const url = `http://127.0.0.1:${srv.address().port}`

  const r = await resolveAccountConfig(app, { sailkickUrl: url, slug: 'mimi', password: 'pw' })
  assert.strictEqual(r.source, 'live')
  assert.strictEqual(r.bundle.writeToken, 'WTOK')
  assert.strictEqual(r.bundle.bucket, 'mimi_raw')
  const cacheFile = path.join(dir, 'account.json')
  assert.ok(fs.existsSync(cacheFile), 'bundle cached')
  assert.strictEqual(fs.statSync(cacheFile).mode & 0o777, 0o600, 'cache is 0600')

  await new Promise((res) => srv.close(res))
})

test('resolveAccountConfig: offline falls back to the cached bundle', async () => {
  const { app } = tmpApp()
  const srv = configServer(); await listen(srv)
  const port = srv.address().port
  // warm the cache while "online"
  await resolveAccountConfig(app, { sailkickUrl: `http://127.0.0.1:${port}`, slug: 'mimi', password: 'pw' })
  await new Promise((res) => srv.close(res)) // go offline

  const r = await resolveAccountConfig(app, { sailkickUrl: `http://127.0.0.1:${port}`, slug: 'mimi', password: 'pw' }, { timeoutMs: 800 })
  assert.strictEqual(r.source, 'cache')
  assert.strictEqual(r.bundle.writeToken, 'WTOK', 'served the cached write token')
  assert.ok(r.error, 'notes the fetch error')
})

test('resolveAccountConfig: offline with no cache returns null', async () => {
  const { app } = tmpApp()
  const r = await resolveAccountConfig(app, { sailkickUrl: 'http://127.0.0.1:1', slug: 'x', password: 'y' }, { timeoutMs: 500 })
  assert.strictEqual(r.bundle, null)
  assert.strictEqual(r.source, null)
  assert.ok(r.error)
})

test('resolveAccountConfig: 401 (wrong creds) with no cache → null + error', async () => {
  const { app } = tmpApp()
  const srv = configServer(); await listen(srv)
  const url = `http://127.0.0.1:${srv.address().port}`
  const r = await resolveAccountConfig(app, { sailkickUrl: url, slug: 'mimi', password: 'WRONG' })
  assert.strictEqual(r.bundle, null)
  assert.match(r.error, /401/)
  await new Promise((res) => srv.close(res))
})
