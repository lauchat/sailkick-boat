'use strict'

const { createSync } = require('./lib/sync')
const { createProxy } = require('./lib/proxy')
const { createTelemetry } = require('./lib/telemetry')
const { createHistory } = require('./lib/history')

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
          sailkickUrl: { type: 'string', title: 'Sailkick host URL', description: 'The one upstream this boat mirrors, e.g. http://192.168.5.222:3000' },
          proxyPort: { type: 'number', title: 'Mirror server port', description: 'Standalone HTTP server serving the mirror at origin root (no SignalK auth). With host networking it is directly on the Pi. 0 = disable.', default: 8080 },
          localSignalkUrl: { type: 'string', title: 'Local SignalK URL (live telemetry)', description: 'Live data + WebSocket stream are proxied here (not cached, not mirrored).', default: 'http://127.0.0.1:3000' },
          localPaths: { type: 'array', title: 'Paths served by LOCAL SignalK', description: 'Prefixes routed to local SignalK instead of the mirror.', items: { type: 'string' }, default: ['/signalk'] },
          storeDir: { type: 'string', title: 'Cache directory', description: 'Default: plugin data dir. Put on the SSD.' },
          requestTimeoutMs: { type: 'number', title: 'Fetch timeout (ms)', default: 20000 },
          history: {
            type: 'object',
            title: 'Local history (app Trends panel + track)',
            description: 'Serve the app\'s /api/history endpoints from the boat\'s local InfluxDB so trends + track work offline. Falls through to the cloud mirror when not configured.',
            properties: {
              enabled: { type: 'boolean', title: 'Serve /api/history from local InfluxDB', default: true },
              influxUrl: { type: 'string', title: 'Local InfluxDB URL', default: 'http://127.0.0.1:8086' },
              org: { type: 'string', title: 'Organization', default: 'addiction' },
              bucket: { type: 'string', title: 'Bucket', default: 'bandg' },
              token: { type: 'string', title: 'Read token (scoped to the bucket)', description: 'Required to enable local history. Without it, /api/history falls through to the mirror.' },
              requestTimeoutMs: { type: 'number', title: 'Query timeout (ms)', default: 15000 }
            }
          }
        }
      }
    }
  }

  plugin.start = function (options) {
    const opts = options || {}

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
          history = createHistory(app, pOpts.history || {})
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
  }

  return plugin
}
