// VENDORED from sailkick/shared/engine/perf-live.js @ 128cf97  sha256:7ce83a1df13926f0
// Do not edit here — fix upstream and re-vendor. One definition of "the %".
//
// Converted ESM -> CommonJS ONLY (export keywords removed, module.exports appended). No logic changed: the boat and every app
// surface must produce the same number, and test/perf.test.js replays the upstream
// suite's cases against this copy to prove it.
// Live polar performance — ONE definition of "the %", shared by every surface that
// shows or will compute it: the mobile Polar screen, the desktop ribbon polar, the
// cloud server (perfPct on the telemetry stream, when it lands) and — vendored, see
// the handoff when it happens — the boat plugin. Extracted from polar-screen.js /
// instrument-polar.js, which had drifted to two copies of the same five constants.
//
// Pure: no DOM, no fetch, no Date.now() of its own (callers pass `now` so the cloud
// can replay history deterministically). The polar object comes from polar.js
// (`speed(tws, signedTwa)` abs-clamps the angle; `noGoTwa` is the first table row).

const EMA_TAU_S = 5;        // live-point smoothing time constant (s)
const TWS_AVG_SEC = 60;     // "current wind" = 1-min mean TWS
const MIN_TWS = 2;          // below this wind the % is noise…
const MIN_TARGET = 0.5;     // …and below this target it divides by ~zero

const wrap180 = (d) => { const x = ((d % 360) + 360) % 360; return x > 180 ? x - 360 : x; };

// Stateful smoother over the BoatState stream. update() ingests one sample and
// returns { raw, ema } (raw feeds trails/recorders; ema feeds the % and the dot),
// or null while wind or speed is missing — which also RESETS the EMA, so a data
// gap doesn't get smoothed across.
function createLivePerf({ emaTauS = EMA_TAU_S, twsAvgSec = TWS_AVG_SEC } = {}) {
  let ema = null, lastT = 0, usingSog = false;
  let twsHist = [];   // [{t, v}] for the windowed mean

  return {
    update(s, now) {
      if (Number.isFinite(s?.twsKt)) twsHist.push({ t: now, v: s.twsKt });
      // Prefer the boat's own TWA; derive from TWD − HDG until it's published.
      const twa = Number.isFinite(s?.twaDeg) ? s.twaDeg
        : (Number.isFinite(s?.twdDeg) && Number.isFinite(s?.headingDeg)) ? wrap180(s.twdDeg - s.headingDeg)
          : null;
      usingSog = !Number.isFinite(s?.stwKt);
      const kt = Number.isFinite(s?.stwKt) ? s.stwKt : Number.isFinite(s?.sogKt) ? s.sogKt : null;
      if (twa == null || kt == null) { ema = null; return null; }

      const dt = ema && lastT ? Math.min(30, (now - lastT) / 1000) : emaTauS;
      const a = dt / (emaTauS + dt);
      // Smooth via the SHORTEST-PATH delta (correct across the stern), then re-wrap
      // the accumulator: without the outer wrap180 a gybe (175°S → 175°P) walks the
      // EMA past 180 and the label reads "190° S" (and any side test flips wrong).
      ema = ema
        ? { twa: wrap180(ema.twa + wrap180(twa - ema.twa) * a), kt: ema.kt + (kt - ema.kt) * a }
        : { twa, kt };
      lastT = now;
      return { raw: { twa, kt }, ema };
    },
    avgTws(now) {
      const cut = now - twsAvgSec * 1000;
      twsHist = twsHist.filter((p) => p.t >= cut);
      return twsHist.length ? twsHist.reduce((s, p) => s + p.v, 0) / twsHist.length : null;
    },
    get ema() { return ema; },
    get usingSog() { return usingSog; },
  };
}

// The % itself, with its guards. Discriminated by `kind` so callers can render
// each state distinctly instead of re-deriving the guards:
//   nodata — no polar / no smoothed point / no wind average yet
//   irons  — inside the no-go wedge (a % against a 0-ish target is meaningless)
//   weak   — wind or target below the noise floor (target still reported)
//   ok     — { pct, target }
function perfPct(polar, tws, ema) {
  if (!polar || !ema || !Number.isFinite(tws)) return { kind: 'nodata' };
  const target = polar.speed(tws, ema.twa);
  if (Math.abs(ema.twa) < polar.noGoTwa) return { kind: 'irons', target };
  if (tws < MIN_TWS || target < MIN_TARGET) return { kind: 'weak', target };
  return { kind: 'ok', target, pct: Math.round((ema.kt / target) * 100) };
}

module.exports = {
  createLivePerf, perfPct, wrap180, EMA_TAU_S, TWS_AVG_SEC, MIN_TWS, MIN_TARGET
}
