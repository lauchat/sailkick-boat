'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fs = require('node:fs')
const fsp = fs.promises
const os = require('node:os')
const path = require('node:path')

const { getResource, storePaths, clearStore } = require('../lib/proxy/cache')
const { createManifest } = require('../lib/proxy/manifest')

let seq = 0
function tmpStore () { return path.join(os.tmpdir(), `sk-fresh-${process.pid}-${seq++}`) }
const listen = (srv) => new Promise((r) => srv.listen(0, r))

test('getResource: MISS → HIT → (bake announced) UPDATED → HIT → STALE when offline', async () => {
  let ver = 'A'
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end('body-' + ver) })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const storeDir = tmpStore()

  let r = await getResource({ storeDir, upstream: up, reqPath: '/main.js' })
  assert.strictEqual(r.cacheState, 'MISS')
  assert.strictEqual(r.buffer.toString(), 'body-A')

  r = await getResource({ storeDir, upstream: up, reqPath: '/main.js' })
  assert.strictEqual(r.cacheState, 'HIT', 'pinned: no invalidation → HIT forever')

  // age the cached file into the past, then announce a bake (invalidatedAt between
  // the file's mtime and now) → the file is now stale
  const { file } = storePaths(storeDir, '/main.js')
  const old = new Date(Date.now() - 10000)
  await fsp.utimes(file, old, old)
  const invalidatedAt = Date.now() - 5000
  ver = 'B'

  r = await getResource({ storeDir, upstream: up, reqPath: '/main.js', invalidatedAt })
  assert.strictEqual(r.cacheState, 'UPDATED', 'stale + online → refetch')
  assert.strictEqual(r.buffer.toString(), 'body-B')

  r = await getResource({ storeDir, upstream: up, reqPath: '/main.js', invalidatedAt })
  assert.strictEqual(r.cacheState, 'HIT', 'refetched file is newer than invalidatedAt → HIT')

  // age again and take upstream offline → serve the stale copy (offline-first)
  await fsp.utimes(file, old, old)
  await new Promise((res) => srv.close(res))
  r = await getResource({ storeDir, upstream: up, reqPath: '/main.js', invalidatedAt: Date.now() - 5000, timeoutMs: 800 })
  assert.strictEqual(r.cacheState, 'STALE', 'stale + offline → serve old copy')
  assert.strictEqual(r.buffer.toString(), 'body-B')
})

test('getResource: uncached + offline → throws offline', async () => {
  const storeDir = tmpStore()
  await assert.rejects(
    () => getResource({ storeDir, upstream: 'http://127.0.0.1:1', reqPath: '/x', timeoutMs: 500 }),
    (e) => e.offline === true
  )
})

test('manifest: first sight does not invalidate; a changed bake does; longest-prefix family', async () => {
  let payload = { app: 'a1', bakes: { 'tiles/osm-standard': 'v1', tiles: 't1' } }
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)) })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const storeDir = tmpStore(); await fsp.mkdir(storeDir, { recursive: true })

  const m = createManifest({ debug () {} }, { upstream: up, storeDir, pollIntervalSec: 9999 })
  m.start()
  await m._poll()

  // family resolution: longest matching prefix wins; non-tile → 'app'
  assert.strictEqual(m.familyFor('/tiles/osm-standard/1/2/3.png'), 'tiles/osm-standard')
  assert.strictEqual(m.familyFor('/tiles/seamap/1/2/3.png'), 'tiles', 'falls back to the broader tiles family')
  assert.strictEqual(m.familyFor('/engine/main.js'), 'app')

  // first sight → recorded but NOT invalidated (don't nuke a pre-populated store)
  assert.strictEqual(m.invalidatedAtFor('/tiles/osm-standard/1/2/3.png'), 0)

  // a bake id change → that family (only) is invalidated
  payload = { app: 'a1', bakes: { 'tiles/osm-standard': 'v2', tiles: 't1' } }
  await m._poll()
  assert.ok(m.invalidatedAtFor('/tiles/osm-standard/1/2/3.png') > 0, 'osm-standard invalidated')
  assert.strictEqual(m.invalidatedAtFor('/tiles/seamap/9/9/9.png'), 0, 'seamap unchanged')
  assert.strictEqual(m.invalidatedAtFor('/engine/main.js'), 0, 'app unchanged')

  // app build bump → app family invalidated
  payload = { app: 'a2', bakes: { 'tiles/osm-standard': 'v2', tiles: 't1' } }
  await m._poll()
  assert.ok(m.invalidatedAtFor('/engine/main.js') > 0, 'app invalidated on build bump')

  m.stop()
  await new Promise((res) => srv.close(res))
})

test('manifest: offline poll is a no-op (nothing invalidated)', async () => {
  const storeDir = tmpStore(); await fsp.mkdir(storeDir, { recursive: true })
  const m = createManifest({ debug () {} }, { upstream: 'http://127.0.0.1:1', storeDir, pollIntervalSec: 9999, timeoutMs: 500 })
  m.start()
  await m._poll()
  assert.strictEqual(m.invalidatedAtFor('/tiles/osm-standard/1/2/3.png'), 0)
  assert.deepStrictEqual(m._known(), {})
  m.stop()
})

test('clearStore: keep mode preserves tiles/terrain; prefix mode nukes a subtree', async () => {
  const storeDir = tmpStore()
  const mk = async (rel, body = 'x') => { await fsp.mkdir(path.join(storeDir, path.dirname(rel)), { recursive: true }); await fsp.writeFile(path.join(storeDir, rel), body) }
  await mk('tiles/osm/1.png'); await mk('terrain/9.terrain'); await mk('main.js'); await mk('engine/a.js'); await mk('api/config')

  const r = await clearStore({ storeDir, keep: ['tiles', 'terrain'] })
  assert.strictEqual(r.removed, 3, 'main.js, engine/, api/ removed')
  assert.ok(fs.existsSync(path.join(storeDir, 'tiles/osm/1.png')), 'tiles kept')
  assert.ok(fs.existsSync(path.join(storeDir, 'terrain/9.terrain')), 'terrain kept')
  assert.ok(!fs.existsSync(path.join(storeDir, 'main.js')))
  assert.ok(!fs.existsSync(path.join(storeDir, 'engine')))

  await clearStore({ storeDir, prefix: 'tiles/osm' })
  assert.ok(!fs.existsSync(path.join(storeDir, 'tiles/osm')), 'prefix subtree removed')

  // path-traversal guard
  await assert.rejects(() => clearStore({ storeDir, prefix: '../escape' }))
})
