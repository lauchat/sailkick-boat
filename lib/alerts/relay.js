'use strict'

// Alarm transitions -> InfluxDB line protocol, so "you are dragging" can reach a phone
// ashore.
//
// WHY THIS ROUTE. The plugin already has a durable, ordered, gapless pipe to the cloud:
// lib/sync's store-and-forward spool. Putting alarms through it means they inherit every
// property that pipe was built for — an offline passage replays them in order rather than
// dropping them, a restart loses nothing, and there is no second ingest endpoint, no
// second auth path and no second failure mode to reason about at 3am. It also makes alarm
// history queryable after the fact ("when did we drag?"), which a fire-and-forget push
// never would.
//
// SCHEMA, and the reasoning, since the reader is written against it upstream:
//
//   alerts,context=vessels.<urn>,self=true,rule=<id>,kind=<kind>
//     raised=1i,transition="raised",state="alarm",message="…",value=111,name="Anchor"
//     <nanoseconds>
//
//   measurement `alerts`, NOT `notifications`. The bucket already contains
//     notifications.* rows — deltaToLines flattens every notification on the SignalK bus,
//     and this boat has 43 devices, a server version banner and a Victron battery monitor
//     publishing them. Those are a different shape (one measurement per path, field
//     "value") and a different meaning (a device's own condition). Sharing a namespace
//     with them would make both harder to query and neither authoritative.
//
//   tags: rule + kind, and NOTHING else that varies. Both are bounded and stable — a
//     handful of rules per boat, five kinds — so cardinality stays flat. `transition` and
//     `state` are deliberately FIELDS, not tags: keeping them out of the series key means
//     one series per rule, so "is this rule raised right now" is last(raised) on a single
//     series. As tags they would split each rule across two series and that question
//     becomes a merge-and-compare-timestamps query, which is easy to get subtly wrong and
//     wrong in the direction of "no alarm".
//
//   context + self mirror what every other row in this bucket carries, so the cloud's
//     existing self-filtering applies unchanged.
//
//   fields:
//     raised      1i / 0i — the machine-readable state; last(raised)==1 is "raised now"
//     transition  "raised" / "cleared" — redundant with the above, but a raw query reads
//                 as English, and the redundancy costs nothing at this row count
//     state       the SignalK severity actually emitted (alarm | alert | emergency | …),
//                 so delivery can decide whether this is worth waking someone for
//     message     exactly the text put on the boat's own bus, so the phone ashore and the
//                 plotter at the chart table say the same words
//     value       the tripping value — metres dragged, knots, degrees, % — so it can be
//                 charted rather than only read
//     name        the owner's name for the rule, since ids are opaque
//
// Feed conditions ride the same measurement with rule=__feed__ (the id the evaluator
// itself uses) and kind=feed-stale | position-jumpy. They are not navigational alarms, but
// "your anchor watch has been unreliable since 02:10" is exactly the kind of thing you
// want to find in the log afterwards — and unlike the cloud's boat-silent heartbeat, only
// the boat can tell you WHY it went quiet.

const { toNs, escapeTag, escapeStringField } = require('../sync/lineprotocol')

const MEASUREMENT = 'alerts'

// One event -> one line. Returns null for anything malformed rather than shipping a line
// InfluxDB will reject: a rejected batch is quarantined, and quarantining an alarm is
// worse than not recording it.
function eventToLine (ev, opts = {}) {
  if (!ev || !ev.ruleId || !ev.transition) return null
  const ns = toNs(ev.at != null ? ev.at : Date.now())
  if (ns == null) return null

  const rule = (ev.context && ev.context.rule) || {}
  const ctx = escapeTag(opts.context || 'vessels.self')
  const tags = [
    `context=${ctx}`,
    `self=${opts.self === false ? 'false' : 'true'}`,
    `rule=${escapeTag(ev.ruleId)}`,
    `kind=${escapeTag(ev.kind || 'unknown')}`
  ].join(',')

  const raised = ev.transition === 'raised'
  const fields = [
    `raised=${raised ? '1i' : '0i'}`,
    `transition=${escapeStringField(ev.transition)}`
  ]
  if (opts.state) fields.push(`state=${escapeStringField(opts.state)}`)
  if (opts.message) fields.push(`message=${escapeStringField(opts.message)}`)
  const v = ev.context && ev.context.value
  if (Number.isFinite(v)) fields.push(`value=${v}`)
  // Feed conditions carry their own count instead of a value.
  const jumps = ev.context && ev.context.jumps
  if (Number.isFinite(jumps)) fields.push(`jumps=${jumps}i`)
  if (rule.name) fields.push(`name=${escapeStringField(rule.name)}`)

  return `${MEASUREMENT},${tags} ${fields.join(',')} ${ns}`
}

module.exports = { eventToLine, MEASUREMENT }
