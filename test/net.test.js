'use strict'

// The shared outbound transport. It exists because fetch() cannot be made safe on this
// boat: Starlink is behind CGNAT, which drops idle NAT mappings without an RST, so a
// pooled keep-alive socket looks alive and is dead — and a plugin has no supported way to
// reset undici's pool. Twice the Signal K process lost ALL outbound HTTPS for over half
// an hour while a second process in the same container connected in under a second.

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const { request, resetTransport, _agents } = require('../lib/net')
const listen = (s) => new Promise((r) => s.listen(0, r))
const shut = (s) => new Promise((r) => { s.closeAllConnections && s.closeAllConnections(); s.close(r) })

test('net: transport failures throw with the REAL code, not "fetch failed"', async () => {
  const probe = http.createServer(); await listen(probe)
  const port = probe.address().port
  await shut(probe) // now certainly closed

  await assert.rejects(() => request(`http://127.0.0.1:${port}/x`, { timeoutMs: 3000 }),
    (e) => e.code === 'ECONNREFUSED', 'a closed port names ECONNREFUSED')
  await assert.rejects(() => request('http://[::1]:0/x'), (e) => !!e.code, 'always carries a code')
})

test('net: a timeout is ETIMEDOUT, not a silent hang', async () => {
  const srv = http.createServer(() => { /* never responds */ })
  await listen(srv)
  await assert.rejects(() => request(`http://127.0.0.1:${srv.address().port}/x`, { timeoutMs: 300 }),
    (e) => e.code === 'ETIMEDOUT')
  await shut(srv)
})

test('net: the response exposes what the call sites use', async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/'])
    res.statusCode = 201
    res.end('{"hello":"world"}')
  })
  await listen(srv)
  const r = await request(`http://127.0.0.1:${srv.address().port}/x`, { timeoutMs: 5000 })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.status, 201)
  assert.strictEqual(r.headers.get('Content-Type'), 'application/json', 'case-insensitive')
  assert.deepStrictEqual(r.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/'], 'set-cookie stays an array')
  assert.deepStrictEqual(await r.json(), { hello: 'world' })
  assert.strictEqual((await r.text()), '{"hello":"world"}')
  assert.ok(Buffer.isBuffer(r.buffer))
  const seen = {}
  r.headers.forEach((v, k) => { seen[k] = v })
  assert.ok(seen['content-type'])
  await shut(srv)
})

test('net: an HTTP error status resolves — only transport failures throw', async () => {
  const srv = http.createServer((req, res) => { res.statusCode = 503; res.end('nope') })
  await listen(srv)
  const r = await request(`http://127.0.0.1:${srv.address().port}/x`, { timeoutMs: 5000 })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.status, 503, 'the caller decides what a status means')
  await shut(srv)
})

test('net: resetTransport replaces the pool, and requests work after it', async () => {
  const srv = http.createServer((req, res) => { res.end('ok') })
  await listen(srv)
  const url = `http://127.0.0.1:${srv.address().port}/x`
  await request(url, { timeoutMs: 5000 })
  const before = _agents()
  assert.ok(before, 'a pool exists')
  const gen = resetTransport()
  assert.ok(gen >= 1)
  assert.strictEqual(_agents(), null, 'the poisoned pool is discarded')
  assert.strictEqual((await request(url, { timeoutMs: 5000 })).status, 200, 'works on a fresh pool')
  assert.notStrictEqual(_agents(), before)
  await shut(srv)
})

test('net: an in-flight request keeps the process alive; an idle pool does not', () => {
  // Both halves matter and they pull opposite ways. Unref-ing the socket unconditionally
  // (a first attempt at this) let Node exit MID-REQUEST, so the caller never resolved and
  // the script printed nothing. Not unref-ing at all leaves Signal K unable to shut down.
  const script = `
    const http = require('http')
    const { request } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'net.js'))})
    const srv = http.createServer((q, s) => setTimeout(() => s.end('late'), 250))
    srv.listen(0, async () => {
      const r = await request('http://127.0.0.1:' + srv.address().port + '/x', { timeoutMs: 5000 })
      console.log('RESOLVED:' + (await r.text()))
      srv.close()          // nothing else holds the loop now
    })
  `
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 })
  assert.match(out, /RESOLVED:late/, 'the process stayed alive for the in-flight request')
  // and it exited on its own — execFileSync returning at all proves the idle pool did not
  // pin the event loop.
})

// --- what fetch() did for free and core http does not (v0.23.9) ----------------------
// Reported from the boat: Cesium console full of "Failed to obtain terrain tile … Invalid
// typed array length: 11239580910". The upstream serves terrain PRE-COMPRESSED and sets
// Content-Encoding: gzip whether or not it was asked to. fetch decompressed transparently;
// core http hands back the gzip stream, so the mirror cached gzip bytes labelled as
// terrain and Cesium read the gzip header as a vertex count.
const zlib = require('node:zlib')

test('net: a gzip-encoded response is decoded, and the header is not replayed', async () => {
  const payload = Buffer.from('quantized-mesh-ish payload'.repeat(40))
  const srv = http.createServer((req, res) => {
    res.setHeader('content-encoding', 'gzip')
    res.setHeader('content-type', 'application/vnd.quantized-mesh')
    res.end(zlib.gzipSync(payload))
  })
  await listen(srv)
  const r = await request(`http://127.0.0.1:${srv.address().port}/t.terrain`, { timeoutMs: 5000 })
  assert.ok(r.buffer.equals(payload), 'body decoded')
  assert.notStrictEqual(r.buffer[0], 0x1f, 'not still gzip')
  assert.strictEqual(r.headers.get('content-encoding'), null,
    'the encoding header must be dropped — the cache would otherwise store a false claim')
  assert.strictEqual(r.headers.get('content-type'), 'application/vnd.quantized-mesh', 'content-type survives')
  await shut(srv)
})

test('net: deflate and brotli are decoded too; identity and unknown pass through', async () => {
  const payload = Buffer.from('hello '.repeat(50))
  for (const [enc, body] of [
    ['deflate', zlib.deflateSync(payload)],
    ['br', zlib.brotliCompressSync(payload)],
    ['identity', payload]
  ]) {
    const srv = http.createServer((req, res) => { res.setHeader('content-encoding', enc); res.end(body) })
    await listen(srv)
    const r = await request(`http://127.0.0.1:${srv.address().port}/x`, { timeoutMs: 5000 })
    assert.ok(r.buffer.equals(payload), `${enc} decoded`)
    await shut(srv)
  }
})

test('net: a truncated body is rejected, never returned as a short one', async () => {
  // Core http emits 'end' on a dropped connection and leaves res.complete false. fetch
  // rejects on a short body; without the explicit check a half-downloaded tile would be
  // cached — and tiles are PINNED, so it would be served for ever.
  const srv = http.createServer((req, res) => {
    res.setHeader('content-length', '10000')
    res.write(Buffer.alloc(100, 0x41))
    res.socket.destroy() // cut it off mid-body
  })
  await listen(srv)
  await assert.rejects(() => request(`http://127.0.0.1:${srv.address().port}/x`, { timeoutMs: 5000 }),
    (e) => !!e.code, 'must throw rather than resolve with 100 of 10000 bytes')
  await shut(srv)
})

test('net: corrupt encoded content fails loudly instead of being cached', async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-encoding', 'gzip')
    res.end(Buffer.from('this is not gzip at all'))
  })
  await listen(srv)
  await assert.rejects(() => request(`http://127.0.0.1:${srv.address().port}/x`, { timeoutMs: 5000 }),
    (e) => !!e.code, 'a body that will not decode must not reach the cache')
  await shut(srv)
})
