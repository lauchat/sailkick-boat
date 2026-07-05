'use strict'

// Convert Signal K deltas to InfluxDB line protocol, matching the schema written
// by the community `signalk-to-influxdb-v2` plugin — so this plugin's output
// unifies seamlessly with data already collected under that schema.
//
//   measurement = Signal K path            e.g. navigation.speedOverGround
//   field       = "value"                  the scalar reading
//   tags        = context, self, source    context = "vessels.<urn>", self = "true"
//
// Value handling:
//   number / boolean / string -> measurement=path, field value
//   navigation.position (object w/ lat+lon) -> SPECIAL CASE: fields lat, lon (+altitude)
//   any other object -> flattened RECURSIVELY into dotted measurements,
//       e.g. navigation.attitude {roll,pitch} -> navigation.attitude.roll,
//            navigation.attitude.pitch  (each field "value")
//
// (The upstream schema also tags position with an s2_cell_id; we intentionally
// omit it — it needs an S2 library and adds cardinality. lat/lon are identical,
// so position queries still line up; only that one extra tag is absent on our
// rows. Add later if geo-binning is needed.)
//
// Timestamps use nanosecond precision, so writes are idempotent on
// (measurement, tagset, timestamp): replaying after a reconnect never dupes.

function escapeMeasurement (s) {
  return String(s).replace(/([,\s])/g, '\\$1')
}

function escapeTag (s) {
  return String(s).replace(/([,=\s])/g, '\\$1')
}

function escapeStringField (s) {
  return '"' + String(s).replace(/(["\\])/g, '\\$1') + '"'
}

// ms (number) or ISO string / Date -> nanosecond string, or null if unparseable.
function toNs (ts) {
  let ms
  if (typeof ts === 'number') ms = ts
  else if (ts instanceof Date) ms = ts.getTime()
  else {
    const p = Date.parse(ts)
    ms = Number.isNaN(p) ? null : p
  }
  if (ms == null) return null
  return (BigInt(Math.round(ms)) * 1000000n).toString()
}

function line (measurement, fieldset, tags, ns) {
  const m = escapeMeasurement(measurement)
  return ns != null ? `${m},${tags} ${fieldset} ${ns}` : `${m},${tags} ${fieldset}`
}

// Emit line(s) for one path/value, recursing into objects. Appends to `lines`.
function emit (path, value, tags, ns, lines) {
  if (value == null) return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) lines.push(line(path, `value=${value}`, tags, ns))
    return
  }
  if (typeof value === 'boolean') {
    lines.push(line(path, `value=${value ? 'true' : 'false'}`, tags, ns))
    return
  }
  if (typeof value === 'string') {
    if (value.length) lines.push(line(path, `value=${escapeStringField(value)}`, tags, ns))
    return
  }
  if (Array.isArray(value)) return // arrays are not stored
  if (typeof value === 'object') {
    // navigation.position and similar: store as lat/lon (+altitude) fields.
    if (Number.isFinite(value.latitude) && Number.isFinite(value.longitude)) {
      let f = `lat=${value.latitude},lon=${value.longitude}`
      if (Number.isFinite(value.altitude)) f += `,altitude=${value.altitude}`
      lines.push(line(path, f, tags, ns))
      return
    }
    // any other object: flatten recursively into dotted measurements.
    for (const [k, v] of Object.entries(value)) emit(`${path}.${k}`, v, tags, ns, lines)
    return
  }
}

// delta -> array of line-protocol strings.
// opts.context = fallback self context ("vessels.<urn>") when delta.context absent.
function deltaToLines (delta, opts) {
  const lines = []
  if (!delta || !Array.isArray(delta.updates)) return lines
  const ctx = escapeTag(delta.context || (opts && opts.context) || 'vessels.self')

  for (const update of delta.updates) {
    if (!update || !Array.isArray(update.values)) continue
    const source = escapeTag(update.$source || sourceLabel(update.source) || 'unknown')
    const ns = toNs(update.timestamp != null ? update.timestamp : Date.now())
    const tags = `context=${ctx},self=true,source=${source}`
    for (const pv of update.values) {
      if (!pv || !pv.path) continue // skip vessel-level '' path objects
      emit(pv.path, pv.value, tags, ns, lines)
    }
  }
  return lines
}

function sourceLabel (source) {
  if (!source) return null
  if (typeof source === 'string') return source
  return [source.label, source.type, source.src, source.talker]
    .filter(Boolean)
    .join('.') || null
}

module.exports = {
  deltaToLines,
  emit,
  toNs,
  escapeMeasurement,
  escapeTag,
  escapeStringField
}
