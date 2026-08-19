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
