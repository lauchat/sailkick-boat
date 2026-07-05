'use strict'

// Durable on-disk spool: the heart of "gapless".
//
// Each flushed batch becomes one atomically-published `.lp` file (write to a
// temp name, then rename). A file existing == not yet acknowledged by InfluxDB;
// the uploader deletes it only after a 204. Because the spool lives on disk, an
// offline stretch or a full Signal K restart simply leaves files to be uploaded
// on next start — nothing is lost. The buffer is bounded by total bytes; on
// overflow the oldest files are dropped (and logged) so a long-offline boat
// never fills its own disk.

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024 // 500 MB

class Spool {
  constructor ({ dir, maxBytes, logger } = {}) {
    this.dir = dir
    this.deadDir = path.join(dir, 'dead')
    this.maxBytes = maxBytes || DEFAULT_MAX_BYTES
    this.log = logger || (() => {})
    this.seq = 0
  }

  async init () {
    await fsp.mkdir(this.dir, { recursive: true })
    await fsp.mkdir(this.deadDir, { recursive: true })
    // Remove temp files orphaned by a crash mid-write.
    for (const f of await fsp.readdir(this.dir)) {
      if (f.startsWith('.tmp-')) {
        await fsp.unlink(path.join(this.dir, f)).catch(() => {})
      }
    }
  }

  // Persist a batch of line-protocol strings as one atomic .lp file.
  async append (lines) {
    if (!lines || !lines.length) return null
    const body = lines.join('\n') + '\n'
    const name = `${Date.now().toString().padStart(15, '0')}-${(this.seq++)
      .toString().padStart(9, '0')}.lp`
    const tmp = path.join(this.dir, `.tmp-${name}`)
    const dst = path.join(this.dir, name)
    await fsp.writeFile(tmp, body)
    await fsp.rename(tmp, dst) // atomic publish
    await this.enforceBound()
    return dst
  }

  // Pending .lp files, oldest first (zero-padded names sort chronologically).
  async pending () {
    const files = (await fsp.readdir(this.dir))
      .filter(f => f.endsWith('.lp') && !f.startsWith('.tmp-'))
      .sort()
    return files.map(f => path.join(this.dir, f))
  }

  async stats () {
    let bytes = 0
    let count = 0
    for (const f of await this.pending()) {
      try { bytes += (await fsp.stat(f)).size; count++ } catch {}
    }
    return { count, bytes }
  }

  async enforceBound () {
    let { bytes } = await this.stats()
    if (bytes <= this.maxBytes) return 0
    let dropped = 0
    let droppedBytes = 0
    for (const f of await this.pending()) {
      if (bytes <= this.maxBytes) break
      try {
        const sz = (await fsp.stat(f)).size
        await fsp.unlink(f)
        bytes -= sz; droppedBytes += sz; dropped++
      } catch {}
    }
    if (dropped) {
      this.log(`buffer exceeded ${this.maxBytes} bytes — dropped ${dropped} oldest file(s) (${droppedBytes} bytes)`)
    }
    return dropped
  }

  async remove (file) {
    await fsp.unlink(file).catch(() => {})
  }

  // Move a permanently-rejected (4xx) batch aside so it can't block the queue.
  async quarantine (file) {
    const dst = path.join(this.deadDir, path.basename(file))
    await fsp.rename(file, dst).catch(async () => { await this.remove(file) })
    return dst
  }
}

module.exports = { Spool, DEFAULT_MAX_BYTES }
