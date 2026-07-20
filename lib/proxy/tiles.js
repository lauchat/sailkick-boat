'use strict'

// Slippy-map (XYZ / Web-Mercator) tile math. Pure, dependency-free — shared by the
// global-base seeder and the region-prefetch handler. Matches the app's tile scheme
// (public/viewer/coastline-overlay.js): top-left origin, latitude clamped to the
// Web-Mercator limit.

const MAX_LAT = 85.05112878

// (lat,lon,z) -> [x,y] tile indices, clamped into [0, 2^z-1].
function deg2tile (lat, lon, z) {
  const n = 2 ** z
  const clat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
  const latR = clat * Math.PI / 180
  let x = Math.floor((lon + 180) / 360 * n)
  let y = Math.floor((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2 * n)
  const clamp = (v) => Math.max(0, Math.min(n - 1, v))
  return [clamp(x), clamp(y)]
}

// bbox [w,s,e,n] -> inclusive tile range at zoom z. North maps to the smaller y
// (top), west to the smaller x. Antimeridian-crossing bboxes (w > e) are not split
// here — callers pass single-hemisphere passage boxes.
function bboxTileRange (bbox, z) {
  const [w, s, e, n] = bbox
  const [xw, yn] = deg2tile(n, w, z) // north-west
  const [xe, ys] = deg2tile(s, e, z) // south-east
  return { x0: Math.min(xw, xe), x1: Math.max(xw, xe), y0: Math.min(yn, ys), y1: Math.max(yn, ys) }
}

// Total tiles a bbox covers across [minZoom, maxZoom] inclusive (for the estimate/cap).
function countBboxTiles (bbox, minZoom, maxZoom) {
  let total = 0
  for (let z = minZoom; z <= maxZoom; z++) {
    const { x0, x1, y0, y1 } = bboxTileRange(bbox, z)
    total += (x1 - x0 + 1) * (y1 - y0 + 1)
  }
  return total
}

// Yield every "z/x/y" for a bbox across [minZoom, maxZoom] (generator — no big array).
function * bboxTiles (bbox, minZoom, maxZoom) {
  for (let z = minZoom; z <= maxZoom; z++) {
    const { x0, x1, y0, y1 } = bboxTileRange(bbox, z)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) yield { z, x, y }
    }
  }
}

// Bounding box [w,s,e,n] of `radiusNm` nautical miles around a point. 1 nm ≈ 1/60°
// of latitude; longitude degrees shrink with cos(lat) (clamped near the poles).
function boxAround (lat, lon, radiusNm) {
  const dLat = radiusNm / 60
  const dLon = radiusNm / 60 / Math.max(0.05, Math.cos(lat * Math.PI / 180))
  return [
    Math.max(-180, lon - dLon), Math.max(-85, lat - dLat),
    Math.min(180, lon + dLon), Math.min(85, lat + dLat)
  ]
}

module.exports = { deg2tile, bboxTileRange, countBboxTiles, bboxTiles, boxAround, MAX_LAT }
