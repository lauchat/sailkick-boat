'use strict'

const test = require('node:test')
const assert = require('node:assert')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const { createSync } = require('../lib/sync')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

test('missing config: does not throw, reports not configured', () => {
  const app = { getDataDirPath: () => os.tmpdir(), debug: () => {} }
  const s = createSync(app, {})
  s.start()
  assert.match(s.status(), /not configured/)
  s.stop()
})

test('subscribes, maps deltas, and buffers to disk when InfluxDB is unreachable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skb-sync-'))
  const spoolDir = path.join(dir, 'spool')
  let handler = null
  const app = {
    selfId: 'urn:mrn:test',
    getDataDirPath: () => dir,
    debug: () => {},
    subscriptionmanager: { subscribe: (sub, unsub, err, cb) => { handler = cb } }
  }
  const s = createSync(app, {
    influxUrl: 'http://127.0.0.1:9', org: 'o', bucket: 'b', token: 't',
    spoolDir, flushIntervalMs: 100, retryMinMs: 100, retryMaxMs: 200
  })
  s.start()
  for (let i = 0; i < 60 && !handler; i++) await delay(20)
  assert.ok(handler, 'sync subscribed to deltas')

  handler({
    context: 'vessels.self',
    updates: [{ $source: 't', timestamp: new Date().toISOString(), values: [{ path: 'navigation.speedOverGround', value: 3.1 }] }]
  })
  await delay(400) // flush -> spool; upload fails (dead influx) -> stays buffered

  const files = fs.readdirSync(spoolDir).filter((f) => f.endsWith('.lp'))
  assert.ok(files.length >= 1, 'delta buffered to spool (nothing lost)')
  s.stop()
})

// --- a wrong bucket must HOLD, not quarantine (v0.21.0) -----------------------------
// A missing bucket (404) or a bad token (401/403) rejects EVERY batch identically, so
// treating it like any other 4xx fed the whole telemetry stream into spool/dead/ while
// the plugin looked busy. That is exactly what a bucket rename does — this boat went
// addiction_raw -> <uuid>_raw — and it is how 128,842 points were lost on 31 July.
const http = require('node:http')

async function syncAgainst (handler, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skb-cfgerr-'))
  const srv = http.createServer(handler)
  await new Promise((r) => srv.listen(0, r))
  let onDelta = null
  const app = {
    getDataDirPath: () => dir,
    debug () {},
    error () {},
    selfContext: 'vessels.self',
    subscriptionmanager: { subscribe (sub, un, err, cb) { onDelta = cb } }
  }
  const s = createSync(app, {
    influxUrl: `http://127.0.0.1:${srv.address().port}`,
    org: 'sailkick',
    bucket: 'addiction_raw',
    token: 'WTOK',
    spoolDir: path.join(dir, 'spool'),
    flushIntervalMs: 20,
    retryMinMs: 20,
    retryMaxMs: 40,
    ...extra
  })
  s.start()
  await delay(60)
  const feed = () => onDelta && onDelta({
    context: 'vessels.self',
    updates: [{ $source: 't', timestamp: new Date().toISOString(), values: [{ path: 'navigation.speedOverGround', value: 5 }] }]
  })
  const close = async () => { s.stop(); srv.closeAllConnections && srv.closeAllConnections(); await new Promise((r) => srv.close(r)) }
  const counts = () => {
    const sp = path.join(dir, 'spool')
    const lp = (d) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.lp')).length } catch { return 0 } }
    return { spool: lp(sp), dead: lp(path.join(sp, 'dead')) }
  }
  return { s, feed, close, counts, dir }
}

test('sync: a 404 bucket-not-found holds the data on disk and never quarantines', async () => {
  let status = 404
  const h = await syncAgainst((req, res) => {
    if (status === 404) { res.statusCode = 404; res.end('{"code":"not found","message":"bucket \\"addiction_raw\\" not found"}'); return }
    res.statusCode = 204; res.end()
  })
  h.feed(); await delay(300)

  const c = h.counts()
  assert.strictEqual(c.dead, 0, 'NOTHING quarantined — this is the whole point')
  assert.ok(c.spool > 0, 'the batch is still on disk')
  assert.match(h.s.status(), /HELD/, 'the status line leads with the problem')
  assert.match(h.s.status(), /addiction_raw/, 'and names the bucket to fix')

  // correcting the config must recover without a restart
  status = 204
  await delay(400)
  assert.strictEqual(h.counts().spool, 0, 'spool drained once the bucket was valid again')
  assert.strictEqual(h.counts().dead, 0)
  assert.doesNotMatch(h.s.status(), /HELD/, 'and the status line clears')
  await h.close()
})

test('sync: a 401 is held too — a bad token is a setting, not a bad batch', async () => {
  const h = await syncAgainst((req, res) => { res.statusCode = 401; res.end('unauthorized') })
  h.feed(); await delay(300)
  assert.strictEqual(h.counts().dead, 0, 'not quarantined')
  assert.ok(h.counts().spool > 0)
  assert.match(h.s.status(), /HELD/)
  assert.match(h.s.status(), /token/i, 'points at the token, not the bucket')
  await h.close()
})

test('sync: a genuinely malformed batch (422) is still quarantined', async () => {
  // The distinction matters: 422 means THIS batch is bad, so retrying it forever would
  // wedge everything behind it. That behaviour must not regress.
  const h = await syncAgainst((req, res) => { res.statusCode = 422; res.end('{"code":"invalid","message":"field type conflict"}') })
  h.feed(); await delay(300)
  assert.strictEqual(h.counts().dead, 1, 'quarantined, as before')
  assert.strictEqual(h.counts().spool, 0, 'and cleared from the queue')
  await h.close()
})

// --- the wedged-process incident (v0.23.2) ------------------------------------------
// Twice in one afternoon the Signal K process could not open ANY outbound HTTPS while a
// second process in the same container reached the same host in under a second: zero
// sockets to :443, live connections to the Starlink dish and the local database, no
// resource exhaustion, and no recovery for 33 minutes. Starlink is behind CGNAT, which
// drops idle NAT mappings without an RST, so a pooled keep-alive socket looks alive to
// the client and is dead on the wire — and fetch() gives no supported way to reset its
// pool from here (undici is not requirable on the boat).
//
// So the write path now uses core https with an agent we own, which buys two things:
// the pool can be thrown away, and the real error code is visible instead of fetch's
// uniformly useless "fetch failed".
const { writeLines, resetTransport } = require('../lib/sync/influxWrite')
const { _agents } = require('../lib/net') // the pool is shared plugin-wide now

test('write: reports the REAL error code, not "fetch failed"', async () => {
  // A closed port: the reason must reach the caller so a wedged process and a boat at
  // sea stop producing identical logs.
  const probe = http.createServer()
  await new Promise((r) => probe.listen(0, r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))

  const res = await writeLines({ influxUrl: `http://127.0.0.1:${port}`, org: 'o', bucket: 'b', token: 't', timeoutMs: 2000 }, 'm value=1 1\n')
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.networkError, true)
  assert.strictEqual(res.retryable, true, 'a transport failure is retryable')
  assert.strictEqual(res.code, 'ECONNREFUSED', 'the actual cause, not "fetch failed"')
})

test('write: statuses keep their existing meaning through the new transport', async () => {
  const cases = [[204, { ok: true }], [404, { configError: true }], [401, { configError: true }],
    [500, { retryable: true }], [429, { retryable: true }], [422, { retryable: false }]]
  for (const [code, want] of cases) {
    const srv = http.createServer((req, res) => { res.statusCode = code; res.end(code === 204 ? undefined : '{"m":"x"}') })
    await new Promise((r) => srv.listen(0, r))
    const res = await writeLines({ influxUrl: `http://127.0.0.1:${srv.address().port}`, org: 'o', bucket: 'b', token: 't', timeoutMs: 5000 }, 'm value=1 1\n')
    for (const [k, v] of Object.entries(want)) assert.strictEqual(res[k], v, `HTTP ${code} -> ${k}`)
    if (code === 204) assert.strictEqual(res.ok, true)
    srv.closeAllConnections && srv.closeAllConnections()
    await new Promise((r) => srv.close(r))
  }
})

test('write: the body still arrives gzipped and intact', async () => {
  let got = null
  const srv = http.createServer((req, res) => {
    const c = []
    req.on('data', (x) => c.push(x))
    req.on('end', () => {
      got = { enc: req.headers['content-encoding'], auth: req.headers.authorization, body: require('node:zlib').gunzipSync(Buffer.concat(c)).toString() }
      res.statusCode = 204; res.end()
    })
  })
  await new Promise((r) => srv.listen(0, r))
  const line = 'navigation.speedOverGround,self=true value=5.5 1787000000000000000\n'
  const res = await writeLines({ influxUrl: `http://127.0.0.1:${srv.address().port}`, org: 'sailkick', bucket: 'b_raw', token: 'WTOK', timeoutMs: 5000 }, line)
  assert.strictEqual(res.ok, true)
  assert.strictEqual(got.enc, 'gzip')
  assert.strictEqual(got.auth, 'Token WTOK')
  assert.strictEqual(got.body, line, 'byte-for-byte')
  srv.closeAllConnections && srv.closeAllConnections()
  await new Promise((r) => srv.close(r))
})

test('write: resetTransport throws the pool away and the next write builds a fresh one', async () => {
  const srv = http.createServer((req, res) => { res.statusCode = 204; res.end() })
  await new Promise((r) => srv.listen(0, r))
  const cfg = { influxUrl: `http://127.0.0.1:${srv.address().port}`, org: 'o', bucket: 'b', token: 't', timeoutMs: 5000 }

  assert.strictEqual((await writeLines(cfg, 'm value=1 1\n')).ok, true)
  const before = _agents()
  assert.ok(before, 'a pool exists')

  const gen = resetTransport()
  assert.ok(gen >= 1, 'reset is counted, so the log can name a generation')
  assert.strictEqual(_agents(), null, 'the poisoned pool is gone')

  assert.strictEqual((await writeLines(cfg, 'm value=2 2\n')).ok, true, 'writes still work after a reset')
  assert.notStrictEqual(_agents(), before, 'and on a NEW pool')
  srv.closeAllConnections && srv.closeAllConnections()
  await new Promise((r) => srv.close(r))
})

test('sync: rebuilds the pool after repeated transport failures, then recovers', async () => {
  // The incident, end to end: writes fail at the transport level, the pool is rebuilt,
  // and when the endpoint returns the spool drains — with no restart.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skb-wedge-'))
  const warnings = []
  let up = false
  const srv = http.createServer((req, res) => {
    if (!up) { req.destroy(); return } // connection killed — a transport failure
    res.statusCode = 204; res.end()
  })
  await new Promise((r) => srv.listen(0, r))

  let onDelta = null
  const app = {
    getDataDirPath: () => dir, debug () {}, error (m) { warnings.push(m) },
    selfContext: 'vessels.self',
    subscriptionmanager: { subscribe (sub, un, err, cb) { onDelta = cb } }
  }
  const s = createSync(app, {
    influxUrl: `http://127.0.0.1:${srv.address().port}`, org: 'o', bucket: 'b', token: 't',
    spoolDir: path.join(dir, 'spool'), flushIntervalMs: 20, retryMinMs: 20, retryMaxMs: 40
  })
  s.start()
  await delay(60)
  onDelta({ context: 'vessels.self', updates: [{ $source: 't', timestamp: new Date().toISOString(), values: [{ path: 'navigation.speedOverGround', value: 5 }] }] })
  await delay(700)

  const rebuilt = warnings.filter((w) => /rebuilt the connection pool/.test(w))
  assert.ok(rebuilt.length > 0, 'the pool was rebuilt after repeated transport failures')
  assert.ok(warnings.some((w) => /unreachable \(ECONNRESET|unreachable \(EPIPE|unreachable \(ECONNREFUSED/.test(w)),
    'and the log names the real code: ' + warnings.filter((w) => /unreachable/.test(w))[0])
  const dead = (() => { try { return fs.readdirSync(path.join(dir, 'spool', 'dead')).length } catch { return 0 } })()
  assert.strictEqual(dead, 0, 'nothing quarantined — a transport failure is not bad data')

  up = true // the endpoint comes back
  for (let i = 0; i < 60 && fs.readdirSync(path.join(dir, 'spool')).filter((f) => f.endsWith('.lp')).length; i++) await delay(25)
  assert.strictEqual(fs.readdirSync(path.join(dir, 'spool')).filter((f) => f.endsWith('.lp')).length, 0, 'the spool drained with no restart')
  s.stop()
  srv.closeAllConnections && srv.closeAllConnections()
  await new Promise((r) => srv.close(r))
})
