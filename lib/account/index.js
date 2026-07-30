'use strict'

// Sailkick account pairing — ONE TIME, then cached forever.
//
// The owner enters an invite code + boat name + password once. The plugin POSTs them to
// the app's /api/auth/signup, which provisions the boat's InfluxDB bucket + write token
// and returns an `ingest` bundle. That bundle is cached (0600) in the plugin data dir
// and reused on every subsequent start.
//
// Cache-first is NOT an optimisation here, it is correctness: signup consumes a
// single-use invite and creates the account, so calling it twice returns 403
// bad-invite / 409 slug-taken. The cached bundle is the only repeatable path —
// /auth/login issues a session cookie but no token, and the app never persists the
// write token, so there is nothing to re-fetch.
//
// Dependency-free; never throws.

const fs = require('fs')
const path = require('path')

// Terminal = re-running with the same input can only fail the same way; the owner has
// to change something (new invite, different boat name, longer password).
const TERMINAL_CODES = new Set(['bad-invite', 'slug-taken', 'bad-slug', 'weak-password'])

function cacheFileFor (app) {
  const dataDir = (app.getDataDirPath && app.getDataDirPath()) || '.'
  return path.join(dataDir, 'account.json')
}

function readCache (file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return (j && j.writeToken) ? j : null
  } catch { return null }
}

function writeCache (file, bundle) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(bundle), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {}
}

// True when we could pair right now (nothing cached yet, but all three fields present).
function pairable (account) {
  return !!(account && account.invite && account.slug && account.password)
}

// Returns one of:
//   { bundle, source: 'cache' }             already paired — no network call was made
//   { bundle, source: 'paired' }            just provisioned; bundle now cached
//   { bundle: null, source: null }          not configured (nothing to do)
//   { bundle: null, source: null, error, terminal }   pairing attempted and failed
//
// bundle = { slug, influxUrl, org, bucket, writeToken }
async function resolveAccountConfig (app, account, opts = {}) {
  const file = cacheFileFor(app)

  const cached = readCache(file)
  if (cached) return { bundle: cached, source: 'cache' } // paired already — never call signup again

  if (!pairable(account)) return { bundle: null, source: null }

  const appUrl = String(opts.appUrl || '').replace(/\/+$/, '')
  const url = appUrl + '/api/auth/signup'
  const slug = String(account.slug).trim().toLowerCase()

  let resp
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite: account.invite, slug, password: account.password, name: slug }),
      signal: AbortSignal.timeout(opts.timeoutMs || 20000)
    })
  } catch (e) {
    return { bundle: null, source: null, error: `cannot reach ${appUrl} (${e.message})`, terminal: false }
  }

  const j = await resp.json().catch(() => null)

  if (!resp.ok || !j || j.ok === false) {
    const code = (j && j.code) || `http-${resp.status}`
    const message = (j && j.message) || `HTTP ${resp.status}`
    return { bundle: null, source: null, error: `${message} (${code})`, terminal: TERMINAL_CODES.has(code) }
  }

  const ingest = j.ingest || {}
  if (!ingest.writeToken) {
    return { bundle: null, source: null, error: 'signup returned no write token', terminal: false }
  }

  // NB: signup returns no readToken (the app keeps it in its own registry), so local
  // history falls back to the DB-less ring unless a read token is set by hand.
  const bundle = {
    slug: (j.boat && j.boat.slug) || slug,
    influxUrl: ingest.url,
    org: ingest.org,
    bucket: ingest.bucket,
    writeToken: ingest.writeToken
  }
  writeCache(file, bundle)
  return { bundle, source: 'paired' }
}

// True when the plugin either holds a bundle or has enough input to obtain one.
function accountConfigured (app, account) {
  return !!readCache(cacheFileFor(app)) || pairable(account)
}

module.exports = { resolveAccountConfig, accountConfigured, cacheFileFor }
