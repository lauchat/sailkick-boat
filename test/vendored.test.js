'use strict'

// Every vendored file in this repo, checked against the app source it claims to come from.
//
// The pins are written by hand at vendoring time, and until now NOTHING verified most of
// them. That is not hypothetical: the app split its polar helpers out, `polar.js`'s
// upstream hash moved 6a3166fe17ab5806 -> a42f126ccdcfbbab, and our header sat stale for
// weeks — no test could fail, because no test read it. The one seam that WAS checked
// (signalk-map) had its own version of the problem: the check skipped when the file moved.
//
// So this walks lib/ for headers of the form
//
//     // VENDORED from sailkick/<path> @ <commit>  sha256:<16 hex>
//
// and hashes the named upstream file. It cannot tell us the copy is faithful — the ESM ->
// CommonJS conversion means the bytes differ by construction, and test/perf.test.js and
// test/alerts.test.js replay the upstream suites for that. What it tells us is that the
// file we ported FROM has not changed since, which is the thing a human forgets.
//
// Skips only when the app checkout is absent. If the checkout is there and the file named
// in a header is not, that is a MOVE and it fails — the failure mode the signalk-map seam
// hid for two releases.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const APP_REPO = process.env.SAILKICK_APP_REPO || '/workspace/sailkick'
const LIB = path.join(__dirname, '..', 'lib')
const HEADER = /VENDORED from sailkick\/(\S+?)(?::\d+)?\s+@\s+([0-9a-f]{7,})\s+sha256:([0-9a-f]{16})/

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

// Read only the leading comment block: a header must be at the top, or it is documentation
// about someone else's file rather than a claim about this one.
function pin (file) {
  const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 30).join('\n')
  const m = head.match(HEADER)
  return m ? { file, upstream: m[1], commit: m[2], hash: m[3] } : null
}

const pins = walk(LIB).map(pin).filter(Boolean)

test('vendored: every copy declares which app file and commit it came from', () => {
  // A guard list, so deleting a header is as visible as changing one. Update deliberately.
  const expected = [
    'lib/alerts/alerts.js',
    'lib/alerts/great-circle.js',
    'lib/history/angles.js',
    'lib/perf/perf-live.js',
    'lib/perf/polar.js',
    'lib/sails/sails.js',
    'lib/telemetry/signalk-map.js'
  ]
  const found = pins.map((p) => path.relative(path.join(__dirname, '..'), p.file)).sort()
  assert.deepStrictEqual(found, expected,
    'a vendored file appeared or lost its header — add it here so its pin is checked too')
})

test('vendored: each pinned hash still matches the app source', { skip: fs.existsSync(APP_REPO) ? false : 'app source not checked out' }, () => {
  const stale = []
  for (const p of pins) {
    const src = path.join(APP_REPO, p.upstream)
    assert.ok(fs.existsSync(src),
      `${path.basename(p.file)} says it came from ${p.upstream}, which does not exist in ${APP_REPO} — the app moved or renamed it. ` +
      'Re-vendor (or re-point the header) rather than letting the check lapse.')
    const actual = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 16)
    if (actual !== p.hash) stale.push(`${path.basename(p.file)}: pinned ${p.hash}, ${p.upstream} is now ${actual}`)
  }
  assert.deepStrictEqual(stale, [],
    'the app source changed since these were vendored — re-vendor and update the header, or confirm and re-pin')
})
