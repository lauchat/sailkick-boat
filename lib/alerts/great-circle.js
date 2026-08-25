'use strict'

// VENDORED from sailkick/shared/engine/wind-field.js:256 @ 8008b0e  sha256:523a9e378fcab848
// Do not edit here — fix upstream and re-vendor. ONE function copied rather than the whole
// module: wind-field.js is grid generation, and hauling it in for eight lines of haversine
// would vendor a large surface we do not use and cannot keep honest.
//
// The hash above is wind-field.js's, not this file's — it is what to re-check against.
// Converted ESM -> CommonJS ONLY. No logic changed.

// Helper for tests + UI: distance from (lat0, lon0) to (lat1, lon1) in km.
function greatCircleKm (lat0, lon0, lat1, lon1) {
  const R = 6371
  const dLat = (lat1 - lat0) * Math.PI / 180
  const dLon = (lon1 - lon0) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat0 * Math.PI / 180) * Math.cos(lat1 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

module.exports = { greatCircleKm }
