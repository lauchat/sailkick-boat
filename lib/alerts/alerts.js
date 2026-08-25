// VENDORED from sailkick/shared/engine/alerts.js @ 8008b0e  sha256:8fc64f239560082e
// Do not edit here — fix upstream and re-vendor. ONE definition of "has this rule fired",
// or an alarm means one thing on the boat and another in the cloud. test/alerts.test.js
// replays the upstream suite (tests/test-alerts.mjs) against this copy to prove it.
//
// Converted ESM -> CommonJS ONLY (imports rewritten to require, export keywords removed,
// module.exports appended). No logic changed.
//
// The two upstream imports:
//   wrap180        <- shared/engine/perf-live.js, which this repo already vendors
//                     (lib/perf/perf-live.js @ sha256:7ce83a1df13926f0)
//   greatCircleKm  <- shared/engine/wind-field.js:256, copied alone into ./great-circle.js
//                     rather than vendoring a grid-generation module for one haversine.

// Alert engine — ONE definition of "has this rule fired", shared by every host that will
// evaluate it: the boat plugin (vendored, so anchor drag alarms with no internet) and the
// cloud watcher (so you hear about it from ashore). Same evaluator both sides, or a rule
// means two different things depending on who noticed — the drift shared/engine/perf-live.js
// was extracted to kill.
//
// Pure, and deliberately narrow: rules in, state TRANSITIONS out. No timers, no delivery,
// no notion of a buzzer or a push token, and no Date.now() of its own — the caller passes
// `now`, so a host can replay recorded history through it and get the same answers. That
// is also what makes the hard parts below testable.
//
// See docs/DESIGN-alerts.md.
//
//   const engine = createAlertEngine(rules);
//   const events = engine.update(boatState, nowMs);   // [] most ticks
//
// Each event: { ruleId, kind, transition: 'raised'|'cleared', at, reason, context }

const { wrap180 } = require('../perf/perf-live')
const { greatCircleKm } = require('./great-circle')

// Absent telemetry is `undefined` on the boat and `null` in the cloud — neither is a
// number, and a rule that treats either as 0 fires the moment a sensor is missing.
const num = (v) => (Number.isFinite(v) ? v : null);

const DEFAULT_FOR_SEC = 30;      // a condition must hold this long before raising
const DEFAULT_CLEAR_SEC = 30;    // …and fail this long before clearing
const STALE_SEC = 120;           // no fresh state for this long ⇒ the feed is stale
const M_PER_KM = 1000;

// ---- rule kinds -------------------------------------------------------------
// Each returns { active, value } — `active` is "the raw condition is true RIGHT NOW",
// before any hold/deadband smoothing. `null` means "cannot tell" (missing input), which
// is NOT the same as false and must never clear a raised alarm.

const KINDS = {
  // { kind:'wind-above', twsKt:25, clearKt?:22 }
  'wind-above': (r, s) => {
    const v = num(s.twsKt);
    if (v == null) return null;
    return { active: v >= r.twsKt, clearActive: v >= (r.clearKt ?? r.twsKt), value: v };
  },
  'wind-below': (r, s) => {
    const v = num(s.twsKt);
    if (v == null) return null;
    return { active: v <= r.twsKt, clearActive: v <= (r.clearKt ?? r.twsKt), value: v };
  },
  // { kind:'perf-below', pct:80 } — the channel the boat now computes.
  'perf-below': (r, s) => {
    const v = num(s.perfPct);
    if (v == null) return null;
    return { active: v <= r.pct, clearActive: v <= (r.clearPct ?? r.pct), value: v };
  },
};

// ---- the engine -------------------------------------------------------------

function createAlertEngine(rules = []) {
  // Per-rule state. `raised` is the only thing a host ultimately cares about; the rest
  // exists to stop it flapping.
  const st = new Map();
  const stateOf = (id) => {
    if (!st.has(id)) st.set(id, { raised: false, since: null, failingSince: null, hist: [], anchor: null, lastSeen: null });
    return st.get(id);
  };
  let staleRaised = false, lastState = null;

  // Wind shift is a CHANGE over a window, so it needs its own history rather than an
  // instantaneous test. Compared shortest-path: a veer 350°→010° is 20°, not 340°.
  function windShift(r, s, now, k) {
    const d = num(s.twdDeg);
    if (d == null) return null;
    const win = (r.windowSec ?? 600) * 1000;
    k.hist.push({ t: now, d });
    while (k.hist.length && k.hist[0].t < now - win) k.hist.shift();
    // Largest excursion from the OLDEST sample in the window — a slow steady veer and a
    // sudden shift both matter, and comparing only first-vs-last would miss a shift that
    // partly recovered within it.
    let worst = 0;
    for (const p of k.hist) {
      const delta = Math.abs(wrap180(d - p.d));
      if (delta > worst) worst = delta;
    }
    // Not enough history yet to make a claim — "cannot tell", not "false".
    if (k.hist.length < 2 || now - k.hist[0].t < Math.min(win, (r.forSec ?? DEFAULT_FOR_SEC) * 1000)) return null;
    return { active: worst >= r.deg, clearActive: worst >= (r.clearDeg ?? r.deg), value: Math.round(worst) };
  }

  // Anchor drift. The anchor is EXPLICIT (r.anchor = {lat, lon}) because inferring where
  // the hook went down is the kind of cleverness that fails silently at 3am. A boat at
  // anchor swings and a stationary GPS wanders tens of metres, so the raise still rides
  // the hold time like every other rule.
  function anchorDrift(r, s, k) {
    const lat = num(s.lat), lon = num(s.lon);
    const a = r.anchor || k.anchor;
    if (lat == null || lon == null || !a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return null;
    const m = greatCircleKm(a.lat, a.lon, lat, lon) * M_PER_KM;
    return { active: m >= r.radiusM, clearActive: m >= (r.clearRadiusM ?? r.radiusM * 0.8), value: Math.round(m) };
  }

  function evaluate(r, s, now, k) {
    if (r.kind === 'wind-shift') return windShift(r, s, now, k);
    if (r.kind === 'anchor-drift') return anchorDrift(r, s, k);
    const fn = KINDS[r.kind];
    return fn ? fn(r, s) : null;
  }

  return {
    // One tick. Returns the transitions that happened THIS tick (usually none).
    update(s, now) {
      const events = [];
      if (!s || typeof s !== 'object') return events;
      lastState = now;

      for (const r of rules) {
        if (r.enabled === false) continue;
        const k = stateOf(r.id);
        const res = evaluate(r, s, now, k);

        // "Cannot tell" — a missing sensor or too little history. Hold whatever state the
        // rule is in. Critically this does NOT clear a raised alarm: the input going away
        // is not evidence the danger did.
        if (res == null) { k.since = null; k.failingSince = null; continue; }
        k.lastSeen = now;

        const forMs = (r.forSec ?? DEFAULT_FOR_SEC) * 1000;
        const clearMs = (r.clearSec ?? DEFAULT_CLEAR_SEC) * 1000;

        if (!k.raised) {
          // Rising edge: the condition must hold for forSec. Wind hovering on a threshold
          // otherwise fires every tick, and an alarm people learn to ignore has stopped
          // being an alarm.
          if (res.active) {
            k.since ??= now;
            if (now - k.since >= forMs) {
              k.raised = true; k.since = null; k.failingSince = null;
              events.push({ ruleId: r.id, kind: r.kind, transition: 'raised', at: now,
                reason: r.name || r.kind, context: { value: res.value, rule: r } });
            }
          } else k.since = null;
        } else {
          // Falling edge rides a DEADBAND (clearKt / clearDeg / clearRadiusM), so the
          // clear threshold is deliberately not the raise threshold.
          if (!res.clearActive) {
            k.failingSince ??= now;
            if (now - k.failingSince >= clearMs) {
              k.raised = false; k.failingSince = null; k.since = null;
              events.push({ ruleId: r.id, kind: r.kind, transition: 'cleared', at: now,
                reason: r.name || r.kind, context: { value: res.value, rule: r } });
            }
          } else k.failingSince = null;
        }
      }
      return events;
    },

    // Staleness is its own condition, not a rule outcome: the feed dying is worth knowing
    // in itself, and it must never be confused with a rule clearing. Hosts call this on
    // their own tick so it fires even when no state is arriving at all.
    tick(now) {
      if (lastState == null) return [];
      const stale = now - lastState >= STALE_SEC * 1000;
      if (stale === staleRaised) return [];
      staleRaised = stale;
      return [{ ruleId: '__feed__', kind: 'feed-stale', transition: stale ? 'raised' : 'cleared',
        at: now, reason: 'telemetry feed', context: { lastStateAt: lastState } }];
    },

    // Current state, for a status line or an API — not the transition stream.
    get active() {
      const out = [];
      for (const r of rules) if (st.get(r.id)?.raised) out.push(r.id);
      if (staleRaised) out.push('__feed__');
      return out;
    },
    isRaised: (id) => !!st.get(id)?.raised,
    // Drop-anchor: set the datum for an anchor-drift rule without editing the rule.
    setAnchor(ruleId, lat, lon) { stateOf(ruleId).anchor = { lat, lon }; },
  };
}

module.exports = { createAlertEngine, DEFAULT_FOR_SEC, DEFAULT_CLEAR_SEC, STALE_SEC }
