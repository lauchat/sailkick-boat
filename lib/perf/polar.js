// VENDORED from sailkick/shared/engine/polar.js @ 128cf97  sha256:6a3166fe17ab5806
// Do not edit here — fix upstream and re-vendor. One definition of "the %".
//
// Converted ESM -> CommonJS ONLY (only the pure Polar class is taken — the getActivePolar/loadPolar store layer is app-side (fetch + localStorage) and has no meaning on the boat). No logic changed: the boat and every app
// surface must produce the same number, and test/perf.test.js replays the upstream
// suite's cases against this copy to prove it.
// The boat resolves the ACTIVE polar from its own profile mirror instead — see index.js.

class Polar {
  constructor({ id, name, twaRows, twsCols, speeds }) {
    this.id = id;
    this.name = name;
    this.twaRows = twaRows;
    this.twsCols = twsCols;
    this.speeds = speeds;
    this.noGoTwa = twaRows[0];
    this._maxSpeed = null;
  }

  // Boat speed in knots at wind speed `twsKn` and signed wind angle
  // `twaDegSigned`. Polar is port/starboard-symmetric — take |twa|.
  // Below noGoTwa → 0. Bilinear interpolation in (TWA, TWS), clamped at the
  // table's TOP edge. Below the FIRST column the table is anchored to a virtual
  // (0 wind → 0 boat speed) column: target = speed(col0, twa) × tws/col0.
  // (The old behaviour linearly EXTRAPOLATED down the low-end gradient — a flat
  // calm still "targeted" 1–2 kn, some tables went NEGATIVE upwind, and the
  // perf% blew up as the target fell through the noise guard.)
  speed(twsKn, twaDegSigned) {
    const twa = Math.min(180, Math.abs(twaDegSigned));
    if (twa < this.noGoTwa) return 0;
    const { twaRows, twsCols, speeds } = this;
    const col0 = twsCols[0];
    if (twsKn < col0) return this.speed(col0, twa) * Math.max(0, twsKn) / col0;
    const tws = Math.min(twsCols[twsCols.length - 1], twsKn);

    let i = 0;
    while (i < twaRows.length - 2 && twaRows[i + 1] < twa) i++;
    const i1 = i + 1;
    let j = 0;
    while (j < twsCols.length - 2 && twsCols[j + 1] < tws) j++;
    const j1 = j + 1;

    const ta = (twa - twaRows[i]) / (twaRows[i1] - twaRows[i]);
    const tb = (tws - twsCols[j]) / (twsCols[j1] - twsCols[j]);

    const s00 = speeds[i][j];
    const s01 = speeds[i][j1];
    const s10 = speeds[i1][j];
    const s11 = speeds[i1][j1];

    const s0 = s00 * (1 - tb) + s01 * tb;
    const s1 = s10 * (1 - tb) + s11 * tb;
    return s0 * (1 - ta) + s1 * ta;
  }

  // Peak boat speed across the whole table — used to size the wind grid
  // (we want it big enough to contain 24 h of travel at max polar speed).
  maxSpeed() {
    if (this._maxSpeed != null) return this._maxSpeed;
    let max = 0;
    for (const row of this.speeds) for (const s of row) if (s > max) max = s;
    this._maxSpeed = max;
    return max;
  }

  // A bound `speed` function, convenient for passing into the isochrone.
  speedFn() {
    return (tws, twa) => this.speed(tws, twa);
  }

  // ---- parsing -----------------------------------------------------

  static fromCSV(id, text) {
    let name = null;
    const twaRows = [];
    const twsCols = [];
    const speeds = [];
    let seenHeader = false;

    for (let rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#')) {
        const m = line.match(/^#\s*(.+?)\s*$/);
        if (m && !name) {
          // Strip trailing empty CSV cells that spreadsheet exports
          // sometimes leave on the comment line ("Outremer 5X ,,,,,").
          name = m[1].replace(/[\s,]+$/, '');
        }
        continue;
      }
      const cells = line.split(',').map(s => s.trim());
      // Skip "ghost" all-commas rows from spreadsheet exports.
      if (cells.every(c => c === '')) continue;
      if (!seenHeader) {
        if (cells.length < 2) throw new Error(`Polar "${id}": header has <2 columns`);
        for (let k = 1; k < cells.length; k++) {
          const v = Number(cells[k]);
          if (!Number.isFinite(v)) throw new Error(`Polar "${id}": bad TWS header value "${cells[k]}"`);
          twsCols.push(v);
        }
        if (twsCols.length < 2) throw new Error(`Polar "${id}": need at least 2 TWS columns`);
        seenHeader = true;
        continue;
      }
      if (cells.length !== twsCols.length + 1) {
        throw new Error(`Polar "${id}": row "${cells[0]}" has ${cells.length - 1} speed cells, expected ${twsCols.length}`);
      }
      const twa = Number(cells[0]);
      if (!Number.isFinite(twa)) throw new Error(`Polar "${id}": bad TWA value "${cells[0]}"`);
      const row = [];
      for (let k = 1; k < cells.length; k++) {
        const v = Number(cells[k]);
        if (!Number.isFinite(v) || v < 0) throw new Error(`Polar "${id}": bad speed "${cells[k]}" at TWA ${twa}, TWS ${twsCols[k - 1]}`);
        row.push(v);
      }
      twaRows.push(twa);
      speeds.push(row);
    }

    if (twaRows.length < 2) throw new Error(`Polar "${id}": need at least 2 TWA rows`);
    for (let k = 1; k < twaRows.length; k++) if (twaRows[k] <= twaRows[k - 1]) {
      throw new Error(`Polar "${id}": TWA rows not strictly ascending at ${twaRows[k]}`);
    }
    for (let k = 1; k < twsCols.length; k++) if (twsCols[k] <= twsCols[k - 1]) {
      throw new Error(`Polar "${id}": TWS columns not strictly ascending at ${twsCols[k]}`);
    }

    return new Polar({ id, name: name || id, twaRows, twsCols, speeds });
  }
}

module.exports = { Polar }
