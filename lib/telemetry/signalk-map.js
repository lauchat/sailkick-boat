'use strict'

// SignalK -> BoatState mapping. Ported VERBATIM from the sailkick app
// (public/engine/signalk-map.js) so the plugin's /ws/telemetry is identical to
// the server's SignalKSource. SignalK emits SI units (m/s, radians); BoatState
// uses knots + degrees. Keep in sync with the app copy.

const MS_TO_KT = 1.94384
const RAD2DEG = 180 / Math.PI
const wrap360 = (d) => ((d % 360) + 360) % 360
const wrap180 = (d) => { const w = wrap360(d); return w > 180 ? w - 360 : w }

// Active-waypoint course data. SignalK publishes it under three prefixes
// depending on server version/config (v1 courseGreatCircle/courseRhumbline,
// v2 course.calcValues) — all carry the same SI values (rad, m, m/s, s).
const COURSE_RE = /^navigation\.(?:course(?:GreatCircle|Rhumbline)\.nextPoint|course\.calcValues)\.(bearingTrue|distance|velocityMadeGood|timeToGo)$/

function signalkValuesToPatch (values) {
  const patch = {}
  if (!Array.isArray(values)) return patch
  for (const v of values) {
    if (!v || !v.path) continue
    // Course paths first: unlike sensors, a null here MEANS something — the
    // destination was cleared — so propagate it instead of skipping, or the
    // ribbon would show stale waypoint numbers forever.
    const course = v.path.match(COURSE_RE)
    if (course) {
      const suffix = course[1]
      if (suffix === 'bearingTrue') patch.wptBrgDeg = Number.isFinite(v.value) ? wrap360(v.value * RAD2DEG) : null
      else if (suffix === 'distance') patch.wptDistNm = Number.isFinite(v.value) ? Math.max(0, v.value / 1852) : null
      else if (suffix === 'velocityMadeGood') patch.wptVmgKt = Number.isFinite(v.value) ? v.value * MS_TO_KT : null
      else patch.wptTtgSec = Number.isFinite(v.value) && v.value >= 0 ? v.value : null
      continue
    }
    if (v.value == null) continue
    switch (v.path) {
      case 'navigation.position': {
        const { latitude, longitude } = v.value || {}
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          patch.lat = latitude
          patch.lon = longitude
        }
        break
      }
      case 'navigation.speedOverGround':
        if (Number.isFinite(v.value)) patch.sogKt = Math.max(0, v.value * MS_TO_KT)
        break
      case 'navigation.speedThroughWater':
        if (Number.isFinite(v.value)) patch.stwKt = Math.max(0, v.value * MS_TO_KT)
        break
      case 'navigation.courseOverGroundTrue':
        if (Number.isFinite(v.value)) patch.cogDeg = wrap360(v.value * RAD2DEG)
        break
      case 'navigation.headingTrue':
        if (Number.isFinite(v.value)) patch.hdgTrueDeg = wrap360(v.value * RAD2DEG)
        break
      case 'navigation.headingMagnetic':
        if (Number.isFinite(v.value)) patch.hdgMagDeg = v.value * RAD2DEG
        break
      case 'navigation.magneticVariation':
        if (Number.isFinite(v.value) && v.value !== 0) patch.magVarDeg = v.value * RAD2DEG
        break
      case 'environment.wind.speedApparent':
        if (Number.isFinite(v.value)) patch.awsKt = Math.max(0, v.value * MS_TO_KT)
        break
      case 'environment.wind.angleApparent':
        if (Number.isFinite(v.value)) patch.awaDeg = wrap180(v.value * RAD2DEG)
        break
      case 'environment.wind.speedTrue':
        if (Number.isFinite(v.value)) patch.twsKt = Math.max(0, v.value * MS_TO_KT)
        break
      case 'environment.wind.directionTrue': // absolute compass direction (not off-bow)
        if (Number.isFinite(v.value)) patch.twdDeg = wrap360(v.value * RAD2DEG)
        break
      case 'environment.wind.angleTrueWater': // true wind ANGLE off the bow, port negative
        if (Number.isFinite(v.value)) patch.twaDeg = wrap180(v.value * RAD2DEG)
        break
      case 'performance.velocityMadeGood': // signed: negative = losing ground to windward
        if (Number.isFinite(v.value)) patch.vmgKt = v.value * MS_TO_KT
        break
      case 'environment.depth.belowSurface':
      case 'environment.depth.belowTransducer':
        if (Number.isFinite(v.value)) patch.depthM = v.value
        break
      // (active-waypoint course paths are handled above via COURSE_RE — all three
      //  publish prefixes, with nulls propagated so a cleared goto clears the values)
      case 'environment.water.temperature': // sea temperature, K → °C
        if (Number.isFinite(v.value)) patch.seaTempC = v.value - 273.15
        break
      case 'environment.outside.temperature': // air temperature, K → °C
        if (Number.isFinite(v.value)) patch.airTempC = v.value - 273.15
        break
      case 'propulsion.port.revolutions': // engine speed, Hz → rpm
        if (Number.isFinite(v.value)) patch.rpmPort = Math.max(0, v.value * 60)
        break
      case 'propulsion.starboard.revolutions':
        if (Number.isFinite(v.value)) patch.rpmStbd = Math.max(0, v.value * 60)
        break
      case 'steering.rudderAngle':
        if (Number.isFinite(v.value)) patch.rudderDeg = v.value * RAD2DEG
        break
      case 'navigation.rateOfTurn':
        if (Number.isFinite(v.value)) patch.rotDegMin = v.value * RAD2DEG * 60
        break
      case 'navigation.attitude': // object { roll, pitch, yaw } (rad)
        if (v.value && Number.isFinite(v.value.roll)) patch.heelDeg = v.value.roll * RAD2DEG
        break
      case 'steering.autopilot.state':
        if (typeof v.value === 'string') patch.apState = v.value
        break
      case 'steering.autopilot.target.headingTrue':
        if (Number.isFinite(v.value)) patch.apTargetDeg = wrap360(v.value * RAD2DEG)
        break
      case 'steering.autopilot.target.windAngleApparent':
        if (Number.isFinite(v.value)) patch.apTargetAwa = wrap180(v.value * RAD2DEG)
        break
      case 'navigation.datetime':
        if (typeof v.value === 'string') patch.gpsTime = v.value
        break
      default:
        break
    }
  }
  return patch
}

function resolveHeadingDeg (state) {
  if (!state) return undefined
  if (Number.isFinite(state.hdgMagDeg)) {
    return wrap360(state.hdgMagDeg + (Number.isFinite(state.magVarDeg) ? state.magVarDeg : 0))
  }
  if (Number.isFinite(state.hdgTrueDeg)) return state.hdgTrueDeg
  return undefined
}

module.exports = { signalkValuesToPatch, resolveHeadingDeg, MS_TO_KT }
