'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { resolveAccountConfig, accountConfigured } = require('../lib/account')

let seq = 0
const tmpApp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sk-acct-${process.pid}-${seq++}-`))
  return { app: { debug () {}, getDataDirPath: () => dir }, dir }
}
const INFLUX = 'https://sync.sailkick.io'

test('write token + boat name → a complete bundle, everything else derived', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, { slug: 'mimi', writeToken: 'WTOK' }, { influxUrl: INFLUX })
  assert.strictEqual(r.source, 'config')
  assert.deepStrictEqual(r.bundle, {
    slug: 'mimi',
    influxUrl: INFLUX,
    org: 'sailkick',
    bucket: 'mimi_raw', // the app's convention: <slug>_raw
    writeToken: 'WTOK'
  })
})

test('input is normalised — pasted tokens carry whitespace, names carry case', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, { slug: '  Mimi \n', writeToken: '  WTOK  \n' }, { influxUrl: INFLUX })
  assert.strictEqual(r.bundle.slug, 'mimi')
  assert.strictEqual(r.bundle.writeToken, 'WTOK')
  assert.strictEqual(r.bundle.bucket, 'mimi_raw')
})

test('resolving is offline-safe and makes no network call', () => {
  const { app } = tmpApp()
  const realFetch = global.fetch
  global.fetch = () => { throw new Error('resolveAccountConfig must never hit the network') }
  try {
    const r = resolveAccountConfig(app, { slug: 'mimi', writeToken: 'WTOK' }, { influxUrl: INFLUX })
    assert.strictEqual(r.bundle.writeToken, 'WTOK')
  } finally { global.fetch = realFetch }
})

test('half-filled config says which half is missing', () => {
  const { app } = tmpApp()
  const noToken = resolveAccountConfig(app, { slug: 'mimi' }, { influxUrl: INFLUX })
  assert.strictEqual(noToken.bundle, null)
  assert.match(noToken.error, /write token/)

  const noSlug = resolveAccountConfig(app, { writeToken: 'WTOK' }, { influxUrl: INFLUX })
  assert.strictEqual(noSlug.bundle, null)
  assert.match(noSlug.error, /boat name/)
})

test('empty config is a no-op, not an error', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, {}, { influxUrl: INFLUX })
  assert.strictEqual(r.bundle, null)
  assert.strictEqual(r.source, null)
  assert.strictEqual(r.error, undefined)
})

test('a hand-written account.json still works (pre-0.14.2 installs)', () => {
  const { app, dir } = tmpApp()
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({
    slug: 'legacy', influxUrl: 'https://influx.example', org: 'sailkick', bucket: 'legacy_raw', writeToken: 'OLDTOK'
  }))
  const r = resolveAccountConfig(app, {}, { influxUrl: INFLUX })
  assert.strictEqual(r.source, 'cache')
  assert.strictEqual(r.bundle.writeToken, 'OLDTOK')
  assert.strictEqual(r.bundle.influxUrl, 'https://influx.example', 'cached URL is not overwritten')
})

test('config wins over a stale cached bundle', () => {
  const { app, dir } = tmpApp()
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ slug: 'old', bucket: 'old_raw', writeToken: 'OLDTOK' }))
  const r = resolveAccountConfig(app, { slug: 'new', writeToken: 'NEWTOK' }, { influxUrl: INFLUX })
  assert.strictEqual(r.source, 'config')
  assert.strictEqual(r.bundle.writeToken, 'NEWTOK', 'rotating the token in the UI takes effect')
  assert.strictEqual(r.bundle.bucket, 'new_raw')
})

test('a cache file with no write token is ignored', () => {
  const { app, dir } = tmpApp()
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ slug: 'broken' }))
  const r = resolveAccountConfig(app, {}, { influxUrl: INFLUX })
  assert.strictEqual(r.bundle, null)
})

test('accountConfigured reflects whether sync has credentials', () => {
  const { app } = tmpApp()
  assert.strictEqual(accountConfigured(app, null), false)
  assert.strictEqual(accountConfigured(app, { slug: 'mimi' }), false)
  assert.strictEqual(accountConfigured(app, { slug: 'mimi', writeToken: 'WTOK' }), true)
})
