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
