'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const { csvToLineProtocol } = require('../lib/backfill/lineproto')
const { createBackfill } = require('../lib/backfill')

const app = { debug () {}, error () {} }
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-bf-')), 'backfill.json')

// ---------------------------------------------------------------------------------
// Conversion. This is where a copy silently goes wrong: lib/history's old parser threw
// away #datatype, which is harmless when drawing a chart from two float columns and
// wrong when duplicating a database — every integer and boolean would land as a float.
// ---------------------------------------------------------------------------------

const CSV = (datatype, header, ...rows) =>
  `#datatype,${datatype}\r\n,${header}\r\n` + rows.map((r) => ',' + r + '\r\n').join('')

test('conversion: field types survive the round trip', () => {
  const long = csvToLineProtocol(CSV('string,long,dateTime:RFC3339,long,string,string',
    'result,table,_time,_value,_field,_measurement',
    '_result,0,2026-07-19T10:00:00Z,42,value,engine.revolutions')).lines[0]
  assert.match(long, /value=42i /, 'long keeps its integer suffix')

  const dbl = csvToLineProtocol(CSV('string,long,dateTime:RFC3339,double,string,string',
    'result,table,_time,_value,_field,_measurement',
    '_result,0,2026-07-19T10:00:00Z,5.5,value,navigation.speedOverGround')).lines[0]
  assert.match(dbl, /value=5\.5 /, 'double stays bare')

  const bool = csvToLineProtocol(CSV('string,long,dateTime:RFC3339,boolean,string,string',
    'result,table,_time,_value,_field,_measurement',
    '_result,0,2026-07-19T10:00:00Z,true,value,electrical.switch')).lines[0]
  assert.match(bool, /value=true /, 'boolean is unquoted')

  const str = csvToLineProtocol(CSV('string,long,dateTime:RFC3339,string,string,string',
    'result,table,_time,_value,_field,_measurement',
    '_result,0,2026-07-19T10:00:00Z,motoring,value,navigation.state')).lines[0]
  assert.match(str, /value="motoring" /, 'string is quoted')

  const uns = csvToLineProtocol(CSV('string,long,dateTime:RFC3339,unsignedLong,string,string',
    'result,table,_time,_value,_field,_measurement',
    '_result,0,2026-07-19T10:00:00Z,7,value,counter')).lines[0]
  assert.match(uns, /value=7u /, 'unsignedLong keeps its suffix')
})

test('conversion: tags are carried through and escaped; structural columns are not tags', () => {
  const line = csvToLineProtocol(CSV('string,long,dateTime:RFC3339,double,string,string,string,string',
    'result,table,_time,_value,_field,_measurement,context,source',
    '_result,0,2026-07-19T10:00:00Z,5,value,navigation.speedOverGround,vessels.urn:mrn:x,n2k from bus')).lines[0]
  assert.match(line, /context=vessels\.urn:mrn:x/, 'tag preserved')
  assert.match(line, /source=n2k\\ from\\ bus/, 'spaces in a tag value are escaped')
  assert.ok(!/result=/.test(line) && !/table=/.test(line), 'result/table are structure, not tags')
  assert.match(line, / 1784455200000000000$/, 'nanosecond timestamp')
})

test('conversion: nanosecond timestamps make a re-run idempotent', () => {
  const doc = CSV('string,long,dateTime:RFC3339,double,string,string',
    'result,table,_time,_value,_field,_measurement',
    '_result,0,2026-07-19T10:00:00Z,5,value,navigation.speedOverGround')
  assert.strictEqual(csvToLineProtocol(doc).lines[0], csvToLineProtocol(doc).lines[0],
    'same input → byte-identical line, so re-writing overwrites rather than duplicating')
})

test('conversion: several tables in one response each re-declare their datatype', () => {
  const doc =
    CSV('string,long,dateTime:RFC3339,long,string,string', 'result,table,_time,_value,_field,_measurement',
      '_result,0,2026-07-19T10:00:00Z,3,value,a.count') +
    '\r\n' +
    CSV('string,long,dateTime:RFC3339,double,string,string', 'result,table,_time,_value,_field,_measurement',
      '_result,1,2026-07-19T10:00:00Z,1.25,value,b.ratio')
  const { lines } = csvToLineProtocol(doc)
  assert.strictEqual(lines.length, 2)
  assert.match(lines[0], /value=3i/, 'first table stays integer')
  assert.match(lines[1], /value=1\.25 /, 'second table is not contaminated by the first datatype')
})

test('conversion: selfOnly drops other vessels; unparseable rows are skipped not emitted', () => {
  const doc = CSV('string,long,dateTime:RFC3339,double,string,string,string',
    'result,table,_time,_value,_field,_measurement,self',
    '_result,0,2026-07-19T10:00:00Z,5,value,navigation.speedOverGround,true',
    '_result,0,2026-07-19T10:00:00Z,9,value,navigation.speedOverGround,')
  assert.strictEqual(csvToLineProtocol(doc, { selfOnly: true }).lines.length, 1)
  assert.strictEqual(csvToLineProtocol(doc).lines.length, 2, 'without the filter both are kept')

  const bad = csvToLineProtocol(CSV('string,long,dateTime:RFC3339,double,string,string',
    'result,table,_time,_value,_field,_measurement',
    '_result,0,not-a-date,5,value,x'))
  assert.strictEqual(bad.lines.length, 0)
  assert.strictEqual(bad.skipped, 1, 'counted, not silently dropped')
})

// ---------------------------------------------------------------------------------
// The walk. A fake InfluxDB standing in for both ends, so we can drive counts,
// failures and mismatches deterministically.
// ---------------------------------------------------------------------------------

// Keep the fixture's history short (a few hours) so a full walk is a handful of
// windows rather than the hundreds a real multi-week bucket would produce.
const HOURS_OF_HISTORY = 3
function fakeInflux ({ srcPointsPerWindow = 2, dstShortfall = 0, writeStatus = 204, srcFails = false } = {}) {
  const seen = { writes: 0, lines: 0, queries: 0 }
  const earliest = new Date(Date.now() - HOURS_OF_HISTORY * 3600000).toISOString()
  const srv = http.createServer((req, res) => {
    let chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      if (req.url.startsWith('/api/v2/write')) {
        seen.writes++
        const body = req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString() : raw.toString()
        seen.lines += body.trim().split('\n').filter(Boolean).length
        res.statusCode = writeStatus
        res.end(writeStatus === 204 ? undefined : '{"message":"nope"}')
        return
      }
      seen.queries++
      let flux = raw.toString()
      try { flux = JSON.parse(flux).query || flux } catch {} // queries are a JSON envelope now
      if (srcFails && flux.includes('signalk')) { res.statusCode = 500; res.end('boom'); return }
      res.setHeader('Content-Type', 'application/csv')
      if (flux.includes('schema.tagValues')) {
        res.end('#datatype,string,long,string\r\n,result,table,_value\r\n,_result,0,vessels.self-boat\r\n')
      } else if (flux.includes('min(column:"_time")')) {
        res.end(`#datatype,string,long,dateTime:RFC3339\r\n,result,table,_time\r\n,_result,0,${earliest}\r\n`)
      } else if (flux.includes('count()')) {
        // destination counts are the source count minus any configured shortfall
        const isDst = flux.includes('_raw')
        const n = Math.max(0, srcPointsPerWindow - (isDst ? dstShortfall : 0))
        res.end(`#datatype,string,long,long\r\n,result,table,_value\r\n,_result,0,${n}\r\n`)
      } else {
        const rows = []
        for (let i = 0; i < srcPointsPerWindow; i++) {
          rows.push(`_result,0,${new Date(Date.now() - i * 60000).toISOString()},${i},value,navigation.speedOverGround,true`)
        }
        res.end(CSV('string,long,dateTime:RFC3339,double,string,string,string',
          'result,table,_time,_value,_field,_measurement,self', ...rows))
      }
    })
  })
  return { srv, seen }
}

const listen = (srv) => new Promise((r) => srv.listen(0, r))
// node's fetch holds keep-alive sockets, so close() alone can leave the runner hanging.
const shut = (srv) => { try { srv.closeAllConnections() } catch {} try { srv.close() } catch {} }

async function runBackfill (fake, extra = {}) {
  await listen(fake.srv)
  const url = `http://127.0.0.1:${fake.srv.address().port}`
  const stateFile = extra.stateFile || tmpFile()
  const bf = createBackfill(app, {
    src: { url, org: 'signalk', bucket: 'signalk', token: 'R' },
    dst: { url, org: 'sailkick', bucket: 'addiction_raw', token: 'RW' },
    stateFile,
    idleMs: 0,
    backlogWaitMs: 5,
    ...extra
  })
  bf.start()
  await bf._wait()
  return { bf, stateFile, url }
}

test('walk: copies every window, verifies it, and marks it done', async () => {
  const fake = fakeInflux({ srcPointsPerWindow: 2 })
  const { bf, stateFile } = await runBackfill(fake)
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.ok(st.complete, 'run finished')
  assert.ok(Object.keys(st.done).length > 0, 'windows recorded')
  assert.ok(st.points > 0, 'points counted')
  assert.match(bf.status(), /complete/)
  assert.ok(fake.seen.lines > 0, 'line protocol actually written')
  shut(fake.srv)
})

test('walk: resumes from the manifest instead of re-uploading', async () => {
  const fake1 = fakeInflux({ srcPointsPerWindow: 1 })
  const { stateFile } = await runBackfill(fake1)
  const firstWrites = fake1.seen.writes
  shut(fake1.srv)
  assert.ok(firstWrites > 0)

  // Same manifest, fresh "process": already-complete run must do nothing at all.
  const fake2 = fakeInflux({ srcPointsPerWindow: 1 })
  const { bf } = await runBackfill(fake2, { stateFile })
  assert.strictEqual(fake2.seen.writes, 0, 'no window re-uploaded')
  assert.match(bf.status(), /complete/)
  shut(fake2.srv)
})

test('walk: a destination shortfall leaves the window for the next run', async () => {
  // Wrote N points, destination reports fewer — the 204 alone would have hidden this.
  const fake = fakeInflux({ srcPointsPerWindow: 4, dstShortfall: 2 })
  const { stateFile } = await runBackfill(fake)
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.strictEqual(Object.keys(st.done).length, 0, 'nothing marked done on a mismatch')
  shut(fake.srv)
})

test('walk: an unreachable source is never mistaken for an empty window', async () => {
  const fake = fakeInflux({ srcFails: true })
  const { bf, stateFile } = await runBackfill(fake)
  shut(fake.srv)
  // Nothing was copied, so a manifest may not exist at all — either way, no window may
  // be recorded as done. Marking one "empty" here would permanently skip real data.
  const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { done: {} }
  assert.strictEqual(Object.keys(st.done).length, 0, 'no window marked done when the source is down')
  assert.match(bf.status(), /unreachable/)
})

test('walk: a 4xx write aborts the run rather than skipping data', async () => {
  const fake = fakeInflux({ srcPointsPerWindow: 2, writeStatus: 401 })
  const { bf, stateFile } = await runBackfill(fake)
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.strictEqual(Object.keys(st.done).length, 0)
  assert.match(bf.status(), /write rejected/i)
  shut(fake.srv)
})

test('walk: stands down while live telemetry has a backlog', async () => {
  const fake = fakeInflux({ srcPointsPerWindow: 1 })
  let depth = 3
  const seenPaused = []
  await listen(fake.srv)
  const url = `http://127.0.0.1:${fake.srv.address().port}`
  const bf = createBackfill(app, {
    src: { url, org: 'signalk', bucket: 'signalk', token: 'R' },
    dst: { url, org: 'sailkick', bucket: 'addiction_raw', token: 'RW' },
    stateFile: tmpFile(),
    idleMs: 0,
    backlogWaitMs: 5,
    pending: async () => ({ count: depth, bytes: depth * 100 })
  })
  bf.start()
  const poll = setInterval(() => { if (/paused/.test(bf.status())) seenPaused.push(1) }, 3)
  setTimeout(() => { depth = 0 }, 60) // live sync catches up
  await bf._wait()
  clearInterval(poll)
  assert.ok(seenPaused.length > 0, 'reported paused while the spool was behind')
  assert.ok(fake.seen.writes > 0, 'and resumed once the backlog cleared')
  shut(fake.srv)
})

test('walk: refuses to start without the cloud read+write token', () => {
  const bf = createBackfill(app, {
    src: { url: 'http://127.0.0.1:1', org: 'o', bucket: 'b', token: 'R' },
    dst: { url: 'http://127.0.0.1:1', org: 'sailkick', bucket: 'addiction_raw', token: '' },
    stateFile: tmpFile()
  })
  assert.strictEqual(bf.start(), null)
  assert.match(bf.status(), /not configured \(cloud token\)/)
})

// Regressions found by the real-InfluxDB round trip (a fake server cannot produce them).
test('walk: the window CONTAINING the oldest point is copied, not skipped', async () => {
  // Oldest point at 21:20 must still copy the 21:00 window. Comparing the cursor against
  // the raw timestamp ends the loop one window early and loses it — silently, at exactly
  // the edge of history the backfill exists to reach.
  const H = 3600000
  const oldest = new Date(Math.floor(Date.now() / H) * H - H + 20 * 60000).toISOString()
  const windows = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let flux = Buffer.concat(chunks).toString()
      try { flux = JSON.parse(flux).query || flux } catch {} // queries are a JSON envelope now
      if (req.url.startsWith('/api/v2/write')) { res.statusCode = 204; res.end(); return }
      res.setHeader('Content-Type', 'application/csv')
      if (flux.includes('schema.tagValues')) {
        res.end('#datatype,string,long,string\r\n,result,table,_value\r\n,_result,0,vessels.self-boat\r\n')
      } else if (flux.includes('min(column:"_time")')) {
        res.end(`#datatype,string,long,dateTime:RFC3339\r\n,result,table,_time\r\n,_result,0,${oldest}\r\n`)
      } else if (flux.includes('count()')) {
        const m = flux.match(/range\(start:([^,]+),/)
        if (m && !flux.includes('_raw')) windows.push(m[1])
        res.end('#datatype,string,long,long\r\n,result,table,_value\r\n,_result,0,1\r\n')
      } else {
        res.end(CSV('string,long,dateTime:RFC3339,double,string,string',
          'result,table,_time,_value,_field,_measurement',
          `_result,0,${oldest},5,value,navigation.speedOverGround`))
      }
    })
  })
  const { bf } = await runBackfill({ srv, seen: {} })
  shut(srv)
  const floorHour = new Date(Math.floor(Date.now() / H) * H - H).toISOString()
  assert.ok(windows.includes(floorHour), `the ${floorHour} window must be walked (saw ${windows.join(', ')})`)
  assert.match(bf.status(), /complete/)
})

test('conversion: a cell that merely looks numeric is not treated as a date', () => {
  // Date.parse('0') returns the year 2000. The CSV `table` column is "0", so scanning
  // cells with a bare Date.parse set the walk floor 26 years too early.
  const { recordToLine } = require('../lib/backfill/lineproto')
  const line = recordToLine({ _measurement: 'm', _value: '1', _time: '2026-07-19T10:00:00Z', table: '0', result: '_result' }, 'double')
  assert.ok(!/table=/.test(line) && !/result=/.test(line), 'structural columns never become tags')
})

// --- the plugin must never upload another vessel's data (v0.17.1) ------------------
// Live sync guarantees <slug>_raw holds one boat by subscribing to vessels.self, and
// the cloud's history queries depend on that. The backfill is the only thing that could
// break it, so the rule is in code rather than in a config option someone can get wrong.

function contextFake ({ contexts, rows, capture }) {
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let flux = Buffer.concat(chunks).toString()
      try { flux = JSON.parse(flux).query || flux } catch {} // queries are a JSON envelope now
      if (req.url.startsWith('/api/v2/write')) {
        capture.writes.push(zlib.gunzipSync(Buffer.concat(chunks)).toString())
        res.statusCode = 204; res.end(); return
      }
      if (flux.includes('|>filter(')) capture.filters.push(flux.match(/\|>filter\([^|]*\)/)[0])
      res.setHeader('Content-Type', 'application/csv')
      if (flux.includes('schema.tagValues')) {
        res.end('#datatype,string,long,string\r\n,result,table,_value\r\n' +
          contexts.map((c) => `,_result,0,${c}\r\n`).join(''))
      } else if (flux.includes('min(column:"_time")')) {
        res.end(`#datatype,string,long,dateTime:RFC3339\r\n,result,table,_time\r\n,_result,0,${new Date(Date.now() - 2 * 3600000).toISOString()}\r\n`)
      } else if (flux.includes('count()')) {
        res.end(`#datatype,string,long,long\r\n,result,table,_value\r\n,_result,0,${rows.length}\r\n`)
      } else {
        res.end(CSV('string,long,dateTime:RFC3339,double,string,string,string,string',
          'result,table,_time,_value,_field,_measurement,context,self', ...rows))
      }
    })
  })
  return srv
}

test('a multi-context archive is filtered to this boat', async () => {
  const capture = { writes: [], filters: [] }
  const now = new Date().toISOString()
  const srv = contextFake({
    contexts: ['vessels.mine', 'vessels.urn:mrn:imo:mmsi:111', 'atons.urn:mrn:imo:mmsi:222'],
    rows: [`_result,0,${now},5,value,navigation.speedOverGround,vessels.mine,true`],
    capture
  })
  await listen(srv)
  const url = `http://127.0.0.1:${srv.address().port}`
  const bf = createBackfill(app, {
    src: { url, org: 'addiction', bucket: 'bandg', token: 'R' },
    dst: { url, org: 'sailkick', bucket: 'addiction_raw', token: 'RW' },
    selfContext: 'vessels.mine',
    stateFile: tmpFile(),
    idleMs: 0
  })
  bf.start(); await bf._wait(); shut(srv)

  const fetches = capture.filters.filter((f) => /self==|context==/.test(f))
  assert.ok(fetches.length > 0, 'a context filter was applied')
  assert.ok(fetches.every((f) => f.includes('vessels.mine')), 'scoped to this boat')
  assert.ok(!fetches.some((f) => f.includes('atons')), 'AtoNs and other vessels are not selected')
})

test('a single-context archive is copied whatever identity string it uses', async () => {
  // An import may carry a UUID from a since-reinstalled Signal K, or an MMSI URN. One
  // context means one vessel, so it cannot be an AIS collection — copy it.
  const capture = { writes: [], filters: [] }
  const now = new Date().toISOString()
  const srv = contextFake({
    contexts: ['vessels.urn:mrn:signalk:uuid:OLD-INSTALL'],
    rows: [`_result,0,${now},5,value,navigation.speedOverGround,vessels.urn:mrn:signalk:uuid:OLD-INSTALL,`],
    capture
  })
  await listen(srv)
  const url = `http://127.0.0.1:${srv.address().port}`
  const bf = createBackfill(app, {
    src: { url, org: 'addiction', bucket: 'bandg', token: 'R' },
    dst: { url, org: 'sailkick', bucket: 'addiction_raw', token: 'RW' },
    selfContext: 'vessels.urn:mrn:imo:mmsi:269118770', // today's identity — different!
    stateFile: tmpFile(),
    idleMs: 0
  })
  bf.start(); await bf._wait(); shut(srv)

  assert.ok(!capture.filters.some((f) => /context==/.test(f)), 'no filter — nothing to exclude')
  assert.ok(capture.writes.length > 0, 'the archive is still copied despite the identity mismatch')
})

test('a walk that copies nothing is NOT reported complete', async () => {
  // Wrong org/bucket, or a filter matching no rows, must not masquerade as success.
  const capture = { writes: [], filters: [] }
  const srv = contextFake({ contexts: ['vessels.mine'], rows: [], capture }) // count says 0
  await listen(srv)
  const url = `http://127.0.0.1:${srv.address().port}`
  const stateFile = tmpFile()
  const bf = createBackfill(app, {
    src: { url, org: 'sailkick', bucket: 'signalk', token: 'R' }, // the tempting defaults
    dst: { url, org: 'sailkick', bucket: 'addiction_raw', token: 'RW' },
    selfContext: 'vessels.mine',
    stateFile,
    idleMs: 0
  })
  bf.start(); await bf._wait(); shut(srv)

  assert.doesNotMatch(bf.status(), /complete/, 'must not claim success')
  assert.match(bf.status(), /0 points|check/i)
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.strictEqual(st.complete, false, 'left incomplete so it retries')
})

test('an empty source bucket is reported before walking thousands of windows', async () => {
  const capture = { writes: [], filters: [] }
  const srv = contextFake({ contexts: [], rows: [], capture }) // no contexts at all
  await listen(srv)
  const url = `http://127.0.0.1:${srv.address().port}`
  const bf = createBackfill(app, {
    src: { url, org: 'sailkick', bucket: 'signalk', token: 'R' },
    dst: { url, org: 'sailkick', bucket: 'addiction_raw', token: 'RW' },
    selfContext: 'vessels.mine',
    stateFile: tmpFile(),
    idleMs: 0
  })
  bf.start(); await bf._wait(); shut(srv)
  assert.match(bf.status(), /empty|check the names/i)
  assert.strictEqual(capture.writes.length, 0)
})

// --- scale + overlap (v0.17.2) ------------------------------------------------------
// A real archive was measured at 54M points/day — ~2.25M per hour, ~400 MB of CSV. A
// window is read whole and converted in memory, so without subdivision that exhausts a
// Raspberry Pi long before bandwidth matters.

function denseFake ({ perWindow, dstOldest, capture }) {
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let flux = Buffer.concat(chunks).toString()
      try { flux = JSON.parse(flux).query || flux } catch {} // queries are a JSON envelope now
      if (req.url.startsWith('/api/v2/write')) { res.statusCode = 204; res.end(); return }
      res.setHeader('Content-Type', 'application/csv')
      if (flux.includes('schema.tagValues')) {
        res.end('#datatype,string,long,string\r\n,result,table,_value\r\n,_result,0,vessels.mine\r\n')
      } else if (flux.includes('min(column:"_time")')) {
        // the destination probe answers with the cloud's oldest point; the source with its own
        const isDst = flux.includes('_raw')
        const v = isDst ? dstOldest : new Date(Date.now() - 4 * 3600000).toISOString()
        if (isDst && !dstOldest) { res.end('#datatype,string,long,dateTime:RFC3339\r\n,result,table,_time\r\n'); return }
        res.end(`#datatype,string,long,dateTime:RFC3339\r\n,result,table,_time\r\n,_result,0,${v}\r\n`)
      } else if (flux.includes('count()')) {
        const m = flux.match(/range\(start:([^,]+),stop:([^)]+)\)/)
        const span = m ? Date.parse(m[2]) - Date.parse(m[1]) : 3600000
        if (flux.includes('_raw')) { res.end('#datatype,string,long,long\r\n,result,table,_value\r\n,_result,0,999999\r\n'); return }
        capture.spans.push(span)
        // density is per-hour, so a smaller span holds proportionally fewer points
        const n = Math.round(perWindow * (span / 3600000))
        res.end(`#datatype,string,long,long\r\n,result,table,_value\r\n,_result,0,${n}\r\n`)
      } else {
        res.end(CSV('string,long,dateTime:RFC3339,double,string,string,string,string',
          'result,table,_time,_value,_field,_measurement,context,self',
          `_result,0,${new Date().toISOString()},5,value,navigation.speedOverGround,vessels.mine,true`))
      }
    })
  })
  return srv
}

test('a window too dense to hold in memory is subdivided', async () => {
  const capture = { spans: [] }
  const srv = denseFake({ perWindow: 2250000, dstOldest: null, capture }) // 2.25M/hour, as measured
  await listen(srv)
  const url = `http://127.0.0.1:${srv.address().port}`
  const bf = createBackfill(app, {
    src: { url, org: 'addiction', bucket: 'bandg', token: 'R' },
    dst: { url, org: 'sailkick', bucket: 'addiction_raw', token: 'RW' },
    selfContext: 'vessels.mine',
    stateFile: tmpFile(),
    maxRowsPerChunk: 100000,
    idleMs: 0
  })
  bf.start(); await bf._wait(); shut(srv)

  const smallest = Math.min(...capture.spans)
  assert.ok(smallest < 3600000, 'the hour was split')
  assert.ok(smallest >= 60000, 'but never below the one-minute floor')
  // 2.25M/hour against a 100k cap needs roughly a 32x split, i.e. ~112s slices
  assert.ok(smallest <= 300000, `slices should be minutes, not hours (got ${smallest}ms)`)
})

test('the walk starts below what live sync already covers, not at now', async () => {
  const capture = { spans: [] }
  const cloudStart = new Date(Date.now() - 2 * 3600000) // live sync began 2h ago
  const srv = denseFake({ perWindow: 10, dstOldest: cloudStart.toISOString(), capture })
  await listen(srv)
  const url = `http://127.0.0.1:${srv.address().port}`
  const bf = createBackfill(app, {
    src: { url, org: 'addiction', bucket: 'bandg', token: 'R' },
    dst: { url, org: 'sailkick', bucket: 'addiction_raw', token: 'RW' },
    selfContext: 'vessels.mine',
    stateFile: tmpFile(),
    idleMs: 0
  })
  bf.start(); await bf._wait()
  const st = bf._state()
  shut(srv)
  assert.ok(st.ceiling <= cloudStart.getTime(), 'ceiling is at or below where the cloud starts')
  assert.ok(st.ceiling > cloudStart.getTime() - 3600000 - 1, 'and not needlessly earlier')
  // every window walked must be older than the ceiling — no re-upload of live-covered data
  assert.ok(Object.keys(st.done).every((k) => Date.parse(k) <= st.ceiling),
    'no window newer than the ceiling was touched')
})

// --- field types must come from the source, not from guessing (v0.18.1) -------------
// A raw-Flux request body cannot carry a dialect, so InfluxDB returns UNANNOTATED CSV
// and types have to be inferred from the text. That is wrong in a way that breaks the
// write outright, and it stopped a real migration dead:
//   422 partial write: field type conflict: input field "value" on measurement "network…"

test('a string field stays a string even when its value looks numeric', () => {
  // The exact case: network.ip holds "8" and "1.2.3.4". Inferred, "8" is emitted bare
  // (a float) and "1.2.3.4" quoted (a string) — one field, two types, one rejected batch.
  const doc = CSV('string,long,dateTime:RFC3339,string,string,string',
    'result,table,_time,_value,_field,_measurement',
    '_result,0,2026-07-19T10:00:00Z,8,value,network.ip',
    '_result,0,2026-07-19T10:00:01Z,1.2.3.4,value,network.ip')
  const { lines } = csvToLineProtocol(doc)
  assert.strictEqual(lines.length, 2)
  assert.match(lines[0], /value="8"/, 'a numeric-looking string is still quoted')
  assert.match(lines[1], /value="1\.2\.3\.4"/)
  assert.ok(lines.every((l) => /value="/.test(l)), 'both rows declare the SAME type')
})

test('without the annotation the same input would produce two types (why we ask for it)', () => {
  const noAnnotation = ',result,table,_time,_value,_field,_measurement\r\n' +
    ',_result,0,2026-07-19T10:00:00Z,8,value,network.ip\r\n' +
    ',_result,0,2026-07-19T10:00:01Z,1.2.3.4,value,network.ip\r\n'
  const { lines } = csvToLineProtocol(noAnnotation)
  const quoted = lines.filter((l) => /value="/.test(l)).length
  assert.strictEqual(quoted, 1, 'inference splits one field across two types — the 422')
})

test('source queries request the datatype annotation', async () => {
  const bodies = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (req.url.startsWith('/api/v2/write')) { res.statusCode = 204; res.end(); return }
      bodies.push(Buffer.concat(chunks).toString())
      res.setHeader('Content-Type', 'application/csv')
      res.end('#datatype,string,long,string\r\n,result,table,_value\r\n,_result,0,vessels.mine\r\n')
    })
  })
  await listen(srv)
  const url = `http://127.0.0.1:${srv.address().port}`
  const bf = createBackfill(app, {
    src: { url, org: 'o', bucket: 'b', token: 'R' },
    dst: { url, org: 'o', bucket: 'b_raw', token: 'RW' },
    selfContext: 'vessels.mine', stateFile: tmpFile(), idleMs: 0
  })
  bf.start(); await bf._wait(); shut(srv)

  assert.ok(bodies.length > 0, 'queries were sent')
  const parsed = bodies.map((b) => { try { return JSON.parse(b) } catch { return null } })
  assert.ok(parsed.every(Boolean), 'every query is a JSON envelope, not a raw flux body')
  assert.ok(parsed.every((j) => (j.dialect || {}).annotations || [].includes),
    'and carries a dialect')
  assert.ok(parsed.every((j) => (j.dialect.annotations || []).includes('datatype')),
    'asking for datatype specifically')
})
