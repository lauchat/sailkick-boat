'use strict'

// InfluxDB annotated-CSV → line protocol, with types preserved.
//
// Ported from sailkick-sync/tools/parse-bandg.js, which has already moved this boat's
// `bandg` bucket into the dev InfluxDB — so the shape is proven on exactly this data
// rather than invented here.
//
// The whole point is the `#datatype` header. lib/history's old parser skipped every `#`
// line, which is fine for reading a couple of float columns to draw a chart and wrong
// for copying a database: without it every integer, boolean and string is rewritten as a
// float, and the copy silently differs from the original. Types come from the annotation
// when present, and are inferred only as a fallback.
//
// Tags are carried through verbatim. Timestamps are converted to nanoseconds, which is
// what makes a re-run idempotent: same (measurement, tagset, ns) overwrites rather than
// duplicating, so an interrupted backfill can always simply be run again.

// Split one CSV line, honouring quoted fields and "" escapes.
function parseCsvLine (line) {
  const out = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += c
    } else {
      if (c === '"') q = true
      else if (c === ',') { out.push(cur); cur = '' } else cur += c
    }
  }
  out.push(cur)
  return out
}

const escM = (s) => String(s).replace(/([,\s])/g, '\\$1')
const escT = (s) => String(s).replace(/([,=\s])/g, '\\$1')
const escS = (s) => '"' + String(s).replace(/(["\\])/g, '\\$1') + '"'

function toNs (t) {
  const ms = Date.parse(t)
  return Number.isNaN(ms) ? null : (BigInt(ms) * 1000000n).toString()
}

const NUM = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/

// Columns that are structural, not tags.
const NOT_A_TAG = new Set(['', 'result', 'table', '_start', '_stop', '_time', '_value', '_field', '_measurement'])

// Render one record. `valueType` is the #datatype entry for the _value column, e.g.
// 'double' | 'long' | 'unsignedLong' | 'boolean' | 'string'.
function recordToLine (rec, valueType, { selfOnly = false } = {}) {
  const m = rec._measurement
  if (!m) return null
  const v = rec._value
  if (v === '' || v == null) return null
  if (selfOnly && rec.self !== 'true') return null

  let fv
  if (valueType === 'double') fv = v
  else if (valueType === 'long') fv = v + 'i'
  else if (valueType === 'unsignedLong') fv = v + 'u'
  else if (valueType === 'boolean') fv = v
  else if (valueType === 'string') fv = escS(v)
  else if (v === 'true' || v === 'false') fv = v // no annotation → infer
  else if (NUM.test(v)) fv = v
  else fv = escS(v)

  const tags = []
  for (const k of Object.keys(rec)) {
    if (NOT_A_TAG.has(k)) continue
    const val = rec[k]
    if (val !== '' && val != null) tags.push(`${escT(k)}=${escT(val)}`)
  }
  tags.sort() // stable series key regardless of column order

  const ns = toNs(rec._time)
  if (ns == null) return null
  const field = rec._field || 'value'
  return `${escM(m)}${tags.length ? ',' + tags.join(',') : ''} ${escT(field)}=${fv} ${ns}`
}

// Convert a whole annotated-CSV document. Returns { lines, skipped }.
// A CSV response can contain several tables, each re-declaring #datatype and a header —
// a blank line resets both, exactly as the source tool does.
function csvToLineProtocol (text, opts = {}) {
  const lines = []
  let skipped = 0
  let cols = null
  let dt = null
  let valueIdx = -1

  for (const raw of String(text).split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') { cols = null; dt = null; valueIdx = -1; continue }
    if (line.startsWith('#datatype')) { dt = parseCsvLine(line); continue }
    if (line.startsWith('#')) continue // #group / #default carry nothing we need
    const f = parseCsvLine(line)
    if (cols === null) {
      cols = f
      valueIdx = cols.indexOf('_value')
      continue
    }
    const rec = {}
    cols.forEach((c, i) => { rec[c] = f[i] })
    const valueType = (dt && valueIdx >= 0) ? dt[valueIdx] : undefined
    const out = recordToLine(rec, valueType, opts)
    if (out) lines.push(out); else skipped++
  }
  return { lines, skipped }
}

module.exports = { csvToLineProtocol, recordToLine, parseCsvLine }
