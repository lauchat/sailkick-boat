'use strict'

// The sail plan write door — the one place a sail plan enters the system.
//
// Sailkick records every instrument value but has no idea which sails are set, so the
// polar estimator averages a full-main-and-genoa curve together with a
// three-reefs-and-staysail one. Recording the plan as a time series is what will let it
// tell them apart later.
//
// THE WRITE HAPPENS HERE AND NOWHERE ELSE. The app posts a plan to whichever server
// served it, and only the boat's mirror accepts one; the cloud answers 501
// `sail-write-not-here` so a stale client gets JSON it can show a human. The reasons are
// worth restating because they are the whole design:
//
//   - <id>_raw stays a faithful mirror of the boat's own SignalK: one writer.
//   - It is offline-correct for free. Sail changes happen at sea, which is exactly when
//     the cloud is unreachable — the gapless spool already solves that, so the app needs
//     no outbox of its own.
//   - No Influx WRITE token has to live in the cloud next to the password hashes.
//
// Publishing is an ordinary SignalK delta on `sails.plan`, so everything downstream gets
// it for nothing: lib/sync spools it to the cloud bucket like any other value (string
// fields already work end to end — steering.autopilot.state proves it), the vendored
// mapper turns it into BoatState.sailPlan, and the app's sails screen renders identically
// on the boat and in the cloud.

const { isCanonicalPlan, decodePlan, describePlan, BARE } = require('./sails')

function createSails (app, options = {}) {
  const log = (m) => (app.debug ? app.debug('[sails] ' + m) : console.log('[sailkick-boat:sails]', m))
  const warn = (m) => (app.error ? app.error('[sailkick-boat:sails] ' + m) : console.error('[sailkick-boat:sails]', m))

  let last = null // { plan, at } — what we published, for the status line
  let writes = 0

  // POST /api/sails  { plan: "<canonical string>" } -> { ok, plan } | { ok:false, ... }
  function setPlan (body) {
    const plan = body && typeof body.plan === 'string' ? body.plan.trim() : null
    if (!plan) {
      return { ok: false, status: 400, code: 'bad-plan', message: 'body must be { plan: "<sail plan>" }' }
    }
    // Round-trip validation with the VENDORED encoder, so nothing that would decode
    // differently than it was written ever reaches SignalK. The sort order is the whole
    // contract — it is the key the polar work groups by — and "main:0+genoa:0" is
    // exactly the kind of string that looks right and hashes wrong.
    if (!isCanonicalPlan(plan)) {
      return {
        ok: false,
        status: 400,
        code: 'bad-plan',
        message: `"${plan}" is not a canonical sail plan. Expected <id>:<reefs> per set sail, joined by "+", sorted by id (e.g. "genoa:0+main:2"), or "${BARE}".`
      }
    }
    if (!app.handleMessage) {
      return { ok: false, status: 503, code: 'no-signalk', message: 'this plugin cannot publish to SignalK' }
    }
    const at = new Date().toISOString()
    try {
      app.handleMessage(options.pluginId || 'sailkick-boat', {
        updates: [{ timestamp: at, values: [{ path: 'sails.plan', value: plan }] }]
      })
    } catch (e) {
      warn('could not publish the sail plan: ' + e.message)
      return { ok: false, status: 500, code: 'publish-failed', message: e.message }
    }
    last = { plan, at }
    writes++
    // Worth a normal log line, not a debug one: this is crew input, and "when did we put
    // the second reef in" is a question people ask afterwards.
    log(`sails: ${describePlan(plan)}  (${plan})`)
    return { ok: true, plan, at }
  }

  function status () {
    if (!last) return 'sails: none set yet'
    return `sails: ${describePlan(last.plan)}${writes > 1 ? ` (${writes} changes)` : ''}`
  }

  // Mirrors lib/history / lib/alerts: the proxy asks before claiming, in /api/config,
  // that this host can accept a sail plan.
  function available () { return !!app.handleMessage }

  return { setPlan, status, available, _last: () => last, _decode: decodePlan }
}

module.exports = { createSails }
