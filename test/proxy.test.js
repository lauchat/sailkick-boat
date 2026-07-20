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
  plugin.start({ sync: { enabled: false }, proxy: { enabled: true, sailkickUrl: up.url, storeDir: store, manifest: { enabled: false }, seed: { enabled: false } } })

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
