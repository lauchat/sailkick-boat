'use strict'

const path = require('path')

const { createSync } = require('./lib/sync')
const { createProxy } = require('./lib/proxy')
const { createTelemetry } = require('./lib/telemetry')
const { createHistory } = require('./lib/history')
const { createBackfill } = require('./lib/backfill')
const { createAis } = require('./lib/ais')
const { resolveAccountConfig } = require('./lib/account')

// sailkick-boat: one Signal K plugin, two independently-toggleable modules —
//   sync : gapless store-and-forward of self telemetry to InfluxDB (data OUT)
//   proxy: offline-first caching mirror of the sailkick host (data IN)
// Kept as separate modules so a proxy fault can't wedge the data-critical sync.

// Fixed cloud endpoints. Boats never choose these, so they are constants rather than
// config fields, and NOTHING in a saved config may override them unless `selfHosted` is
// explicitly set (see resolveEndpoint).
//
// v0.14.3 kept `sync.influxUrl` / `proxy.sailkickUrl` as a silent escape hatch, on the
// reasoning that a value could only get there by deliberate hand-editing. That was
// wrong: both were VISIBLE FIELDS before v0.14.0, so every upgraded install still has
// whatever was typed into them — and since they are no longer in the schema, the owner
// can neither see nor clear them from the UI. One boat spent a day POSTing valid cloud
// credentials at a dev LAN address for exactly this reason. Stale wins over intent, so
// leftovers are now ignored and reported rather than obeyed.
const SAILKICK_APP_URL = 'https://www.sailkick.io' // signup + mirror upstream
const SAILKICK_INFLUX_URL = 'https://sync.sailkick.io' // data egress

// Tuning that has a right answer. Deliberately NOT on the config page: a boat owner has
// no basis to choose these, and a wrong value silently degrades sync or the cache.
const SYNC_TUNING = {
  org: 'sailkick',
  batchSize: 1000,
  flushIntervalMs: 1000,
  maxBufferBytes: 500 * 1024 * 1024,
  subscribePeriodMs: 1000,
  requestTimeoutMs: 30000,
  retryMinMs: 1000,
  retryMaxMs: 60000
}
const PROXY_TUNING = { requestTimeoutMs: 20000, localPaths: ['/signalk'], telemetryPath: '/ws/telemetry' }
const MANIFEST = { enabled: true, path: '/api/cache-manifest', pollIntervalSec: 300 }
const SEED_TUNING = { coastlineMaxZoom: 8, seabedMaxZoom: 6, concurrency: 4 }
const PREFETCH_TUNING = { concurrency: 4 }
const HISTORY_TUNING = { ringPersist: true, ringWindowSec: 86400, ringSampleSec: 15 }
const BACKFILL_SRC_DEFAULTS = { influxUrl: 'http://127.0.0.1:8086', org: 'signalk', bucket: 'signalk' }

// A *cloud* endpoint on a loopback or private address means telemetry never leaves the
// LAN. On the wire that is indistinguishable from a normal offline backlog — the spool
// just grows — so it has to be called out explicitly. Covers RFC1918 as well as
// loopback: the case that actually bit was a 192.168.x dev box, which a loopback-only
// check sailed straight past. (The local history DB is legitimately on 127.0.0.1; this
// is only ever applied to the sync path.)
function isPrivateHostUrl (u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '')
    if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return true
    if (/^10\./.test(h) || /^192\.168\./.test(h)) return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
    return false
  } catch { return false }
}

// The Signal K config UI writes every schema default on save, so a freshly pre-filled
// `backfillOrg: "signalk"` can appear on a boat whose archive has always lived in org
// "addiction" under the pre-0.15 `proxy.history` block — and the backfill would read an
// empty bucket. Rule: an explicitly-changed field wins; else a legacy value that differs
// from the default wins; else the default.
function pickField (flat, legacy, dflt) {
  const f = String(flat == null ? '' : flat).trim()
  const l = String(legacy == null ? '' : legacy).trim()
  if (f && f !== dflt) return { value: f, from: 'config' }
  if (l && l !== dflt) return { value: l, from: 'legacy' }
  return { value: f || l || dflt, from: 'default' }
}

// Endpoint resolution with one rule: the constant wins unless self-hosting is declared.
// Returns { url, ignored } — `ignored` is the stale value we refused, so the caller can
// say so out loud instead of leaving the owner to guess why nothing arrives.
function resolveEndpoint (configured, constant, selfHosted) {
  const v = typeof configured === 'string' ? configured.trim() : ''
  if (!v || v === constant) return { url: constant, ignored: null }
  if (selfHosted) return { url: v, ignored: null }
  return { url: constant, ignored: v }
}

module.exports = function (app) {
  let sync = null
  let proxy = null
  let telemetry = null
  let history = null
  let backfill = null
  let ais = null
  let statusTimer = null
  let accountStatus = null
  let syncWarning = null

  const plugin = {
    id: 'sailkick-boat',
    name: 'Sailkick boat companion',
    description:
      'Boat-side sailkick: gapless telemetry sync to the cloud + an offline-first ' +
      'caching mirror of the sailkick app. Each feature can be toggled on/off.'
  }

  plugin.schema = {
    type: 'object',
    properties: {
      account: {
        type: 'object',
        title: 'Sailkick account',
        description: 'Register your boat at www.sailkick.io first — the signup screen shows a write token. Paste it here together with your boat name. Keep that token safe: it is shown only once and cannot be recovered.',
        properties: {
          slug: { type: 'string', title: 'Boat name', description: 'Exactly as registered on the website.' },
          writeToken: { type: 'string', title: 'Write token', description: 'From the signup screen ("Write token"). Everything else — Influx URL, organization, bucket — is derived from it and your boat name.' }
        }
      },
      sync: {
        type: 'object',
        title: 'Telemetry sync → cloud',
        description: 'Send this vessel\'s data to your sailkick account. Buffered on disk, so an offline passage or a restart loses nothing. Requires pairing above.',
        properties: {
          enabled: { type: 'boolean', title: 'Enable telemetry sync', default: true }
        }
      },
      ais: {
        type: 'object',
        title: 'Upload AIS targets',
        description: 'Send the AIS this boat\'s own receiver hears to the cloud, so the web app can show other vessels, their heading and their trail. Only locally received AIS is forwarded — an internet feed such as signalk-aisstream is skipped, since the cloud can fetch that itself without spending your uplink. REQUIRES a cloud that filters history on self; until then leave this off or the owner\'s SOG and heading charts will pick up other ships.',
        properties: {
          enabled: { type: 'boolean', title: 'Upload AIS targets', default: false },
          source: { type: 'string', title: 'Only this AIS source', description: 'Blank forwards every source except known internet feeds. The plugin logs the AIS sources it sees — copy the one for your own receiver here if you want to be explicit.' }
        }
      },
      backfill: {
        type: 'object',
        title: 'Copy older history to the cloud (one-time)',
        description: 'If this boat recorded data into its own InfluxDB before it started syncing — a signalk-to-influxdb-v2 bucket, or an imported logbook — this copies it up so the app can chart it. It runs in the background, resumes after a restart, verifies every hour it uploads, and stands aside whenever live telemetry is behind. Safe to re-run: identical points overwrite rather than duplicate.',
        properties: {
          enabled: { type: 'boolean', title: 'Run the backfill', default: false },
          cloudToken: { type: 'string', title: 'Cloud read+write token', description: 'A token with READ and WRITE on your cloud bucket. Your normal write token cannot read, and reading is how each uploaded hour is verified. Needed only while the backfill runs — revoke it afterwards; live sync is unaffected.' },
          sourceToken: { type: 'string', title: 'Local InfluxDB read token' },
          sourceUrl: { type: 'string', title: '…local InfluxDB URL', default: 'http://127.0.0.1:8086' },
          sourceOrg: { type: 'string', title: '…organization', default: 'signalk' },
          sourceBucket: { type: 'string', title: '…bucket', default: 'signalk' }
        }
      },
      proxy: {
        type: 'object',
        title: 'Offline app & maps',
        description: 'Serve the sailkick app on board — charts, trends and live data keep working with no internet.',
        properties: {
          enabled: { type: 'boolean', title: 'Enable the offline mirror', default: true },
          proxyPort: { type: 'number', title: 'Mirror port', description: 'Open the app at http://<boat>:<port>/. 0 = disable the standalone server.', default: 8080 },
          localSignalkUrl: { type: 'string', title: 'Local SignalK URL', description: 'Where this plugin reaches SignalK for live data. Change only if SignalK is not on the default port.', default: 'http://127.0.0.1:3000' },
          dataDir: { type: 'string', title: 'Data directory', description: 'Where cached maps, the telemetry buffer and local history live. Put this on the SSD/USB disk — not the SD card. Blank = the plugin data dir.' },
          seedEnabled: { type: 'boolean', title: 'Download a worldwide base map on start', description: 'Caches a low-zoom coastline + seabed base (~17k tiles) so a usable map exists offline everywhere. Runs once, resumes if interrupted.', default: true },
          prefetchRadiusNm: {
            type: 'number',
            title: 'Download detailed charts around the boat',
            description: 'On save, caches the full chart detail for this radius around the boat\'s current position. Progress shows in the status line.',
            enum: [0, 25, 50, 100, 200],
            enumNames: ['Off', '25 nm', '50 nm', '100 nm', '200 nm'],
            default: 0
          },
          prefetchDetailZoom: {
            type: 'number',
            title: '…at this detail level',
            enum: [12, 13, 14, 15],
            enumNames: ['Overview (z12)', 'Coastal (z13)', 'Detailed (z14)', 'Harbor (z15)'],
            default: 13
          }
        }
      }
    }
  }

  plugin.start = function (options) {
    const opts = options || {}
    try {
      // Purely local: the boat registers on the website, the owner pastes the write
      // token here. Nothing to fetch, so nothing that can fail while offline.
      const r = resolveAccountConfig(app, opts.account)
      if (r.bundle) accountStatus = `account: ${r.bundle.slug}`
      else if (r.error) accountStatus = `account: ${r.error}`
      else accountStatus = 'account: not configured — register at www.sailkick.io, then paste your write token'
      startModules(opts, r.bundle)
    } catch (e) {
      (app.error || console.error)('[sailkick-boat] start failed: ' + e.message)
    }
  }

  function startModules (opts, bundle) {
    const s = opts.sync || {}
    const p = opts.proxy || {}
    const b = bundle || {}
    // One "Data directory" now drives cache + spool + ring log. `storeDir` is its
    // pre-0.14 name — keep honouring it so an upgrade doesn't strand an existing tile
    // cache. When nothing is set we pass undefined and let each module apply its own
    // historical default (<pluginData>/store, <pluginData>/spool), so an upgrade never
    // orphans a populated cache or a spool full of unsent telemetry.
    const store = p.dataDir || p.storeDir || undefined
    const spoolDir = s.spoolDir || (p.dataDir ? path.join(p.dataDir, 'spool') : undefined)

    // Self-hosting is opt-in and explicit. Without it, a saved endpoint is treated as a
    // leftover from an older version rather than as intent.
    const selfHosted = s.selfHosted === true || p.selfHosted === true
    const influx = resolveEndpoint(s.influxUrl, SAILKICK_INFLUX_URL, selfHosted)
    const upstream = resolveEndpoint(p.sailkickUrl, SAILKICK_APP_URL, selfHosted)

    // --- sync module (isolated: its failure must not affect the proxy) ---
    if (s.enabled !== false) {
      const syncOpts = {
        ...SYNC_TUNING,
        influxUrl: influx.url,
        org: b.org || s.org || SYNC_TUNING.org,
        bucket: b.bucket || s.bucket,
        token: b.writeToken || s.token,
        spoolDir,
        batchSize: s.batchSize || SYNC_TUNING.batchSize,
        flushIntervalMs: s.flushIntervalMs || SYNC_TUNING.flushIntervalMs,
        maxBufferBytes: s.maxBufferBytes || SYNC_TUNING.maxBufferBytes,
        subscribePeriodMs: s.subscribePeriodMs || SYNC_TUNING.subscribePeriodMs,
        requestTimeoutMs: s.requestTimeoutMs || SYNC_TUNING.requestTimeoutMs,
        retryMinMs: s.retryMinMs || SYNC_TUNING.retryMinMs,
        retryMaxMs: s.retryMaxMs || SYNC_TUNING.retryMaxMs
      }
      // One unconditional line naming the actual target. This is the single most useful
      // thing in the log: it would have shown the stale 192.168.x address instantly,
      // instead of a day spent inferring it from an absence of errors.
      console.log(`[sailkick-boat] sync -> ${syncOpts.influxUrl} org=${syncOpts.org} bucket=${syncOpts.bucket || '(none)'}${selfHosted ? ' [self-hosted]' : ''}`)

      if (influx.ignored) {
        syncWarning = `sync: ignoring stale influxUrl ${influx.ignored} — using ${influx.url}`
        ;(app.error || console.error)(`[sailkick-boat] ignoring sync.influxUrl "${influx.ignored}" left over from an older config — using ${influx.url}. Set sync.selfHosted:true to keep your own endpoint.`)
      } else if (isPrivateHostUrl(syncOpts.influxUrl)) {
        syncWarning = `sync: ⚠ writing to ${syncOpts.influxUrl} — a private address, telemetry is NOT reaching the cloud`
        ;(app.error || console.error)(`[sailkick-boat] sync target ${syncOpts.influxUrl} is a loopback/private address — telemetry will not reach the cloud`)
      }
      try { sync = createSync(app, syncOpts); sync.start() } catch (e) {
        (app.error || console.error)('[sailkick-boat] sync start failed: ' + e.message)
        sync = null
      }
    }

    // --- proxy module (+ /ws/telemetry provider and /api/history from local sources) ---
    if (p.enabled !== false) {
      const oldSeed = p.seed || {}
      const oldPrefetch = p.prefetch || {}
      const oldHistory = p.history || {}
      console.log('[sailkick-boat] history -> live ring')

      if (upstream.ignored) {
        ;(app.error || console.error)(`[sailkick-boat] ignoring proxy.sailkickUrl "${upstream.ignored}" left over from an older config — mirroring ${upstream.url}. Set proxy.selfHosted:true to keep your own server.`)
      }
      const pOpts = {
        sailkickUrl: upstream.url,
        storeDir: store,
        proxyPort: p.proxyPort == null ? 8080 : p.proxyPort,
        localSignalkUrl: p.localSignalkUrl || 'http://127.0.0.1:3000',
        localPaths: (p.localPaths && p.localPaths.length) ? p.localPaths : PROXY_TUNING.localPaths,
        telemetryPath: p.telemetryPath || PROXY_TUNING.telemetryPath,
        requestTimeoutMs: p.requestTimeoutMs || PROXY_TUNING.requestTimeoutMs,
        openAccess: p.openAccess !== false, // single-tenant boat: the cloud login gate can't work over plain HTTP
        manifest: MANIFEST, // always on — freshness comes from the cloud announcing bakes
        seed: {
          ...SEED_TUNING,
          // Never seed an unpaired boat: it would pull ~17k tiles from a host this
          // install has no account on, and retry forever behind the circuit breaker.
          // Pair first, then the worldwide base downloads on the next start.
          enabled: !!b.writeToken && (p.seedEnabled != null ? p.seedEnabled !== false : oldSeed.enabled !== false),
          coastlineMaxZoom: oldSeed.coastlineMaxZoom || SEED_TUNING.coastlineMaxZoom,
          seabedMaxZoom: oldSeed.seabedMaxZoom || SEED_TUNING.seabedMaxZoom,
          concurrency: oldSeed.concurrency || SEED_TUNING.concurrency
        },
        prefetch: {
          radiusNm: p.prefetchRadiusNm != null ? p.prefetchRadiusNm : oldPrefetch.radiusNm,
          detailZoom: p.prefetchDetailZoom != null ? p.prefetchDetailZoom : oldPrefetch.detailZoom,
          concurrency: oldPrefetch.concurrency || PREFETCH_TUNING.concurrency
        },
        history: {
          ...HISTORY_TUNING,
          enabled: oldHistory.enabled !== false,
          ringPersist: oldHistory.ringPersist !== false,
          ringWindowSec: oldHistory.ringWindowSec || HISTORY_TUNING.ringWindowSec,
          ringSampleSec: oldHistory.ringSampleSec || HISTORY_TUNING.ringSampleSec,
          ringDir: oldHistory.ringDir
        }
      }

      if (p.serveTelemetry !== false) {
        try {
          telemetry = createTelemetry(app, {})
          telemetry.start()
          pOpts.telemetryUpgrade = (req, sock, head) => telemetry.handleUpgrade(req, sock, head)
        } catch (e) {
          (app.error || console.error)('[sailkick-boat] telemetry start failed: ' + e.message)
          telemetry = null
        }
      }
      if (pOpts.history.enabled !== false) {
        try {
          // ringSource = the telemetry module: when no local InfluxDB token is set
          // (the common case, e.g. a Victron GX), history serves a DB-less ring from
          // live telemetry. storeDir puts the persistent ring log on the SSD.
          history = createHistory(app, { ...pOpts.history, ringSource: telemetry, storeDir: store })
          history.start()
          pOpts.history = history // proxy dispatches /api/history to it when available()
        } catch (e) {
          (app.error || console.error)('[sailkick-boat] history start failed: ' + e.message)
          history = null
          pOpts.history = null
        }
      } else {
        pOpts.history = null
      }

      try { proxy = createProxy(app, pOpts); proxy.start() } catch (e) {
        (app.error || console.error)('[sailkick-boat] proxy start failed: ' + e.message)
        proxy = null
      }
    }

    // --- AIS upload (isolated; yields to telemetry, its own spool) ---
    const aisOpts = opts.ais || {}
    if (aisOpts.enabled === true) {
      if (!b.writeToken) {
        (app.error || console.error)('[sailkick-boat] AIS upload needs a paired account for its destination bucket — skipped')
      } else {
        try {
          ais = createAis(app, {
            influxUrl: influx.url,
            org: b.org || SYNC_TUNING.org,
            bucket: b.bucket,
            token: b.writeToken,
            source: String(aisOpts.source || '').trim() || null,
            spoolDir: store ? path.join(store, 'ais-spool') : undefined,
            pending: sync ? sync.pending : null
          })
          ais.start()
          console.log(`[sailkick-boat] ais -> ${influx.url} bucket=${b.bucket}${aisOpts.source ? ' source=' + aisOpts.source : ''}`)
        } catch (e) {
          (app.error || console.error)('[sailkick-boat] AIS start failed: ' + e.message)
          ais = null
        }
      }
    }

    // --- backfill (best-effort, isolated: it must never disturb sync or the proxy) ---
    const bf = opts.backfill || {}
    const oldHist = (opts.proxy || {}).history || {}
    if (bf.enabled === true) {
      // Pre-0.15 installs kept the archive's coordinates in proxy.history.* — reuse them
      // so nobody retypes an org/bucket the plugin already knows.
      const src = {
        url: pickField(bf.sourceUrl, oldHist.influxUrl, BACKFILL_SRC_DEFAULTS.influxUrl).value,
        org: pickField(bf.sourceOrg, oldHist.org, BACKFILL_SRC_DEFAULTS.org).value,
        bucket: pickField(bf.sourceBucket, oldHist.bucket, BACKFILL_SRC_DEFAULTS.bucket).value,
        token: String(bf.sourceToken || oldHist.token || '').trim()
      }
      const dst = { url: influx.url, org: b.org || SYNC_TUNING.org, bucket: b.bucket, token: String(bf.cloudToken || '').trim() }
      if (!b.writeToken) {
        (app.error || console.error)('[sailkick-boat] backfill needs a paired account for its destination bucket — skipped')
      } else if (!dst.token) {
        (app.error || console.error)('[sailkick-boat] backfill needs a cloud READ+WRITE token: every uploaded hour is verified by counting the destination, which the write-only sync token cannot do — skipped')
      } else if (!src.token) {
        (app.error || console.error)('[sailkick-boat] backfill needs a read token for the local InfluxDB — skipped')
      } else {
        try {
          backfill = createBackfill(app, {
            src,
            dst,
            selfOnly: bf.selfOnly === true,
            startBound: bf.startBound,
            stateFile: path.join((app.getDataDirPath && app.getDataDirPath()) || '.', 'backfill.json'),
            pending: sync ? sync.pending : null
          })
          backfill.start()
        } catch (e) {
          (app.error || console.error)('[sailkick-boat] backfill start failed: ' + e.message)
          backfill = null
        }
      }
    }

    statusTimer = setInterval(updateStatus, 5000)
    updateStatus()
  }

  function updateStatus () {
    if (!app.setPluginStatus) return
    const parts = []
    if (accountStatus) parts.push(accountStatus)
    if (syncWarning) parts.push(syncWarning)
    if (sync) parts.push(sync.status())
    if (proxy) parts.push(proxy.status())
    if (telemetry) parts.push(telemetry.status())
    if (history) parts.push(history.status())
    if (ais) parts.push(ais.status())
    if (backfill) parts.push(backfill.status())
    try { app.setPluginStatus(parts.join('   |   ') || 'idle (both features off)') } catch {}
  }

  plugin.stop = function () {
    if (statusTimer) clearInterval(statusTimer)
    statusTimer = null
    try { if (sync) sync.stop() } catch {}
    try { if (telemetry) telemetry.stop() } catch {}
    try { if (history) history.stop() } catch {}
    try { if (ais) ais.stop() } catch {}
    try { if (backfill) backfill.stop() } catch {}
    try { if (proxy) proxy.stop() } catch {}
    sync = null
    telemetry = null
    history = null
    backfill = null
    ais = null
    proxy = null
    accountStatus = null
    syncWarning = null
  }

  // Mounted by Signal K at /plugins/sailkick-boat. Handlers dispatch to the live
  // proxy module (created in start), so enable/disable works at request time.
  plugin.registerWithRouter = function (router) {
    router.get('/p/*', (req, res) => {
      if (proxy) proxy.handleGet(req, res)
      else res.status(503).send('proxy not enabled')
    })
    router.post('/prefetch', (req, res) => {
      if (proxy) proxy.handlePrefetch(req, res)
      else res.status(503).send('proxy not enabled')
    })
    router.post('/prefetch/region', (req, res) => {
      if (proxy) proxy.handlePrefetchRegion(req, res)
      else res.status(503).send('proxy not enabled')
    })
    router.post('/cache/clear', (req, res) => {
      if (proxy) proxy.handleClear(req, res)
      else res.status(503).send('proxy not enabled')
    })
  }

  return plugin
}
