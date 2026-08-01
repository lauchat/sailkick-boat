'use strict'

// SignalK -> BoatState mapping. Ported VERBATIM from the sailkick app
// (public/engine/signalk-map.js) so the plugin's /ws/telemetry is identical to
// the server's SignalKSource. SignalK emits SI units (m/s, radians); BoatState
// uses knots + degrees. Keep in sync with the app copy.

const MS_TO_KT = 1.94384
const RAD2DEG = 180 / Math.PI
const wrap360 = (d) => ((d % 360) + 360) % 360
const wrap180 = (d) => { const w = wrap360(d); return w > 180 ? w - 360 : w }

function signalkValuesToPatch (values) {
  const patch = {}
  if (!Array.isArray(values)) return patch
  for (const v of values) {
    if (!v || v.value == null) continue
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
      case 'environment.depth.belowSurface':
      case 'environment.depth.belowTransducer':
        if (Number.isFinite(v.value)) patch.depthM = v.value
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
