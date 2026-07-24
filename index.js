'use strict'

const { createSync } = require('./lib/sync')
const { createProxy } = require('./lib/proxy')
const { createTelemetry } = require('./lib/telemetry')
const { createHistory } = require('./lib/history')
const { resolveAccountConfig, accountConfigured } = require('./lib/account')

// sailkick-boat: one Signal K plugin, two independently-toggleable modules —
//   sync : gapless store-and-forward of self telemetry to InfluxDB (data OUT)
//   proxy: offline-first caching mirror of the sailkick host (data IN)
// Kept as separate modules so a proxy fault can't wedge the data-critical sync.

module.exports = function (app) {
  let sync = null
  let proxy = null
  let telemetry = null
  let history = null
  let statusTimer = null
  let accountStatus = null

  const plugin = {
    id: 'sailkick-boat',
    name: 'Sailkick boat companion',
    description:
      'Boat-side sailkick: gapless telemetry sync to InfluxDB + an offline-first ' +
      'caching mirror of the sailkick host. Each feature can be toggled on/off.'
  }

  plugin.schema = {
    type: 'object',
    properties: {
      account: {
        type: 'object',
        title: 'Sailkick account (auto-configure)',
        description: 'Log in with your sailkick account and the plugin fetches its cloud config (write token, bucket, org, InfluxDB URL) automatically — no manual token entry. Leave blank to configure sync/mirror manually below. The last-good config is cached, so sync keeps working offline.',
        properties: {
          sailkickUrl: { type: 'string', title: 'Sailkick host URL', description: 'e.g. https://app.sailkick.com — used for login and as the mirror upstream.' },
          slug: { type: 'string', title: 'Boat slug (username)' },
          password: { type: 'string', title: 'Password' }
        }
      },
      sync: {
        type: 'object',
        title: 'Telemetry sync → InfluxDB',
        properties: {
          enabled: { type: 'boolean', title: 'Enable telemetry sync', default: true },
          influxUrl: { type: 'string', title: 'InfluxDB URL' },
          org: { type: 'string', title: 'Organization', default: 'sailkick' },
          bucket: { type: 'string', title: 'Bucket (your <slug>_raw)' },
          token: { type: 'string', title: 'Write token (scoped to your bucket)' },
          spoolDir: { type: 'string', title: 'Buffer directory', description: 'Default: plugin data dir. Put on the SSD.' },
          batchSize: { type: 'number', title: 'Batch size (points/file)', default: 1000 },
          flushIntervalMs: { type: 'number', title: 'Flush interval (ms)', default: 1000 },
          maxBufferBytes: { type: 'number', title: 'Max on-disk buffer (bytes)', default: 524288000 },
          subscribePeriodMs: { type: 'number', title: 'Min interval per path (ms)', default: 1000 },
          requestTimeoutMs: { type: 'number', title: 'Upload timeout (ms)', default: 30000 },
          retryMinMs: { type: 'number', title: 'Retry backoff min (ms)', default: 1000 },
          retryMaxMs: { type: 'number', title: 'Retry backoff max (ms)', default: 60000 }
        }
      },
      proxy: {
        type: 'object',
        title: 'Sailkick caching proxy',
        properties: {
          enabled: { type: 'boolean', title: 'Enable caching proxy', default: true },
          serveTelemetry: { type: 'boolean', title: 'Serve /ws/telemetry from local SignalK', description: 'Provide the app\'s telemetry bus from the boat\'s SignalK, so the app uses the same contract as the cloud server.', default: true },
          openAccess: { type: 'boolean', title: 'No login on the boat', description: 'Serve /api/config with the cloud login disabled, so the boat\'s own app opens without a password (single-tenant, offline-first). Turn off to keep the cloud login gate.', default: true },
          sailkickUrl: { type: 'string', title: 'Sailkick host URL', description: 'The one upstream this boat mirrors (usually set automatically from the account section). e.g. https://app.sailkick.com' },
          proxyPort: { type: 'number', title: 'Mirror server port', description: 'Standalone HTTP server serving the mirror at origin root (no SignalK auth). With host networking it is directly on the Pi. 0 = disable.', default: 8080 },
          localSignalkUrl: { type: 'string', title: 'Local SignalK URL (live telemetry)', description: 'Live data + WebSocket stream are proxied here (not cached, not mirrored).', default: 'http://127.0.0.1:3000' },
          localPaths: { type: 'array', title: 'Paths served by LOCAL SignalK', description: 'Prefixes routed to local SignalK instead of the mirror.', items: { type: 'string' }, default: ['/signalk'] },
          storeDir: { type: 'string', title: 'Cache directory', description: 'Default: plugin data dir. Put on the SSD.' },
          requestTimeoutMs: { type: 'number', title: 'Fetch timeout (ms)', default: 20000 },
          manifest: {
            type: 'object',
            title: 'Auto-refresh on new bakes (cache manifest)',
            description: 'Poll the cloud\'s bake manifest so tiles/app refresh lazily when a dataset is re-baked. Tiles are otherwise pinned (never expire by time).',
            properties: {
              enabled: { type: 'boolean', title: 'Poll the cache manifest', default: true },
              path: { type: 'string', title: 'Manifest path on the sailkick host', default: '/api/cache-manifest' },
              pollIntervalSec: { type: 'number', title: 'Poll interval (s)', default: 300 }
            }
          },
          history: {
            type: 'object',
            title: 'Local history (app Trends panel + track)',
            description: 'Serve the app\'s /api/history endpoints locally so trends + track work offline. With a read token → full history from a local InfluxDB. Without one → a DB-less ~1h ring sampled from live telemetry (e.g. SignalK on a Victron GX with no InfluxDB).',
            properties: {
              enabled: { type: 'boolean', title: 'Serve /api/history locally', default: true },
              influxUrl: { type: 'string', title: 'Local InfluxDB URL', default: 'http://127.0.0.1:8086' },
              org: { type: 'string', title: 'Organization', default: 'signalk' },
              bucket: { type: 'string', title: 'Bucket', default: 'bandg' },
              token: { type: 'string', title: 'Read token (scoped to the bucket)', description: 'Set to serve full history from a local InfluxDB. Leave blank to use the DB-less live-telemetry ring (Victron GX / no InfluxDB).' },
              requestTimeoutMs: { type: 'number', title: 'Query timeout (ms)', default: 15000 },
              ringPersist: { type: 'boolean', title: 'Persist the DB-less ring across restarts', description: 'Append-log in the plugin data dir. Off = in-memory only (lost on restart). Ignored when a token is set (InfluxDB is used).', default: true },
              ringWindowSec: { type: 'number', title: 'DB-less ring window (s)', description: 'How much history the ring keeps: 86400 = 24h (default), up to 2592000 = 30d for long passages. Resolution auto-coarsens for large windows. NB: the app currently caps history requests at 24h.', default: 86400 },
              ringSampleSec: { type: 'number', title: 'DB-less ring sample interval (s)', description: 'Auto-raised for large windows so the ring stays bounded (~50k samples).', default: 15 },
              ringDir: { type: 'string', title: 'Ring log directory (override)', description: 'Where the persistent ring log lives. Default: a "history" folder under the cache directory (storeDir), so it sits on the SSD/USB with the tiles. Set to override.' }
            }
          },
          seed: {
            type: 'object',
            title: 'Offline base seed (global coastline + seabed)',
            description: 'On start, cache a worldwide low-zoom base so a usable map exists offline everywhere. Idempotent; self-throttles when offline. Enable the "Coastline"/depth layers in the app to see it.',
            properties: {
              enabled: { type: 'boolean', title: 'Seed the global base on start', default: true },
              coastlineMaxZoom: { type: 'number', title: 'Coastline max zoom', description: 'Sparse vector coastline z0..N (z8 ≈ 12k tiles).', default: 8 },
              seabedMaxZoom: { type: 'number', title: 'Seabed (bathy) max zoom', description: 'Dense depth raster z0..N (z6 ≈ 5.5k tiles).', default: 6 },
              concurrency: { type: 'number', title: 'Parallel fetches', default: 4 }
            }
          },
          prefetch: {
            type: 'object',
            title: 'Offline area download (around the boat)',
            description: 'On save, cache the detailed chart layers for a radius around the boat\'s current position (from local SignalK), so a passage area is fully offline. Progress shows in the status line above.',
            properties: {
              radiusNm: {
                type: 'number',
                title: 'Radius around boat',
                enum: [0, 25, 50, 100, 200],
                enumNames: ['Off', '25 nm', '50 nm', '100 nm', '200 nm'],
                default: 0
              },
              detailZoom: {
                type: 'number',
                title: 'Detail level',
                enum: [12, 13, 14, 15],
                enumNames: ['Overview (z12)', 'Coastal (z13)', 'Detailed (z14)', 'Harbor (z15)'],
                default: 13
              },
              concurrency: { type: 'number', title: 'Parallel fetches', default: 4 }
            }
          }
        }
      }
    }
  }

  plugin.start = function (options) {
    const opts = options || {}
    // If a sailkick account is configured, fetch the cloud config first (write token,
    // bucket, org, InfluxDB URL) and merge it in — then start the modules. Otherwise
    // start immediately with the manually-entered config (unchanged behaviour).
    ;(async () => {
      if (accountConfigured(opts.account)) {
        const r = await resolveAccountConfig(app, opts.account)
        if (r.bundle) {
          opts.sync = { ...(opts.sync || {}), influxUrl: r.bundle.influxUrl, org: r.bundle.org, bucket: r.bundle.bucket, token: r.bundle.writeToken }
          opts.proxy = { ...(opts.proxy || {}), sailkickUrl: opts.account.sailkickUrl }
          accountStatus = `account: ${opts.account.slug} (${r.source})`
        } else {
          accountStatus = `account: ${opts.account.slug} — no config (${r.error || 'not reachable, no cache'})`
        }
      }
      startModules(opts)
    })().catch((e) => (app.error || console.error)('[sailkick-boat] start failed: ' + e.message))
  }

  function startModules (opts) {
    // --- sync module (isolated: its failure must not affect the proxy) ---
    if (opts.sync && opts.sync.enabled !== false && opts.sync.influxUrl) {
      try { sync = createSync(app, opts.sync); sync.start() } catch (e) {
        (app.error || console.error)('[sailkick-boat] sync start failed: ' + e.message)
        sync = null
      }
    }

    // --- proxy module (+ /ws/telemetry provider and /api/history from local sources) ---
    if (!opts.proxy || opts.proxy.enabled !== false) {
      const pOpts = { ...(opts.proxy || {}) }
      if (pOpts.serveTelemetry !== false) {
        try {
          telemetry = createTelemetry(app, {})
          telemetry.start()
          pOpts.telemetryUpgrade = (req, s, h) => telemetry.handleUpgrade(req, s, h)
        } catch (e) {
          (app.error || console.error)('[sailkick-boat] telemetry start failed: ' + e.message)
          telemetry = null
        }
      }
      if (!pOpts.history || pOpts.history.enabled !== false) {
        try {
          // ringSource = the telemetry module: when no local InfluxDB is configured
          // (e.g. a Victron GX), history serves a DB-less ring from live telemetry.
          // storeDir lets the persistent ring log default onto the SSD with the tiles.
          history = createHistory(app, { ...(pOpts.history || {}), ringSource: telemetry, storeDir: pOpts.storeDir })
          history.start()
          pOpts.history = history // proxy dispatches /api/history to it when available()
        } catch (e) {
          (app.error || console.error)('[sailkick-boat] history start failed: ' + e.message)
          history = null
        }
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
