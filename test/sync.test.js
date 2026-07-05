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
