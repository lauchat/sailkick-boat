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
test('write token + boat name → a complete bundle, everything else derived', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, { slug: 'mimi', writeToken: 'WTOK' })
  assert.strictEqual(r.source, 'config')
  assert.deepStrictEqual(r.bundle, {
    slug: 'mimi',
    org: 'sailkick',
    bucket: 'mimi_raw', // the app's convention: <slug>_raw
    writeToken: 'WTOK'
  })
  assert.ok(!('influxUrl' in r.bundle), 'the bundle never carries a host')
})

test('an influxUrl in the account config is ignored, not honoured', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, { slug: 'mimi', writeToken: 'WTOK', influxUrl: 'http://localhost:8086' })
  assert.ok(!('influxUrl' in r.bundle), 'a pasted host cannot reach the sync module')
})

test('input is normalised — pasted tokens carry whitespace, names carry case', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, { slug: '  Mimi \n', writeToken: '  WTOK  \n' })
  assert.strictEqual(r.bundle.slug, 'mimi')
  assert.strictEqual(r.bundle.writeToken, 'WTOK')
  assert.strictEqual(r.bundle.bucket, 'mimi_raw')
})

test('resolving is offline-safe and makes no network call', () => {
  const { app } = tmpApp()
  const realFetch = global.fetch
  global.fetch = () => { throw new Error('resolveAccountConfig must never hit the network') }
  try {
    const r = resolveAccountConfig(app, { slug: 'mimi', writeToken: 'WTOK' })
    assert.strictEqual(r.bundle.writeToken, 'WTOK')
  } finally { global.fetch = realFetch }
})

test('half-filled config says which half is missing', () => {
  const { app } = tmpApp()
  const noToken = resolveAccountConfig(app, { slug: 'mimi' })
  assert.strictEqual(noToken.bundle, null)
  assert.match(noToken.error, /write token/)

  const noSlug = resolveAccountConfig(app, { writeToken: 'WTOK' })
  assert.strictEqual(noSlug.bundle, null)
  assert.match(noSlug.error, /boat name/)
})

test('empty config is a no-op, not an error', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, {})
  assert.strictEqual(r.bundle, null)
  assert.strictEqual(r.source, null)
  assert.strictEqual(r.error, undefined)
})

test('a hand-written account.json still works (pre-0.14.2 installs)', () => {
  const { app, dir } = tmpApp()
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({
    slug: 'legacy', influxUrl: 'https://influx.example', org: 'sailkick', bucket: 'legacy_raw', writeToken: 'OLDTOK'
  }))
  const r = resolveAccountConfig(app, {})
  assert.strictEqual(r.source, 'cache')
  assert.strictEqual(r.bundle.writeToken, 'OLDTOK')
  assert.ok(!('influxUrl' in r.bundle), 'a cached host is stripped — those came off the signup screen')
})

test('config wins over a stale cached bundle', () => {
  const { app, dir } = tmpApp()
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ slug: 'old', bucket: 'old_raw', writeToken: 'OLDTOK' }))
  const r = resolveAccountConfig(app, { slug: 'new', writeToken: 'NEWTOK' })
  assert.strictEqual(r.source, 'config')
  assert.strictEqual(r.bundle.writeToken, 'NEWTOK', 'rotating the token in the UI takes effect')
  assert.strictEqual(r.bundle.bucket, 'new_raw')
})

test('a cache file with no write token is ignored', () => {
  const { app, dir } = tmpApp()
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ slug: 'broken' }))
  const r = resolveAccountConfig(app, {})
  assert.strictEqual(r.bundle, null)
})

test('accountConfigured reflects whether sync has credentials', () => {
  const { app } = tmpApp()
  assert.strictEqual(accountConfigured(app, null), false)
  assert.strictEqual(accountConfigured(app, { slug: 'mimi' }), false)
  assert.strictEqual(accountConfigured(app, { slug: 'mimi', writeToken: 'WTOK' }), true)
})

// --- endpoint pinning (v0.14.4) -------------------------------------------------
// A pre-0.14 install still carries whatever was typed into the old, now-removed
// influxUrl / sailkickUrl fields. Those are leftovers, not intent: obeying them sent a
// boat's telemetry to a dev LAN box for a day. Exercised through the real plugin so the
// precedence in startModules is what's under test, not a reimplementation of it.
const os2 = require('node:os')

function bootPlugin (config) {
  for (const k of Object.keys(require.cache)) delete require.cache[k]
  const seen = {}
  for (const [mod, key] of [['../lib/sync', 'createSync'], ['../lib/history', 'createHistory']]) {
    const p = require.resolve(require('node:path').join(__dirname, mod))
    require.cache[p] = {
      id: p,
      filename: p,
      loaded: true,
      exports: {
        [key]: (app, opts) => {
          seen[key] = opts
          return { start () {}, stop () {}, status: () => '', available: () => false }
        }
      }
    }
  }
  const dir = fs.mkdtempSync(require('node:path').join(os2.tmpdir(), 'sk-pin-'))
  const errors = []
  let status = ''
  const app = {
    debug () {}, error (m) { errors.push(m) }, getDataDirPath: () => dir,
    setPluginStatus (s) { status = s }, selfId: 'u',
    subscriptionmanager: { subscribe () {} }, getSelfPath: () => null
  }
  const pl = require('../index.js')(app)
  pl.start(config)
  pl.stop()
  return { syncOpts: seen.createSync, errors, status }
}

const CLOUD = 'https://sync.sailkick.io'
const ACCOUNT = { slug: 'addiction', writeToken: 'WTOK' }

test('a stale sync.influxUrl from an older config is ignored, not obeyed', () => {
  const { syncOpts, errors, status } = bootPlugin({
    account: ACCOUNT,
    sync: { enabled: true, influxUrl: 'http://192.168.5.222:8086', bucket: 'myboat_raw', token: 'OLD' },
    proxy: { enabled: false }
  })
  assert.strictEqual(syncOpts.influxUrl, CLOUD, 'the fleet endpoint wins')
  assert.strictEqual(syncOpts.bucket, 'addiction_raw', 'bucket comes from the account, not the stale config')
  assert.strictEqual(syncOpts.token, 'WTOK')
  assert.ok(errors.some((e) => /ignoring sync\.influxUrl.*192\.168\.5\.222/.test(e)), 'says so in the log')
  assert.match(status, /ignoring stale influxUrl/, 'and in the status line')
})

test('selfHosted:true honours an explicit endpoint', () => {
  const { syncOpts, errors } = bootPlugin({
    account: ACCOUNT,
    sync: { enabled: true, selfHosted: true, influxUrl: 'https://influx.self.example' },
    proxy: { enabled: false }
  })
  assert.strictEqual(syncOpts.influxUrl, 'https://influx.self.example')
  assert.ok(!errors.some((e) => /ignoring/.test(e)), 'deliberate self-hosting is not nagged about')
})

test('a private-range self-hosted endpoint still warns', () => {
  const { status } = bootPlugin({
    account: ACCOUNT,
    sync: { enabled: true, selfHosted: true, influxUrl: 'http://192.168.5.222:8086' },
    proxy: { enabled: false }
  })
  assert.match(status, /private address/, 'RFC1918 is flagged, not just loopback')
})

test('no endpoint configured: the constant is used silently', () => {
  const { syncOpts, errors, status } = bootPlugin({ account: ACCOUNT, proxy: { enabled: false } })
  assert.strictEqual(syncOpts.influxUrl, CLOUD)
  assert.strictEqual(errors.length, 0)
  assert.ok(!/⚠|ignoring/.test(status))
})

// --- explicit bucket (v0.21.0) ------------------------------------------------------
// The fleet is moving boat identity from a slug to a UUID, renaming buckets with it —
// this boat went addiction_raw -> 1fcad258-c422-4e93-a6f9-6811938499f6_raw, keeping the
// same token because InfluxDB scopes tokens by bucket ID and a rename preserves it.
// Deriving `${slug}_raw` can therefore no longer be the only option.
const UUID_BUCKET = '1fcad258-c422-4e93-a6f9-6811938499f6_raw'

test('account: an explicit bucket wins over the derived one', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, { slug: 'addiction', writeToken: 'WTOK', bucket: UUID_BUCKET })
  assert.strictEqual(r.source, 'config')
  assert.strictEqual(r.bundle.bucket, UUID_BUCKET, 'not addiction_raw')
  assert.strictEqual(r.bundle.slug, 'addiction', 'the name is kept for display')
  assert.strictEqual(r.bundle.writeToken, 'WTOK')
})

test('account: a bucket alone is enough — newer accounts may have no slug', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, { writeToken: 'WTOK', bucket: UUID_BUCKET })
  assert.strictEqual(r.source, 'config')
  assert.strictEqual(r.bundle.bucket, UUID_BUCKET)
  assert.strictEqual(r.bundle.slug, '', 'no name, and that is fine')
  assert.ok(accountConfigured(app, { writeToken: 'WTOK', bucket: UUID_BUCKET }))
})

test('account: a blank bucket still derives from the boat name (no regression)', () => {
  const { app } = tmpApp()
  for (const bucket of [undefined, '', '   ']) {
    const r = resolveAccountConfig(app, { slug: 'addiction', writeToken: 'WTOK', bucket })
    assert.strictEqual(r.bundle.bucket, 'addiction_raw', `bucket=${JSON.stringify(bucket)}`)
  }
})

test('account: the bucket is taken verbatim — never lowercased like the slug', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, { slug: 'MiMi', writeToken: 'WTOK', bucket: 'Boat-UUID_RAW' })
  assert.strictEqual(r.bundle.slug, 'mimi', 'slug is normalised')
  assert.strictEqual(r.bundle.bucket, 'Boat-UUID_RAW', 'bucket is not')
})

test('account: a token with neither name nor bucket is still an actionable error', () => {
  const { app } = tmpApp()
  const r = resolveAccountConfig(app, { writeToken: 'WTOK' })
  assert.strictEqual(r.bundle, null)
  assert.match(r.error, /bucket/, 'the message mentions the new field')
})
