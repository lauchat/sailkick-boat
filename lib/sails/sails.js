// VENDORED from sailkick/shared/engine/sails.js @ 1571308  sha256:7965d2e3e610e9fd
// Do not edit here — fix upstream and re-vendor. ONE definition of how a sail plan is
// written down, or the same plan hashes two ways and silently splits the polar cloud
// this feature exists to unify — visible only much later, as a mysteriously noisy polar.
// test/sails.test.js replays the upstream suite against this copy to prove it matches.
//
// Converted ESM -> CommonJS ONLY (export keywords removed, module.exports appended).
// No logic changed.
//
// The boat is the ONLY writer of a sail plan: the app posts one to whichever server
// served it, and only this mirror accepts it (the cloud answers 501). That keeps
// <id>_raw a faithful mirror of the boat's own SignalK with one writer, makes the write
// offline-correct for free — sail changes happen at sea, which is exactly when the cloud
// is unreachable, and the gapless spool already solves that — and keeps an Influx write
// token out of the cloud next to the password hashes.

// Sail plan — ONE definition of how a sail plan is written down, shared by every host
// that records or reads one: the boat plugin (which publishes it onto SignalK) and the
// cloud (which displays it and will later group polar samples by it). Pure and
// dependency-free, like shared/engine/alerts.js, for the same reason: a second
// implementation that disagrees is the failure mode this file exists to prevent.
//
// THE ENCODING
//
//   "genoa:0+main:0"        full main and full genoa
//   "main:2+staysail:0"     two reefs, staysail, no headsail
//   "genoa:2+stormjib:0"    genoa furled two steps AND the storm jib set
//   "bare"                  nothing up
//
// `<id>:<reefs>` per ACTIVE sail, joined by "+", SORTED BY ID. Only sails that are
// actually set appear — "main down" is simply the main's absence, not a `down` state.
// That is what lets any combination be expressed: a cutter's genoa + staysail, a
// heavy-weather partly-furled genoa + storm jib, twin headsails poled out downwind.
// A fixed slot per station cannot say any of those, which is why there isn't one.
//
// SORTING IS THE WHOLE CONTRACT. The string is the join key the polar work will group
// by, so the same sail plan MUST produce the same bytes every time. An encoder that
// emitted insertion order would split one polar cloud into several that look unrelated
// — silently, and only visible much later as a mysteriously noisy polar. Hence
// encodePlan sorts, and the round-trip tests assert it.
//
// `bare` (rather than "") distinguishes "the crew says nothing is up" from "we have no
// sail data at all", which is null/absent. Under bare poles in a survival storm that
// distinction is real information.

// A sail id: lowercase, url-safe, and free of the encoding's own delimiters.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const STATIONS = ['main', 'head', 'flying'];
const SAIL_STATIONS = STATIONS;
const BARE = 'bare';
const MAX_REEFS = 5;
const MAX_SAILS = 12;   // a plan longer than this is a bug or an attack, not a rig

// The inventory a boat gets before anyone edits it. Deliberately over-complete: it is
// far easier to delete the sails you don't carry than to remember the ones you do.
// `reefs` is how many REDUCED steps the sail has below full — 0 means it is all-or-
// nothing (a spinnaker is up or it isn't). For a furling headsail these are furl steps.
const DEFAULT_INVENTORY = [
  { id: 'main',      name: 'Mainsail',  station: 'main',   reefs: 3 },
  { id: 'genoa',     name: 'Genoa',     station: 'head',   reefs: 2 },
  { id: 'jib',       name: 'Jib',       station: 'head',   reefs: 1 },
  { id: 'staysail',  name: 'Staysail',  station: 'head',   reefs: 0 },
  { id: 'stormjib',  name: 'Storm jib', station: 'head',   reefs: 0 },
  { id: 'trysail',   name: 'Trysail',   station: 'main',   reefs: 0 },
  { id: 'code0',     name: 'Code 0',    station: 'flying', reefs: 0 },
  { id: 'spinnaker', name: 'Spinnaker', station: 'flying', reefs: 0 },
];

// [{ id, reefs }] → the canonical string. Ignores entries with an unusable id, and
// clamps a negative/NaN reef count to 0 rather than emitting a string that won't parse:
// a UI bug must not be able to write an unreadable record into the boat's history.
function encodePlan(sails) {
  if (!Array.isArray(sails)) return BARE;
  const seen = new Map();
  for (const s of sails) {
    const id = typeof s?.id === 'string' ? s.id.trim().toLowerCase() : '';
    if (!ID_RE.test(id)) continue;
    const n = Number(s.reefs);
    seen.set(id, Number.isFinite(n) ? Math.max(0, Math.min(MAX_REEFS, Math.round(n))) : 0);
  }
  if (!seen.size) return BARE;
  return [...seen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))   // byte order, not locale
    .map(([id, reefs]) => `${id}:${reefs}`)
    .join('+');
}

// The canonical string → [{ id, reefs }], in the string's own (sorted) order.
//
// Deliberately TOLERANT: history outlives the inventory. A sail deleted from the boat's
// inventory today still appears in every plan recorded before it went, and a decoder
// that threw would take the whole screen — and later the whole polar split — down with
// it. Unparseable segments are dropped; `null`/absent/unknown input decodes to [].
function decodePlan(str) {
  if (typeof str !== 'string') return [];
  const s = str.trim();
  if (!s || s === BARE) return [];
  const out = [];
  const seen = new Set();
  for (const seg of s.split('+').slice(0, MAX_SAILS)) {
    const i = seg.indexOf(':');
    if (i < 0) continue;
    const id = seg.slice(0, i).trim().toLowerCase();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    const reefs = Number(seg.slice(i + 1).trim());
    if (!Number.isInteger(reefs) || reefs < 0 || reefs > MAX_REEFS) continue;
    seen.add(id);
    out.push({ id, reefs });
  }
  return out;
}

// True when the string is one this encoder could have produced. Used at the write door:
// the boat validates an incoming plan by round-tripping it, so nothing that would decode
// differently than it was written ever reaches SignalK.
function isCanonicalPlan(str) {
  return typeof str === 'string' && encodePlan(decodePlan(str)) === str.trim();
}

// The key polar samples will be GROUPED BY. Identity today — the plan string already is
// the key. It exists as a named seam because the polar work will want to coarsen plans
// into equivalence classes (a code 0 barely changes the upwind curve; a reef does), and
// when it does, that decision belongs here next to the encoding rather than scattered
// through the estimator.
function sailPlanKey(str) {
  return typeof str === 'string' && str.trim() ? str.trim() : null;
}

// Render a plan for a human: "2 reefs · Staysail". `inventory` supplies display names;
// a sail missing from it falls back to its id, so historical plans stay readable after
// the sail is deleted. Returns '—' for no data, 'Bare poles' for an explicit bare.
function describePlan(str, inventory = DEFAULT_INVENTORY) {
  if (typeof str !== 'string' || !str.trim()) return '—';
  if (str.trim() === BARE) return 'Bare poles';
  const byId = new Map((inventory || []).map((s) => [s.id, s]));
  const parts = decodePlan(str).map(({ id, reefs }) => {
    const name = byId.get(id)?.name || id;
    if (!reefs) return name;
    // The main is reefed; a furling headsail is furled. Same integer, different word —
    // saying "1 reef" about a genoa reads wrong to anyone who has actually sailed.
    return byId.get(id)?.station === 'main'
      ? `${reefs} reef${reefs > 1 ? 's' : ''}`
      : `${name} −${reefs}`;
  });
  return parts.length ? parts.join(' · ') : 'Bare poles';
}

// Validate one INVENTORY item (not a plan) — the profile section's write guard, in the
// shape of validateRule() in shared/engine/alerts.js. A malformed sail stores looking
// fine and then silently mislabels every polar sample recorded against it, so it is
// rejected at the door rather than tolerated.
function validateSail(s) {
  if (!s || typeof s !== 'object') return { ok: false, error: 'sail must be an object' };
  const id = typeof s.id === 'string' ? s.id.trim().toLowerCase() : '';
  if (!ID_RE.test(id)) {
    return { ok: false, error: `sail id "${s.id}" must be lowercase letters, digits or dashes (max 32) — it is written into every recorded plan` };
  }
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 40) {
    return { ok: false, error: 'sail name is required (max 40 characters)' };
  }
  if (!STATIONS.includes(s.station)) {
    return { ok: false, error: `sail station "${s.station}" must be one of ${STATIONS.join(', ')}` };
  }
  if (!Number.isInteger(s.reefs) || s.reefs < 0 || s.reefs > MAX_REEFS) {
    return { ok: false, error: `sail reefs must be a whole number between 0 and ${MAX_REEFS}` };
  }
  return { ok: true };
}

module.exports = {
  encodePlan,
  decodePlan,
  isCanonicalPlan,
  sailPlanKey,
  describePlan,
  validateSail,
  DEFAULT_INVENTORY,
  SAIL_STATIONS,
  BARE
}
