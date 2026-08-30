// VENDORED from sailkick/shared/engine/angles.js @ a8c7153  sha256:6d001aa2e5a8f83b
// Do not edit here — fix upstream and re-vendor. ONE definition of compass maths, so the
// boat and the cloud answer "what was the average wind direction in this minute" the same
// way. test/history-ring.test.js exercises it through the ring.
//
// Converted ESM -> CommonJS ONLY (export keywords removed, module.exports appended).
// No logic changed.
//
// NB the upstream note on wrap180: it is deliberately duplicated here and in
// perf-live.js rather than imported, so that each stays a SINGLE-FILE vendor with its own
// pinned hash. The app fuzzes the two definitions against each other
// (tests/test-angles.mjs); the same discipline applies to this copy.

// Compass angle maths. Pure — no imports, no DOM — because shared/engine is the layer the
// boat plugin vendors (tests/test-layering.mjs enforces both).
//
// The one idea worth stating: a compass reading is a point on a CIRCLE, and almost every
// arithmetic operation you would reach for is wrong on a circle. The mean of 359° and 1° is
// 180°, the exact reciprocal. min/max across the seam are meaningless. A line drawn from
// 359° to 1° streaks the full height of a chart. Each of those has bitten this codebase.
//
// Two frames, and the whole file is about keeping them straight:
//
//   WRAPPED   — every value in [0,360). What instruments publish and what BoatState,
//               /api/history/series and the dials all use. Correct for "where is it now",
//               useless for "how did it change".
//   UNWRAPPED — a continuous frame where 359 → 1 is recorded as 359 → 361. Differences and
//               averages are ordinary arithmetic again. Correct for a series, meaningless
//               as an absolute bearing until you wrap360 it at the very end.
//
// Same doctrine the routing field already uses for longitude — work in an unwrapped frame,
// wrap only at the boundary (shared/engine/route-field.js:48, docs/ROUTING-FIELD.md:85).

const wrap360 = (d) => ((d % 360) + 360) % 360;

// Signed shortest path, (-180, 180]. NOTE: deliberately duplicated from perf-live.js:16
// rather than imported. perf-live.js is vendored into sailkick-boat as a SINGLE FILE with a
// pinned hash (see server/history/influx-provider.js:22); giving it an import would turn a
// one-file copy into a two-file vendor contract. tests/test-angles.mjs fuzzes the two
// definitions against each other, which buys the anti-drift guarantee without the coupling.
const wrap180 = (d) => { const x = wrap360(d); return x > 180 ? x - 360 : x; };

// One step of the UNBOUNDED accumulate: the nearest equivalent of `deg` to `prev`.
// `prev` is the previous UNWRAPPED value, or null/undefined to seed the chain.
//
// Unbounded is the whole point, and is what separates this from the superficially identical
// accumulators in perf-live.js:43 and mobile/main.js:352 — both of those re-wrap on every
// step (bounded), because a dial must not spin away. A series must: after a full 360° veer
// the result is legitimately start+360, and clamping it would reintroduce the jump this
// exists to remove.
const unwrapStep = (prev, deg) => (prev == null ? wrap360(deg) : prev + wrap180(deg - prev));

// Lift a wrapped compass series into the unwrapped frame, in array order.
//
// Non-finite entries pass through untouched and DO NOT reset the chain. That is not
// politeness about bad data: re-seeding after a dropout picks a fresh branch of the circle,
// so every later point silently shifts by a multiple of 360 and the trace jumps for a reason
// no one will ever track down.
function unwrapDeg(degs) {
  const out = new Array(degs.length);
  let prev = null;
  for (let i = 0; i < degs.length; i++) {
    const d = degs[i];
    if (!Number.isFinite(d)) { out[i] = d; continue; }
    prev = unwrapStep(prev, d);
    out[i] = prev;
  }
  return out;
}

// Circular mean of wrapped degrees — the honest average of a set of directions, via the
// unit-vector sum. Returns wrapped degrees, or null when there is nothing to average or the
// directions cancel exactly (opposite readings have no meaningful mean, and atan2(0,0) would
// answer 0° with false confidence).
function circularMeanDeg(degs) {
  let sx = 0, sy = 0, n = 0;
  for (const d of degs) {
    if (!Number.isFinite(d)) continue;
    const r = d * Math.PI / 180;
    sx += Math.cos(r); sy += Math.sin(r); n++;
  }
  if (!n || Math.hypot(sx, sy) < 1e-9) return null;
  return wrap360(Math.atan2(sy, sx) * 180 / Math.PI);
}

module.exports = { wrap360, wrap180, unwrapStep, unwrapDeg, circularMeanDeg }
