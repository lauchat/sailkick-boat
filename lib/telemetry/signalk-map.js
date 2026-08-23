// VENDORED from sailkick/public/engine/signalk-map.js @ dc57057  sha256:3e42369c002b7cb7
// Do not edit here — fix upstream and re-vendor. One SignalK -> BoatState mapping, or
// the boat and the app quietly disagree (it has drifted twice; both times silently).
//
// Converted ESM -> CommonJS ONLY. No logic changed.
//
// Re-vendored after b519a9f (course + depth precedence) and 348c3d9 (heading true
// authoritative) — both of which came from findings handed over from this repo.

// SignalK → BoatState mapping — pure, dependency-free, so it's shared by both
// the client provider (public/ui/boat-panel.js, browser WebSocket) and the
// server-side SignalKSource (server/telemetry/signalk.js, ws). No imports.
// SignalK emits SI units (m/s, radians); BoatState uses knots + degrees.

const MS_TO_KT = 1.94384;
const RAD2DEG = 180 / Math.PI;
const wrap360 = (d) => ((d % 360) + 360) % 360;
const wrap180 = (d) => { const w = wrap360(d); return w > 180 ? w - 360 : w; };

// Active-waypoint course data. SignalK publishes it under three prefixes
// depending on server version/config (v1 courseGreatCircle/courseRhumbline,
// v2 course.calcValues) — all carry the same SI values (rad, m, m/s, s). A boat
// commonly publishes SEVERAL of them in the same delta; great-circle is PRIMARY
// and the others only fill a field it left empty (mirrors the primary/fallback
// ordering in server/history/influx-provider.js). Group 1 = source prefix,
// group 2 = value suffix.
const COURSE_RE = /^navigation\.(courseGreatCircle\.nextPoint|courseRhumbline\.nextPoint|course\.calcValues)\.(bearingTrue|distance|velocityMadeGood|timeToGo)$/;
const COURSE_FIELD = { bearingTrue: 'wptBrgDeg', distance: 'wptDistNm', velocityMadeGood: 'wptVmgKt', timeToGo: 'wptTtgSec' };

// A SignalK delta `values` array → a partial BoatState patch. Skips
// null / missing / non-finite values (SignalK sends null when a sensor is absent).
function signalkValuesToPatch(values) {
  const patch = {};
  if (!Array.isArray(values)) return patch;
  const courseRank = {};   // wpt field → rank of the source that set it (great-circle 2, fallback 1)
  let depthRank = 0;       // rank of the depth source that set patch.depthM (belowSurface 2, transducer 1)
  for (const v of values) {
    if (!v || !v.path) continue;
    // Course paths first: unlike sensors, a null here MEANS something — the
    // destination was cleared — so propagate it instead of skipping, or the
    // ribbon would show stale waypoint numbers forever.
    const course = v.path.match(COURSE_RE);
    if (course) {
      const [, src, suffix] = course;
      // Great-circle wins; rhumbline / calcValues only fill a field it left empty
      // this delta. Without this, a boat publishing several course prefixes would
      // last-writer-win and flip-flop the waypoint readouts between the two solves.
      const rank = src === 'courseGreatCircle.nextPoint' ? 2 : 1;
      if ((courseRank[COURSE_FIELD[suffix]] || 0) > rank) continue;   // a stronger source already set it
      courseRank[COURSE_FIELD[suffix]] = rank;
      if (suffix === 'bearingTrue') patch.wptBrgDeg = Number.isFinite(v.value) ? wrap360(v.value * RAD2DEG) : null;
      else if (suffix === 'distance') patch.wptDistNm = Number.isFinite(v.value) ? Math.max(0, v.value / 1852) : null;
      else if (suffix === 'velocityMadeGood') patch.wptVmgKt = Number.isFinite(v.value) ? v.value * MS_TO_KT : null;
      else patch.wptTtgSec = Number.isFinite(v.value) && v.value >= 0 ? v.value : null;
      continue;
    }
    if (v.value == null) continue;
    switch (v.path) {
      case 'navigation.position': {
        const { latitude, longitude } = v.value || {};
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          patch.lat = latitude;
          patch.lon = longitude;
        }
        break;
      }
      case 'navigation.speedOverGround':
        if (Number.isFinite(v.value)) patch.sogKt = Math.max(0, v.value * MS_TO_KT);
        break;
      case 'navigation.speedThroughWater':
        if (Number.isFinite(v.value)) patch.stwKt = Math.max(0, v.value * MS_TO_KT);
        break;
      case 'navigation.courseOverGroundTrue':
        if (Number.isFinite(v.value)) patch.cogDeg = wrap360(v.value * RAD2DEG);
        break;
      // Heading: emit the RAW components (deg). Resolution happens in
      // resolveHeadingDeg() against the ACCUMULATED state, so a heading-only
      // message still uses the last-known variation instead of flip-flopping
      // between true-heading and raw-magnetic.
      case 'navigation.headingTrue':
        if (Number.isFinite(v.value)) patch.hdgTrueDeg = wrap360(v.value * RAD2DEG);
        break;
      case 'navigation.headingMagnetic':
        if (Number.isFinite(v.value)) patch.hdgMagDeg = v.value * RAD2DEG;   // wrapped after variation
        break;
      case 'navigation.magneticVariation':
        // Skip a 0 sentinel (a common "no-data" value): applying 0 is a no-op
        // anyway, and retaining the last real variation avoids a heading
        // flip-flop when the source intermittently reports 0.
        if (Number.isFinite(v.value) && v.value !== 0) patch.magVarDeg = v.value * RAD2DEG;  // east positive
        break;
      case 'environment.wind.speedApparent':
        if (Number.isFinite(v.value)) patch.awsKt = Math.max(0, v.value * MS_TO_KT);
        break;
      case 'environment.wind.angleApparent':
        if (Number.isFinite(v.value)) patch.awaDeg = wrap180(v.value * RAD2DEG);
        break;
      case 'environment.wind.speedTrue':
        if (Number.isFinite(v.value)) patch.twsKt = Math.max(0, v.value * MS_TO_KT);
        break;
      case 'environment.wind.directionTrue':   // absolute compass direction (not off-bow)
        if (Number.isFinite(v.value)) patch.twdDeg = wrap360(v.value * RAD2DEG);
        break;
      case 'environment.wind.angleTrueWater':  // true wind ANGLE off the bow, port negative
        if (Number.isFinite(v.value)) patch.twaDeg = wrap180(v.value * RAD2DEG);
        break;
      case 'performance.velocityMadeGood':     // signed: negative = losing ground to windward
        if (Number.isFinite(v.value)) patch.vmgKt = v.value * MS_TO_KT;
        break;
      case 'environment.depth.belowSurface':      // primary: actual water depth (transducer offset applied)
      case 'environment.depth.belowTransducer': { // fallback: raw sounder reading (offset not applied)
        // belowSurface is authoritative; the transducer reading only fills in when
        // belowSurface is absent. Without the rank guard, a boat publishing both
        // would last-writer-win and jump by the transducer offset.
        const rank = v.path === 'environment.depth.belowSurface' ? 2 : 1;
        if (rank >= depthRank && Number.isFinite(v.value)) { patch.depthM = v.value; depthRank = rank; }
        break;
      }
      // (active-waypoint course paths are handled above via COURSE_RE — all three
      //  publish prefixes, with nulls propagated so a cleared goto clears the values)
      case 'environment.water.temperature':       // sea temperature, K → °C
        if (Number.isFinite(v.value)) patch.seaTempC = v.value - 273.15;
        break;
      case 'environment.outside.temperature':     // air temperature, K → °C
        if (Number.isFinite(v.value)) patch.airTempC = v.value - 273.15;
        break;
      case 'propulsion.port.revolutions':         // engine speed, Hz → rpm
        if (Number.isFinite(v.value)) patch.rpmPort = Math.max(0, v.value * 60);
        break;
      case 'propulsion.starboard.revolutions':
        if (Number.isFinite(v.value)) patch.rpmStbd = Math.max(0, v.value * 60);
        break;
      case 'steering.rudderAngle':
        if (Number.isFinite(v.value)) patch.rudderDeg = v.value * RAD2DEG;
        break;
      case 'navigation.rateOfTurn':
        if (Number.isFinite(v.value)) patch.rotDegMin = v.value * RAD2DEG * 60;
        break;
      case 'navigation.attitude':                 // object { roll, pitch, yaw } (rad)
        if (Number.isFinite(v.value?.roll)) patch.heelDeg = v.value.roll * RAD2DEG;
        break;
      case 'steering.autopilot.state':
        if (typeof v.value === 'string') patch.apState = v.value;
        break;
      case 'steering.autopilot.target.headingTrue':
        if (Number.isFinite(v.value)) patch.apTargetDeg = wrap360(v.value * RAD2DEG);
        break;
      case 'steering.autopilot.target.windAngleApparent':
        if (Number.isFinite(v.value)) patch.apTargetAwa = wrap180(v.value * RAD2DEG);
        break;
      case 'navigation.datetime':                 // GNSS UTC time (from the satellites)
        if (typeof v.value === 'string') patch.gpsTime = v.value;
        break;
      default:
        break; // ignore everything else
    }
  }
  return patch;
}

// Resolve the boat's true heading (deg) from accumulated components: prefer
// navigation.headingTrue; else navigation.headingMagnetic + the last-known
// magneticVariation. Because the raw components live in the accumulated state
// (not resolved per-message), a message carrying only headingMagnetic still
// gets the retained variation applied — no jumping. Returns undefined if no
// heading is known yet.
function resolveHeadingDeg(state) {
  if (!state) return undefined;
  // TRUE heading is authoritative. Raw magnetic heading (no variation applied) is
  // dangerously wrong for sailing — off by the local declination, tens of degrees
  // in places — so navigation.headingTrue wins. Only when it is absent do we DERIVE
  // true from the magnetic compass + last-known variation; that still yields TRUE
  // (never raw magnetic), so the fallback is safe, not a magnetic readout.
  // (This boat once published a frozen headingTrue stuck at 151° while truly ~293°,
  // which is why magnetic was temporarily preferred; verified 2026-08-20 that its
  // NMEA.31 headingTrue is live at ~1 Hz, tracks the full 0–359° span, and agrees
  // with magnetic+variation to ~1° — so true is primary again.)
  if (Number.isFinite(state.hdgTrueDeg)) return state.hdgTrueDeg;
  if (Number.isFinite(state.hdgMagDeg)) {
    return wrap360(state.hdgMagDeg + (Number.isFinite(state.magVarDeg) ? state.magVarDeg : 0));
  }
  return undefined;
}

// Build the delta-stream URL from a base host/URL. Accepts a bare base
// (`ws://host:3000`) and appends the self stream path; passes a full
// `…/signalk/…` URL through untouched. Adds `&token=` only if a token is set.
function streamUrl(base, token) {
  let url = String(base || '').trim().replace(/\/+$/, '');
  if (!/\/signalk\//.test(url)) url += '/signalk/v1/stream?subscribe=self';
  if (token) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  return url;
}

module.exports = { signalkValuesToPatch, resolveHeadingDeg, MS_TO_KT }
