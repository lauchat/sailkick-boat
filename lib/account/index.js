'use strict'

// Sailkick account config — a pure local resolver, no network.
//
// Registration happens in the web app: the user redeems an invite there, and the
// signup screen shows the boat's ingest credentials once (see the app's
// public/ui/login-overlay.js). They paste the write token into this plugin, and that
// is the whole handshake. The plugin deliberately does NOT sign up on its own —
// one registration path means no half-created accounts and no spent-invite dead ends.
//
// Everything else about the bundle is derivable, so only two fields are asked for:
//   bucket = "<slug>_raw"   (the app's convention — server/auth/registry.js bucketFor)
//   org    = "sailkick"     (single org, fleet-wide)
//
// This bundle deliberately carries NO Influx URL. "Which boat am I" and "where is the
// cloud" are separate questions, and the second one has a single fleet-wide answer that
// index.js owns. Letting a pasted or cached value set the host is how telemetry ends up
// spooling to a loopback address forever while the status line looks healthy — the app's
// signup screen has been handing out its own internal http://localhost:8086.
//
// NB the write token cannot be re-fetched: the app shows it once at signup and never
// stores it (registry.js keeps only passwordHash + influxReadToken). Losing it means
// minting a new one, so the pasted value is the source of truth here.

const fs = require('fs')
const path = require('path')

const DEFAULT_ORG = 'sailkick'

function cacheFileFor (app) {
  const dataDir = (app.getDataDirPath && app.getDataDirPath()) || '.'
  return path.join(dataDir, 'account.json')
}

// Legacy/manual escape hatch: a hand-written (or pre-0.14.2) account.json still works,
// so an install that was set up before the token field existed keeps syncing. Any
// influxUrl in such a file is dropped — those were copied off the signup screen, which
// was showing the server's own loopback address.
function readCache (file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!j || !j.writeToken) return null
    const { influxUrl, ...rest } = j
    return rest
  } catch { return null }
}

const clean = (v) => String(v == null ? '' : v).trim()

// Returns one of:
//   { bundle, source: 'config' }   token pasted into the plugin config
//   { bundle, source: 'cache' }    from a hand-written/legacy account.json
//   { bundle: null, source: null, error? }
//
// bundle = { slug, org, bucket, writeToken } — no influxUrl by design, see above.
function resolveAccountConfig (app, account) {
  const acct = account || {}
  const slug = clean(acct.slug).toLowerCase()
  const writeToken = clean(acct.writeToken)

  if (slug && writeToken) {
    return {
      source: 'config',
      bundle: {
        slug,
        org: clean(acct.org) || DEFAULT_ORG,
        bucket: clean(acct.bucket) || `${slug}_raw`,
        writeToken
      }
    }
  }

  const cached = readCache(cacheFileFor(app))
  if (cached) return { bundle: cached, source: 'cache' }

  // Half-filled: say which half, so the status line is actionable.
  if (writeToken) return { bundle: null, source: null, error: 'boat name is missing' }
  if (slug) return { bundle: null, source: null, error: 'write token is missing' }
  return { bundle: null, source: null }
}

// True when sync has credentials to work with.
function accountConfigured (app, account) {
  return !!resolveAccountConfig(app, account).bundle
}

module.exports = { resolveAccountConfig, accountConfigured, cacheFileFor, DEFAULT_ORG }
