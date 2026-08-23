'use strict'

// Drift detector for the highest-risk contract seam in the system.
//
// lib/telemetry/signalk-map.js is a hand-ported copy of the app's
// public/engine/signalk-map.js. It has now drifted TWICE without anyone noticing:
//   - v0.14.6: nine cases (STW, measured true wind, attitude, rudder, autopilot)
//   - v0.18.6: the active-waypoint course block + TWA, VMG, sea/air temp, engine rpm
// Both times the data was sitting on the boat's SignalK bus and the plugin threw it
// away, so the app looked broken only when connected to the boat — the hardest place
// to debug and the only place that matters offshore.
//
// The server now publishes the content hash of its copy at /health:
//     { contracts: { signalkMap: "2015ae986cd8" } }
// We can't compare byte-for-byte — our copy is CommonJS and theirs is an ES module —
// so we pin the hash of the app file we last ported FROM. If the app changes that
// file, the published hash stops matching the pin and we say so, loudly, in the
// Signal K log. It cannot tell us WHAT changed; it tells us to go and look, which is
// exactly what was missing both times.
//
// Updating this pin is part of re-porting signalk-map.js — never on its own:
//     sha256sum <sailkick>/public/engine/signalk-map.js | cut -c1-12

// sha256(app public/engine/signalk-map.js)[0..12] as ported in v0.18.6
const { request } = require('../net') // owned connection pool + real error codes

const PINNED_APP_HASH = '3e42369c002b'

function createContractCheck (app, options = {}) {
  const warn = (m) => (app.error ? app.error('[sailkick-boat:contract] ' + m) : console.error('[sailkick-boat:contract]', m))
  const log = (m) => (app.debug ? app.debug('[contract] ' + m) : console.log('[sailkick-boat:contract]', m))
  const timeoutMs = options.timeoutMs || 15000
  let drifted = null // null = unknown (never reached the server, or it predates /health.contracts)
  let announced = null // last state we logged, so a 5-minute poll doesn't spam the log

  // Best-effort: a boat is offline most of the time, and older servers don't publish
  // `contracts` at all. Neither is an error — both just leave the state unknown.
  async function check (upstream) {
    if (!upstream) return drifted
    let remote
    try {
      const r = await request(String(upstream).replace(/\/+$/, '') + '/health', { timeoutMs })
      if (!r.ok) return drifted
      const body = await r.json()
      remote = body && body.contracts && body.contracts.signalkMap
    } catch { return drifted } // offline → keep whatever we last knew
    if (!remote) return drifted // server predates the contract hash

    drifted = remote !== PINNED_APP_HASH
    if (drifted !== announced) {
      announced = drifted
      if (drifted) {
        warn(`signalk-map contract DRIFT: the server runs ${remote}, this plugin was ported from ${PINNED_APP_HASH}. ` +
          'The app may show blank instrument or waypoint values when connected to this boat. ' +
          're-port lib/telemetry/signalk-map.js from the app and update the pin.')
      } else {
        log(`signalk-map contract in sync (${remote})`)
      }
    }
    return drifted
  }

  // Only worth a status line when something is wrong; "in sync" is the boring case.
  function status () { return drifted ? 'contract: signalk-map DRIFTED from the server — see log' : null }

  return { check, status, _state: () => drifted, PINNED_APP_HASH }
}

module.exports = { createContractCheck, PINNED_APP_HASH }
