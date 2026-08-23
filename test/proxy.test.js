'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const { getResource, storePaths } = require('../lib/proxy/cache')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skboat-'))

// a tiny controllable "sailkick host" upstream that counts hits
function upstream () {
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits++
    if (req.url.startsWith('/hello')) { res.setHeader('Content-Type', 'text/plain'); res.end('HELLO ' + req.url) } else if (req.url === '/j') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}') } else { res.statusCode = 404; res.end('nope') }
  })
  return new Promise((r) => srv.listen(0, () => r({ srv, url: 'http://127.0.0.1:' + srv.address().port, hits: () => hits })))
}

test('fetch, cache, serve from disk on 2nd call (upstream hit once)', async () => {
  const store = tmp(); const up = await upstream()
  const a = await getResource({ storeDir: store, upstream: up.url, reqPath: '/hello' })
  assert.strictEqual(a.fromCache, false)
  assert.strictEqual(a.buffer.toString(), 'HELLO /hello')
  assert.strictEqual(a.contentType, 'text/plain')
  const b = await getResource({ storeDir: store, upstream: up.url, reqPath: '/hello' })
  assert.strictEqual(b.fromCache, true)
  assert.strictEqual(up.hits(), 1, 'upstream fetched only once')
  up.srv.close()
})

test('query strings cache separately', async () => {
  const store = tmp(); const up = await upstream()
  await getResource({ storeDir: store, upstream: up.url, reqPath: '/hello?a=1' })
  await getResource({ storeDir: store, upstream: up.url, reqPath: '/hello?a=2' })
  await getResource({ storeDir: store, upstream: up.url, reqPath: '/hello?a=1' }) // cached
  assert.strictEqual(up.hits(), 2, 'two distinct queries fetched; repeat from cache')
  up.srv.close()
})

test('serves cached resource OFFLINE (upstream down)', async () => {
  const store = tmp(); const up = await upstream()
  await getResource({ storeDir: store, upstream: up.url, reqPath: '/j' })
  const deadUrl = up.url; up.srv.close() // kill upstream
  const r = await getResource({ storeDir: store, upstream: deadUrl, reqPath: '/j' })
  assert.strictEqual(r.fromCache, true)
  assert.strictEqual(r.contentType, 'application/json')
})

test('offline error when uncached + upstream down', async () => {
  const store = tmp()
  await assert.rejects(
    () => getResource({ storeDir: store, upstream: 'http://127.0.0.1:9', reqPath: '/x' }),
    (e) => e.offline === true
  )
})

test('storePaths never escapes the store dir', () => {
  const { file } = storePaths('/tmp/store', '/../../etc/passwd')
  assert.ok(file.startsWith(path.resolve('/tmp/store') + path.sep), 'stayed inside store')
})

test('plugin route: /p/* MISS then HIT; disabled -> 503', async (t) => {
  let express
  try { express = require('express') } catch { return t.skip('express not installed') }
  const up = await upstream(); const store = tmp()
  const factory = require('../index.js')
  const app = { getDataDirPath: () => store, debug: () => {}, setPluginStatus: () => {}, error: () => {} }
  const plugin = factory(app)
  // selfHosted is required for sailkickUrl to be honoured — without it the plugin
  // treats a saved endpoint as a leftover from an older config and mirrors the fleet
  // constant instead. Here the override is deliberate, so declare it.
  plugin.start({ sync: { enabled: false }, proxy: { enabled: true, selfHosted: true, sailkickUrl: up.url, storeDir: store, manifest: { enabled: false }, seed: { enabled: false } } })

  const server = express(); const router = express.Router()
  plugin.registerWithRouter(router)
  server.use('/plugins/sailkick-boat', router)
  const h = server.listen(0); await new Promise((r) => h.once('listening', r))
  const base = `http://127.0.0.1:${h.address().port}/plugins/sailkick-boat`

  const miss = await fetch(base + '/p/hello')
  assert.strictEqual(miss.status, 200)
  assert.strictEqual(miss.headers.get('x-sailkick-cache'), 'MISS')
  assert.strictEqual(await miss.text(), 'HELLO /hello')

  const hit = await fetch(base + '/p/hello')
  assert.strictEqual(hit.headers.get('x-sailkick-cache'), 'HIT')

  plugin.stop() // disables proxy
  const off = await fetch(base + '/p/hello')
  assert.strictEqual(off.status, 503)

  h.close(); up.srv.close()
})

// --- the relay must tolerate slow work (v0.23.8) -------------------------------------
// Reported from the boat: routing in the webapp returned 502. Self-inflicted — 0.23.3
// migrated passThrough onto the shared transport and applied the proxy's TILE timeout
// (20s) to it. The original used fetch with no timeout at all, and /api/isochrone is
// weather routing that the app itself allows 120s for (FETCH_TIMEOUT_MS in
// public/engine/wind-client.js). Every route slower than 20s was killed by the mirror.
test('relay: a POST slower than the tile timeout still succeeds', async (t) => {
  let express
  try { express = require('express') } catch { return t.skip('express not installed') }
  const http = require('node:http')

  // upstream that takes longer than the 20s tile budget would allow, scaled down: the
  // test drives a 300ms "slow" response against a 100ms tile timeout and a 5s relay one.
  const up = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => setTimeout(() => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, echoed: JSON.parse(body || '{}') }))
    }, 300))
  })
  await new Promise((r) => up.listen(0, r))

  const { createProxy } = require('../lib/proxy')
  const store = tmp()
  const proxy = createProxy({ debug () {} }, {
    sailkickUrl: `http://127.0.0.1:${up.address().port}`,
    proxyPort: 0,
    storeDir: store,
    requestTimeoutMs: 100, // tiles: deliberately shorter than the upstream delay
    relayTimeoutMs: 5000, // the relay gets its own, generous budget
    manifest: { enabled: false },
    seed: { enabled: false }
  })
  proxy.start()

  const res = await new Promise((resolve) => {
    const chunks = [Buffer.from(JSON.stringify({ from: 'boat' }))]
    let dataCb, endCb
    const req = {
      url: '/api/isochrone',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on (ev, cb) { if (ev === 'data') dataCb = cb; if (ev === 'end') endCb = cb; return req },
      [Symbol.asyncIterator] () { let done = false; return { next: async () => (done ? { done: true } : (done = true, { value: chunks[0], done: false })) } }
    }
    void dataCb; void endCb
    const out = { statusCode: 200, headers: {}, setHeader (k, v) { this.headers[k] = v }, end (b) { this.body = b ? b.toString() : ''; resolve(this) } }
    proxy._serveMirror(req, out)
  })

  assert.strictEqual(res.statusCode, 200, `relay must not time out; got ${res.statusCode} ${res.body}`)
  assert.deepStrictEqual(JSON.parse(res.body).echoed, { from: 'boat' }, 'and the body round-trips')
  proxy.stop()
  await new Promise((r) => { up.closeAllConnections && up.closeAllConnections(); up.close(r) })
})
