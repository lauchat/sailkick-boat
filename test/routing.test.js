'use strict'

// Tests the standalone mirror's path routing: /signalk -> local SignalK (incl.
// WebSocket upgrade relay), everything else -> mirror the sailkick host.
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const { createProxy } = require('../lib/proxy')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skb-routing-'))
const listen = (srv) => new Promise((r) => srv.listen(0, () => r(srv.address().port)))
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })

test('routes /signalk -> local SignalK (HTTP + WebSocket), else -> mirror', async () => {
  // fake LOCAL SignalK: HTTP API + a WebSocket upgrade
  let liveSock = null
  const localSrv = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"local":true}') })
  localSrv.on('upgrade', (req, sock) => { liveSock = sock; sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nLIVE') })
  const localPort = await listen(localSrv)

  // fake SAILKICK host: serves the app
  const skSrv = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html>APP</html>') })
  const skPort = await listen(skSrv)

  const store = tmp(); const port = await freePort()
  const proxy = createProxy({ getDataDirPath: () => store, debug: () => {} }, {
    sailkickUrl: `http://127.0.0.1:${skPort}`,
    localSignalkUrl: `http://127.0.0.1:${localPort}`,
    localPaths: ['/signalk'],
    storeDir: store,
    proxyPort: port,
    manifest: { enabled: false }, seed: { enabled: false }
  })
  proxy.start()
  await new Promise((r) => setTimeout(r, 150))
  const base = `http://127.0.0.1:${port}`

  // /signalk/* -> local SignalK (not the mirror, not cached)
  const live = await fetch(base + '/signalk/v1/api/vessels/self')
  assert.strictEqual(await live.text(), '{"local":true}', 'live data from local SignalK')
  assert.strictEqual(live.headers.get('x-sailkick-cache'), null, 'not cached')

  // everything else -> mirror the sailkick host. The app SHELL is network-first (its URL
  // never changes across deploys, so pinning it would freeze the boat on one build);
  // the hashed assets it pulls in are cache-first.
  const appLive = await fetch(base + '/')
  assert.strictEqual(await appLive.text(), '<html>APP</html>')
  assert.strictEqual(appLive.headers.get('x-sailkick-cache'), 'LIVE')
  const assetMiss = await fetch(base + '/assets/main-abc.js')
  assert.strictEqual(assetMiss.headers.get('x-sailkick-cache'), 'MISS')
  const assetHit = await fetch(base + '/assets/main-abc.js')
  assert.strictEqual(assetHit.headers.get('x-sailkick-cache'), 'HIT', 'hashed assets stay pinned')

  // WebSocket upgrade on /signalk -> relayed to local SignalK
  const wsResp = await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET /signalk/v1/stream HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n')
    })
    let buf = ''
    s.on('data', (d) => { buf += d.toString(); if (buf.includes('LIVE')) { s.destroy(); resolve(buf) } })
    s.on('error', reject)
    setTimeout(() => { s.destroy(); reject(new Error('ws relay timeout')) }, 3000)
  })
  assert.match(wsResp, /101 Switching Protocols/, 'upgrade relayed')
  assert.match(wsResp, /LIVE/, 'live stream data relayed from local SignalK')

  if (liveSock) liveSock.destroy()
  proxy.stop(); localSrv.closeAllConnections && localSrv.closeAllConnections(); localSrv.close(); skSrv.closeAllConnections && skSrv.closeAllConnections(); skSrv.close()
})
