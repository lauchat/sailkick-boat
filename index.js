'use strict'

const path = require('path')

const { createSync } = require('./lib/sync')
const { createProxy } = require('./lib/proxy')
const { createTelemetry } = require('./lib/telemetry')
const { createHistory } = require('./lib/history')
const { resolveAccountConfig } = require('./lib/account')

// sailkick-boat: one Signal K plugin, two independently-toggleable modules —
//   sync : gapless store-and-forward of self telemetry to InfluxDB (data OUT)
//   proxy: offline-first caching mirror of the sailkick host (data IN)
// Kept as separate modules so a proxy fault can't wedge the data-critical sync.

// Fixed cloud endpoints. Boats never choose these, so they are constants rather than
// config fields — but every module still reads its option first (see startModules), so
// a hand-edited plugin-config JSON can override any of them for self-hosting.
const SAILKICK_APP_URL = 'https://www.sailkick.io' // signup + mirror upstream
const SAILKICK_INFLUX_URL = 'https://sync.sailkick.io' // data egress; pairing overrides this

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
const HISTORY_TUNING = {
  influxUrl: 'http://127.0.0.1:8086',
  org: 'signalk',
  bucket: 'signalk',
  requestTimeoutMs: 15000,
  ringPersist: true,
  ringWindowSec: 86400,
  ringSampleSec: 15
}

// A *cloud* endpoint on loopback means telemetry never leaves the boat. On the wire it
// is indistinguishable from a normal offline backlog — the spool just grows — so it has
// to be called out explicitly. (The local history DB is legitimately on 127.0.0.1; this
// check is only ever applied to the sync path.)
function isLoopbackUrl (u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '')
    return h === 'localhost' || h === '::1' || /^127\./.test(h)
  } catch { return false }
}

module.exports = function (app) {
  let sync = null
  let proxy = null
  let telemetry = null
  let history = null
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
          },
          historyToken: { type: 'string', title: 'Local InfluxDB read token (optional)', description: 'Only if this boat already runs its own InfluxDB (e.g. signalk-to-influxdb-v2) and you want full history from it. Leave blank — the plugin then keeps its own lightweight history, which is what most boats want.' }
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

    // --- sync module (isolated: its failure must not affect the proxy) ---
    // Pairing wins over hand-written fields; hand-written fields win over the constants.
    if (s.enabled !== false) {
      const syncOpts = {
        ...SYNC_TUNING,
        // The cloud endpoint is fleet-wide and fixed. A pasted or cached bundle can
        // never set it — the app's signup screen hands out its own http://localhost:8086,
        // and a boat that believed it would spool to loopback forever, looking healthy.
        // `sync.influxUrl` survives only as a self-hosting escape hatch: it is not in
        // the schema, so it cannot arrive by pasting, only by editing the config JSON.
        influxUrl: s.influxUrl || SAILKICK_INFLUX_URL,
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
      if (isLoopbackUrl(syncOpts.influxUrl)) {
        syncWarning = `sync: ⚠ writing to ${syncOpts.influxUrl} — telemetry is NOT reaching the cloud`
        ;(app.error || console.error)(`[sailkick-boat] sync target ${syncOpts.influxUrl} is a local address — telemetry will not reach the cloud`)
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
      const pOpts = {
        sailkickUrl: p.sailkickUrl || SAILKICK_APP_URL,
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
          influxUrl: oldHistory.influxUrl || HISTORY_TUNING.influxUrl,
          org: oldHistory.org || HISTORY_TUNING.org,
          bucket: oldHistory.bucket || HISTORY_TUNING.bucket,
          token: p.historyToken || oldHistory.token || '',
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
    try { app.setPluginStatus(parts.join('   |   ') || 'idle (both features off)') } catch {}
  }

  plugin.stop = function () {
    if (statusTimer) clearInterval(statusTimer)
    statusTimer = null
    try { if (sync) sync.stop() } catch {}
    try { if (telemetry) telemetry.stop() } catch {}
    try { if (history) history.stop() } catch {}
    try { if (proxy) proxy.stop() } catch {}
    sync = null
    telemetry = null
    history = null
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
