'use strict'

// Sailkick account auto-config. Instead of pasting InfluxDB URL/org/bucket/write-token
// into the plugin, the owner enters host + slug + password; on start the plugin POSTs
// them to the sailkick app's /api/boat/config and gets its cloud config back. The
// last-good bundle is cached (0600) so sync keeps working offline after the first
// connect. Dependency-free; never throws.

const fs = require('fs')
const path = require('path')

function accountConfigured (account) {
  return !!(account && account.sailkickUrl && account.slug && account.password)
}

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

// Returns { bundle, source: 'live'|'cache'|null, error? }.
// bundle = { influxUrl, org, bucket, writeToken, readToken }.
async function resolveAccountConfig (app, account, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000
  const file = cacheFileFor(app)
  const url = String(account.sailkickUrl).replace(/\/+$/, '') + '/api/boat/config'
  const fallback = (error) => { const c = readCache(file); return { bundle: c, source: c ? 'cache' : null, error } }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: account.slug, password: account.password }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      return fallback(`HTTP ${resp.status}: ${body.slice(0, 120)}`) // offline-safe: keep the cached bundle
    }
    const j = await resp.json().catch(() => null)
    if (!j || j.ok === false || !j.writeToken) return fallback('unexpected /api/boat/config response')
    const bundle = { influxUrl: j.influxUrl, org: j.org, bucket: j.bucket, writeToken: j.writeToken, readToken: j.readToken }
    writeCache(file, bundle)
    return { bundle, source: 'live' }
  } catch (e) {
    return fallback(e.message) // offline / unreachable → use the cached bundle
  }
}

module.exports = { resolveAccountConfig, accountConfigured }
