'use strict'

// Tests the standalone mirror server (origin-root, no-auth entry point).
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const { createProxy } = require('../lib/proxy')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skb-standalone-'))

function upstream () {
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits++
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html>APP</html>') } else if (req.url.startsWith('/assets/')) { res.setHeader('Content-Type', 'application/javascript'); res.end('// ' + req.url) } else { res.statusCode = 404; res.end('nope') }
  })
  return new Promise((r) => srv.listen(0, () => r({ srv, url: 'http://127.0.0.1:' + srv.address().port, hits: () => hits })))
}
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })

test('standalone mirror: serves app root + root-relative assets, caches, offline-serves', async () => {
  const up = await upstream(); const store = tmp(); const port = await freePort()
  const app = { getDataDirPath: () => store, debug: () => {} }
  const proxy = createProxy(app, { sailkickUrl: up.url, storeDir: store, proxyPort: port, manifest: { enabled: false }, seed: { enabled: false } })
  proxy.start()
  await new Promise((r) => setTimeout(r, 150)) // let the server bind

  const base = `http://127.0.0.1:${port}`
  // app root (the "drop a URL" entry)
  const root = await fetch(base + '/')
  assert.strictEqual(root.status, 200)
  assert.strictEqual(root.headers.get('x-sailkick-cache'), 'MISS')
  assert.strictEqual(await root.text(), '<html>APP</html>')
  // a root-relative asset the app references (would 404 under a /plugins/ prefix)
  const asset = await fetch(base + '/assets/index-abc.js')
  assert.strictEqual(asset.status, 200)
  assert.strictEqual(asset.headers.get('content-type'), 'application/javascript')
  // second hit served from cache
  const again = await fetch(base + '/')
  assert.strictEqual(again.headers.get('x-sailkick-cache'), 'HIT')
  assert.strictEqual(up.hits(), 2, 'root + asset fetched once each; repeat from cache')

  // offline: kill upstream, cached root still served
  up.srv.closeAllConnections && up.srv.closeAllConnections(); up.srv.close()
  const offline = await fetch(base + '/')
  assert.strictEqual(offline.status, 200)
  assert.strictEqual(offline.headers.get('x-sailkick-cache'), 'HIT')

  proxy.stop()
  // server closed -> connection refused
  await assert.rejects(() => fetch(base + '/'))
})
