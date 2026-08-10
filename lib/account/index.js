'use strict'

// Sailkick account config — a pure local resolver, no network.
//
// Registration happens in the web app: the user redeems an invite there, and the
// signup screen shows the boat's ingest credentials once (see the app's
// public/ui/login-overlay.js). They paste the write token into this plugin, and that
// is the whole handshake. The plugin deliberately does NOT sign up on its own —
// one registration path means no half-created accounts and no spent-invite dead ends.
//
// Everything else about the bundle WAS derivable, so only two fields used to be asked for:
//   bucket = "<slug>_raw"   (the app's convention — server/auth/registry.js bucketFor)
//   org    = "sailkick"     (single org, fleet-wide)
//
// That derivation is no longer reliable. The fleet is moving boat identity from a slug to
// a UUID, and buckets are being renamed with it — this boat went from "addiction_raw" to
// "1fcad258-c422-4e93-a6f9-6811938499f6_raw" while keeping the same token, because
// InfluxDB scopes tokens by bucket ID and a rename preserves it. So `bucket` is now an
// explicit field: blank keeps the old derivation (every pre-existing install is
// untouched), set wins verbatim. The bucket is the actual contract with InfluxDB, so it
// is the thing worth being able to state directly — it survives whatever identity the
// fleet settles on.
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
  // NOT lowercased: a bucket name is taken verbatim from whatever the server called it.
  const bucket = clean(acct.bucket)
  const writeToken = clean(acct.writeToken)

  // Either identifier will do. A boat given an explicit bucket needs no slug at all —
  // newer accounts are issued a UUID bucket and may never see a slug — while an older
  // install that only has a boat name keeps deriving as before.
  if (writeToken && (slug || bucket)) {
    return {
      source: 'config',
      bundle: {
        slug,
        org: clean(acct.org) || DEFAULT_ORG,
        bucket: bucket || `${slug}_raw`,
        writeToken
      }
    }
  }

  const cached = readCache(cacheFileFor(app))
  if (cached) return { bundle: cached, source: 'cache' }

  // Half-filled: say which half, so the status line is actionable.
  if (writeToken) return { bundle: null, source: null, error: 'boat name or data bucket is missing' }
  if (slug || bucket) return { bundle: null, source: null, error: 'write token is missing' }
  return { bundle: null, source: null }
}

// True when sync has credentials to work with.
function accountConfigured (app, account) {
  return !!resolveAccountConfig(app, account).bundle
}

module.exports = { resolveAccountConfig, accountConfigured, cacheFileFor, DEFAULT_ORG }
