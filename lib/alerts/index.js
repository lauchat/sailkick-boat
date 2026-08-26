'use strict'

// Alerts, evaluated on the boat.
//
// The point of doing it here rather than in the cloud is the case the whole feature
// exists for: the anchor drags at 3am, the phone is in airplane mode and the uplink is
// down. A cloud watcher cannot help then. This runs in the SignalK process, off the
// boat's own bus, and reaches the boat's own buzzer.
//
// The rule EVALUATOR is not written here — lib/alerts/alerts.js is vendored verbatim from
// the app (shared/engine/alerts.js), so "has this rule fired" means exactly one thing
// whether the boat noticed or the cloud did. This file is the host around it: a timer, a
// state source, rule storage, and delivery. Same split, and the same shape, as lib/perf.
//
// DELIVERY is SignalK notifications, which is what makes this worth more than our own
// screen: a notification on `notifications.navigation.anchor` is what existing chart
// apps, alarm panels and Node-RED buzzer flows already listen to. Verified against this
// boat's server (signalk-server 2.22.1, @signalk/signalk-schema): a notification value
// requires { state, method, message }; state ∈ nominal|normal|alert|warn|alarm|emergency;
// method ∈ visual|sound. Paths under notifications.* are free-form — the group schema is
// pattern-based and defines no standard anchor path — so `notifications.navigation.anchor`
// is an ecosystem CONVENTION we are choosing to join, not a schema requirement.
//
// PATHS. Only anchor-drift gets a conventional path: a boat has one anchor, so it cannot
// collide, and it is the rule other software actually reacts to. Everything else goes to
// `notifications.sailkick.<ruleId>`, which is unique by construction. The alternative —
// mapping wind rules onto notifications.environment.wind.speedTrue — puts two rules that
// a sailor would plausibly set at once ("over 30" and "under 5") on one path, where each
// transition overwrites the other's state. A shared path is a race, not a standard.
//
// CLEARING is `state: 'normal'`, not deleting the path, per the same schema.

const fs = require('fs')
const { createAlertEngine, validateRule, STALE_SEC } = require('./alerts')
const { eventToLine } = require('./relay')

// Tuning, not configuration: the hold times that decide whether an alarm is trustworthy
// live in the rules (the owner sets those); these are implementation cadence, which an
// owner has no basis to choose. Same reasoning as SYNC_TUNING in index.js.
const DEFAULTS = {
  intervalMs: 5000, // the engine's shortest meaningful hold is tens of seconds
  rulesReloadMs: 30000, // pick up an edited rule without a plugin restart
  // A SignalK timestamp more than this far from wall clock is not usable as "now": the
  // engine mixes it with the staleness clock below, and a boat whose GPS time is out by
  // an hour would otherwise look permanently stale. See the note in tick().
  maxClockSkewMs: 60000
}

// The position-source conflict this repo found — two sources publishing
// navigation.position, a median 2.3 km apart with jumps to 22.7 km — is now detected by
// the VENDORED evaluator (kind 'position-jumpy', over MAX_PLAUSIBLE_KT, three times in
// five minutes), because the cloud watcher needs the same answer. The boat-side copy that
// first found it has been deleted rather than left to drift: what remains here is saying
// it out loud, which is the host's job.
//
// Worth restating, since it is the reason any of this exists: that conflict does NOT
// false-alarm. The two sources take turns being outside the circle, a raise needs the
// condition to hold continuously, so the anchor alarm can never fire at all — silently.

const STATE_ENUM = new Set(['nominal', 'normal', 'alert', 'warn', 'alarm', 'emergency'])
const METHOD_ENUM = new Set(['visual', 'sound'])

// Default severity per kind. Dragging is the one that gets people out of a bunk, so it is
// the one that makes noise; the rest are information you act on in your own time.
const SEVERITY = {
  'anchor-drift': { state: 'alarm', method: ['visual', 'sound'] },
  'wind-above': { state: 'alert', method: ['visual'] },
  'wind-below': { state: 'alert', method: ['visual'] },
  'wind-shift': { state: 'alert', method: ['visual'] },
  'perf-below': { state: 'alert', method: ['visual'] }
}
const FALLBACK_SEVERITY = { state: 'alert', method: ['visual'] }

const ANCHOR_PATH = 'notifications.navigation.anchor'
const nsPath = (ruleId) => `notifications.sailkick.${String(ruleId).replace(/[^A-Za-z0-9_-]/g, '')}`

// What the owner reads at 3am. The value that tripped it and the limit it crossed, in the
// units the rule was written in — "62 m from a 50 m circle" is actionable, "anchor-drift
// raised" is not.
function describe (ev) {
  const r = (ev.context && ev.context.rule) || {}
  const v = ev.context && ev.context.value
  const name = r.name || null
  const body = {
    'anchor-drift': () => `anchor drag: ${v} m from the datum (limit ${r.radiusM} m)`,
    'wind-above': () => `wind ${v} kt (over ${r.twsKt} kt)`,
    'wind-below': () => `wind ${v} kt (under ${r.twsKt} kt)`,
    'wind-shift': () => `wind shifted ${v}° (over ${r.deg}° in ${Math.round((r.windowSec ?? 600) / 60)} min)`,
    'perf-below': () => `boat speed ${v}% of polar (under ${r.pct}%)`
  }[ev.kind]
  const text = body ? body() : `${ev.kind}: ${v}`
  return name ? `${name} — ${text}` : text[0].toUpperCase() + text.slice(1)
}

function createAlerts (app, options = {}) {
  const log = (m) => (app.debug ? app.debug('[alerts] ' + m) : console.log('[sailkick-boat:alerts]', m))
  // An alarm going up or coming down belongs in the server log, not behind a debug key —
  // "why did it not wake me" has to be answerable afterwards.
  const warn = (m) => (app.error ? app.error('[sailkick-boat:alerts] ' + m) : console.error('[sailkick-boat:alerts]', m))

  const cfg = { ...DEFAULTS, ...options }
  let engine = null
  let rules = []
  let rulesKey = null // JSON of the rule set, so a re-read that changed nothing is a no-op
  let timer = null
  let reloadTimer = null
  let stopped = false
  let lastTs = null // the SignalK timestamp we last fed the engine
  let stale = false
  let raisedPaths = new Map() // path -> ruleId, so stop()/rebuild can clear what we set
  let raisedCount = 0
  let skewWarned = false
  let jumpy = false // the vendored evaluator's position-source conflict verdict
  let invalid = 0
  const invalidWarned = new Set()
  let relayed = 0
  let relayWarned = false
  let jumpWarned = false

  // --- rules ------------------------------------------------------------------------
  // Rules live in the boat's own profile, beside polars and routes, and that copy is
  // deliberately NOT cloud-synced (see lib/profile/index.js). For alarms that is the
  // right way round: a rule edited from ashore must not silently change what the boat
  // alarms on mid-passage.
  function readRules () {
    let raw
    try {
      const p = JSON.parse(fs.readFileSync(cfg.profileFile, 'utf8'))
      raw = Array.isArray(p && p.alerts) ? p.alerts.filter((r) => r && r.id && r.kind) : []
    } catch { return [] }
    // Validated with the SAME function the app validates with (vendored), because a
    // malformed rule is the worst kind of failure here: the evaluator treats an unknown
    // kind or a deadband on the wrong side as inert, so the rule sits in the list looking
    // armed and never fires. Dropped and named, rather than kept and silent.
    const ok = []
    for (const r of raw) {
      const v = validateRule(r)
      if (v.ok) { ok.push(r); continue }
      if (!invalidWarned.has(r.id)) {
        invalidWarned.add(r.id)
        warn(`alert rule "${r.name || r.id}" is NOT being evaluated: ${v.error}. Fix it in the app; until then this rule is doing nothing.`)
      }
    }
    invalid = raw.length - ok.length
    return ok
  }

  function loadRules () {
    if (stopped) return
    const next = readRules()
    const key = JSON.stringify(next)
    if (key === rulesKey) return
    const first = rulesKey === null
    rulesKey = key

    // Rebuilding drops the engine's per-rule state, so anything currently raised has to
    // be taken DOWN explicitly — otherwise a fresh engine never emits the matching
    // 'cleared' and the notification sticks at alarm for ever with nothing able to clear
    // it. Alarms therefore re-arm when rules are edited: they come back after the hold
    // time if the condition still holds. That is the predictable behaviour; a stuck alarm
    // is the one that gets muted and then ignored.
    if (!first && raisedPaths.size) {
      warn(`alert rules changed while ${raisedPaths.size} alarm(s) were raised — clearing and re-evaluating them; they will sound again after their hold time if the condition still holds`)
      for (const [path] of raisedPaths) emit(path, 'normal', [], 'alert rules changed — re-evaluating')
      raisedPaths = new Map()
    }

    rules = next
    engine = createAlertEngine(rules)
    const on = rules.filter((r) => r.enabled !== false).length
    if (!first || on) log(`${on} rule(s) active${rules.length !== on ? ` (${rules.length - on} disabled)` : ''}`)
  }

  // --- delivery ---------------------------------------------------------------------
  function emit (path, state, method, message) {
    if (cfg.notifications === false || !app.handleMessage) return
    if (!STATE_ENUM.has(state)) return warn(`refusing to emit an invalid notification state "${state}"`)
    try {
      app.handleMessage(cfg.pluginId || 'sailkick-boat', {
        updates: [{
          timestamp: new Date().toISOString(),
          values: [{ path, value: { state, method: method.filter((m) => METHOD_ENUM.has(m)), message } }]
        }]
      })
    } catch (e) { warn(`could not emit ${path}: ${e.message}`) }
  }

  function pathFor (rule) {
    if (rule.kind !== 'anchor-drift') return nsPath(rule.id)
    // One anchor, one conventional path. A second anchor-drift rule would fight the first
    // for it, so it keeps its own namespaced path instead of silently overwriting.
    const owner = raisedPaths.get(ANCHOR_PATH)
    if (owner && owner !== rule.id) return nsPath(rule.id)
    return ANCHOR_PATH
  }

  // The cloud half of "you are dragging": the transition goes through lib/sync's spool as
  // one line of Influx line protocol (see relay.js for the schema and why this route).
  // Best-effort by design — an alarm that cannot be relayed must still ring on board, so
  // nothing here is allowed to throw into the tick.
  function relay (ev, state, message) {
    if (!cfg.relay) {
      if (!relayWarned) {
        relayWarned = true
        log('no telemetry sync configured — alarms ring on board but are not sent to the cloud')
      }
      return
    }
    try {
      const line = eventToLine(ev, { context: cfg.context, state, message })
      if (line && cfg.relay([line])) relayed++
    } catch (e) { warn('could not relay the alarm to the cloud: ' + e.message) }
  }

  function deliver (ev) {
    const rule = (ev.context && ev.context.rule) || {}
    const sev = SEVERITY[ev.kind] || FALLBACK_SEVERITY
    // A rule may carry its own severity — 40 kt is an alarm on some boats and a Tuesday on
    // others — but only within what the schema allows.
    // Enum filtering happens once, at the wire boundary in emit() — duplicating it here
    // would mean neither copy is pinned by a test (removing either one still passes).
    const state = STATE_ENUM.has(rule.state) ? rule.state : sev.state
    const method = Array.isArray(rule.method) ? rule.method : sev.method

    if (ev.transition === 'raised') {
      const path = pathFor({ ...rule, id: ev.ruleId, kind: ev.kind })
      raisedPaths.set(path, ev.ruleId)
      raisedCount++
      const msg = describe(ev)
      warn(`ALARM ${state}: ${msg}`)
      emit(path, state, method, msg)
      relay(ev, state, msg)
    } else {
      const path = [...raisedPaths].find(([, id]) => id === ev.ruleId)
      if (!path) return // never raised by us (a restart, or rules changed underneath)
      raisedPaths.delete(path[0])
      log(`cleared: ${describe(ev)}`)
      emit(path[0], 'normal', [], `${describe(ev)} — cleared`)
      relay(ev, 'normal', `${describe(ev)} — cleared`)
    }
  }

  // --- the tick ---------------------------------------------------------------------
  function tick () {
    if (stopped || !engine || !cfg.source || !cfg.source.getState) return
    const now = Date.now()
    const s = cfg.source.getState()

    if (s) {
      // FRESHNESS is decided by the sample's own stamp, never by the clock we hand the
      // engine. Re-feeding an unchanged sample would keep the staleness clock alive off a
      // frozen feed — precisely the condition staleness exists to report — and that is
      // exactly what happens if freshness is judged by the value passed to update(),
      // because the skew fallback below makes that value advance on its own.
      const raw = s.updatedAt ? String(s.updatedAt) : null
      const fresh = raw ? raw !== lastTs : true // untimestamped state: we cannot tell, so evaluate
      if (fresh) {
        lastTs = raw
        // The SignalK timestamp, as lib/perf does — the engine's hold times are measured
        // on whatever clock we hand it, and mixing wall clock into a replay makes it
        // non-deterministic. BUT staleness compares against wall clock (it must: when the
        // feed dies the SignalK timestamp stops moving, which is the whole signal), so the
        // two clocks have to agree. A boat whose GPS time is out by more than a minute
        // gets wall clock and one warning, rather than a permanent phantom "feed stale".
        const ts = Date.parse(s.updatedAt)
        let at = now
        if (Number.isFinite(ts)) {
          if (Math.abs(now - ts) <= cfg.maxClockSkewMs) at = ts
          else if (!skewWarned) {
            skewWarned = true
            warn(`the SignalK timestamp is ${Math.round((ts - now) / 1000)}s from this machine's clock — using the system clock for alert timing; check the boat's time source`)
          }
        }
        // The evaluator reads s.perfPct; BoatState has no such field — the polar % is
        // computed by lib/perf and read through getPerf(), the same way history/ring.js
        // samples it. Without this line perf-below rules would simply never fire.
        const state = cfg.perfSource ? { ...s, perfPct: cfg.perfSource.getPerf() } : s
        for (const ev of engine.update(state, at)) deliver(ev)
      }
    }

    // Wall clock into tick(), the sample's own stamp into update() — the two-clocks
    // contract the evaluator now states in its header. Passing the sample stamp to both
    // means a frozen feed keeps handing back the same timestamp, `now - lastSample` never
    // grows, and staleness can never fire: the feed dies exactly when the one condition
    // that would tell you is disabled. (This host had that bug; its stale test caught it.)
    for (const ev of engine.tick(now)) {
      // Feed conditions are plugin health, not navigation: they go to the status line and
      // the log, never onto the bus, where they would ring the same bell as a dragging
      // anchor.
      if (ev.kind === 'feed-stale') {
        stale = ev.transition === 'raised'
        const msg = stale
          ? `telemetry feed stale — no fresh data for ${STALE_SEC}s; alert rules are NOT being evaluated`
          : 'telemetry feed recovered'
        if (stale) warn(msg); else log(msg)
        // Relayed too: a boat that has gone quiet cannot report its own death (that is the
        // cloud's heartbeat), but a boat whose SENSORS died while its uplink lives can, and
        // afterwards "the alarm was blind from 02:10" is exactly what you want in the log.
        relay(ev, stale ? 'warn' : 'normal', msg)
      } else if (ev.kind === 'position-jumpy') {
        jumpy = ev.transition === 'raised'
        if (!jumpy) { jumpWarned = false; log('position source settled'); relay(ev, 'normal', 'position source settled'); continue }
        if (jumpWarned) continue
        jumpWarned = true
        relay(ev, 'warn', `position source conflict: ${ev.context.jumps} implausible jumps (over ${ev.context.overKt} kt) — the anchor alarm cannot be relied on`)
        warn(`position jumped implausibly ${ev.context.jumps} times (over ${ev.context.overKt} kt between fixes) — more than one source is publishing navigation.position. ` +
          'An anchor alarm CANNOT be relied on until one is pinned: the sources take turns being outside the circle, which resets the hold time, so the alarm never fires. ' +
          'Set a source priority for navigation.position in the Signal K server settings.')
      }
    }
  }

  // --- lifecycle --------------------------------------------------------------------
  function start () {
    if (!cfg.source) { log('not started — no telemetry source'); return }
    stopped = false
    loadRules()
    timer = setInterval(tick, cfg.intervalMs)
    reloadTimer = setInterval(loadRules, cfg.rulesReloadMs)
    if (timer.unref) timer.unref()
    if (reloadTimer.unref) reloadTimer.unref()
    log(`evaluating every ${Math.round(cfg.intervalMs / 1000)}s from ${cfg.profileFile}`)
  }

  function stop () {
    stopped = true
    clearInterval(timer); clearInterval(reloadTimer)
    timer = reloadTimer = null
    // Nothing will evaluate these once we are gone. Leaving an alarm latched on the bus
    // with no way to clear it teaches the owner to mute the path, which costs them the
    // next real one — so take them down and say why, loudly.
    if (raisedPaths.size) {
      warn(`stopping with ${raisedPaths.size} alarm(s) raised — clearing them because nothing will evaluate the rules while the plugin is stopped`)
      for (const [path] of raisedPaths) emit(path, 'normal', [], 'sailkick alert engine stopped — this rule is no longer being evaluated')
    }
    raisedPaths = new Map()
    engine = null; rules = []; rulesKey = null; lastTs = null; stale = false
    jumpy = false; jumpWarned = false; invalid = 0; invalidWarned.clear(); relayed = 0; relayWarned = false
  }

  // Drop anchor HERE: the boat's own current fix becomes the datum for an anchor-drift
  // rule.
  //
  // The evaluator's setAnchor is in-memory only — it does not survive a restart or a rule
  // edit, both of which happen at anchor — so the datum is written into the RULE, which is
  // the durable path, and set on the live engine so the watch is armed from this instant
  // rather than from the next rules reload.
  //
  // Doing it here rather than in the browser is not a convenience: the position the boat
  // is using to evaluate the rule is the position the datum must be measured from. A
  // browser sends whatever its last telemetry frame said, which may be seconds stale, from
  // a socket that may have dropped — and the whole point is a hook that just went down.
  function setAnchor (ruleId, lat, lon) {
    if (!engine) return false
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
    engine.setAnchor(ruleId, lat, lon)
    log(`anchor datum for "${ruleId}" set to ${lat.toFixed(5)}, ${lon.toFixed(5)}`)
    return true
  }

  // POST /api/alerts/anchor  { ruleId, lat?, lon? }
  // lat/lon optional: omitted means "where the boat is now", which is the normal case.
  async function dropAnchor ({ ruleId, lat, lon } = {}) {
    if (!engine) return { ok: false, status: 503, code: 'off', message: 'the alert engine is not running' }
    const rule = rules.find((r) => r.id === ruleId)
    if (!rule) return { ok: false, status: 404, code: 'not-found', message: `no alert rule "${ruleId}"` }
    if (rule.kind !== 'anchor-drift') {
      return { ok: false, status: 400, code: 'wrong-kind', message: `rule "${ruleId}" is a ${rule.kind} rule, not an anchor watch` }
    }
    let at = { lat, lon }
    if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) {
      const s = cfg.source && cfg.source.getState && cfg.source.getState()
      at = { lat: s && s.lat, lon: s && s.lon }
    }
    if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) {
      return { ok: false, status: 409, code: 'no-position', message: 'the boat has no position fix, so there is nothing to anchor to' }
    }
    // Durable first: if the write fails, the caller must not be told the watch is set.
    if (cfg.profile && cfg.profile.patchItem) {
      try {
        const saved = await cfg.profile.patchItem('alerts', ruleId, { anchor: { lat: at.lat, lon: at.lon } })
        if (!saved) return { ok: false, status: 404, code: 'not-found', message: `no alert rule "${ruleId}"` }
      } catch (e) {
        return { ok: false, status: 500, code: 'save-failed', message: `could not save the anchor datum: ${e.message}` }
      }
    }
    setAnchor(ruleId, at.lat, at.lon)
    warn(`anchor watch "${rule.name || ruleId}" set at ${at.lat.toFixed(5)}, ${at.lon.toFixed(5)} (radius ${rule.radiusM} m)`)
    return { ok: true, ruleId, anchor: { lat: at.lat, lon: at.lon }, radiusM: rule.radiusM }
  }

  function status () {
    if (!engine) return 'alerts: off'
    const on = rules.filter((r) => r.enabled !== false).length
    const bad = invalid ? `; ${invalid} INVALID rule(s) ignored — see the log` : ''
    // "These alarms are not leaving the boat" belongs on EVERY line, most of all while one
    // is raised — that is exactly the moment an owner would otherwise assume a phone
    // ashore had been told.
    const cloud = cfg.relay ? (relayed ? `; ${relayed} sent to the cloud` : '') : '; local only (no cloud sync)'
    if (jumpy) {
      return `alerts: position is JUMPING between sources — pin navigation.position or the anchor alarm cannot fire${cloud}`
    }
    if (stale) return `alerts: FEED STALE — ${on} rule(s) not being evaluated${cloud}`
    if (!on) return `alerts: no rules${bad}`
    const active = engine.active.filter((id) => id !== '__feed__')
    if (active.length) return `alerts: ${active.length} RAISED (${active.join(', ')}) of ${on} rule(s)${bad}${cloud}`
    return `alerts: ${on} rule(s), none raised${raisedCount ? `; ${raisedCount} since start` : ''}${bad}${cloud}`
  }

  return {
    start,
    stop,
    status,
    setAnchor,
    dropAnchor,
    // Mirrors lib/history's shape: the proxy asks this before claiming, in /api/config,
    // that these rules are evaluated on board.
    available: () => !!engine,
    active: () => (engine ? engine.active : []),
    _tick: tick,
    _loadRules: loadRules,
    _engine: () => engine,
    _raised: () => new Map(raisedPaths),
    _jumpy: () => jumpy,
    _invalid: () => invalid,
    _relayed: () => relayed
  }
}

module.exports = { createAlerts, describe, ANCHOR_PATH, nsPath, SEVERITY }
