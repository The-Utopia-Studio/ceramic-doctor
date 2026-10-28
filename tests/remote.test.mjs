import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createRemoteHandler } from '../src/remote.mjs'
import { createRemoteStore, reportPath } from '../src/remote-store.mjs'
import { isPublicAddress, resolvePublicUrl, createPublicNetworkPolicy } from '../src/public-network.mjs'
import { review } from '../src/review.mjs'

test('remote targets reject private/reserved IPv4, IPv6, mapped addresses, credentials and mixed DNS answers', async () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '169.254.169.254', '10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(address), false, address)
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address)
  for (const url of ['http://localhost', 'http://127.1', 'http://0x7f000001', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://metadata.internal', 'file:///etc/passwd', 'http://user:secret@example.com', 'https://example.com:8000']) await assert.rejects(resolvePublicUrl(url))
  await assert.rejects(resolvePublicUrl('https://example.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]))
  const target = await resolvePublicUrl('https://example.com', async () => [{ address: '8.8.8.8', family: 4 }])
  assert.equal(target.address, '8.8.8.8')
})

test('network policy blocks writes and WebSockets, and proxies every resource including redirects', async () => {
  let routeHandler, socketHandler, fetches = 0
  const context = { routeWebSocket: async (_, fn) => { socketHandler = fn }, route: async (_, fn) => { routeHandler = fn } }
  await createPublicNetworkPolicy(async url => { fetches++; await resolvePublicUrl(url, async () => [{ address: '8.8.8.8', family: 4 }]); return { status: 302, body: Buffer.from(''), headers: { location: 'http://127.0.0.1' } } })(context)
  let aborted = false, fulfilled
  const route = method => ({ request: () => ({ method: () => method, url: () => 'https://example.com', allHeaders: async () => ({}) }), abort: async () => { aborted = true }, fulfill: async value => { fulfilled = value } })
  await routeHandler(route('POST')); assert.equal(aborted, true); assert.equal(fetches, 0)
  await routeHandler(route('GET')); assert.equal(fetches, 1); assert.equal(fulfilled.status, 302)
  let closed = false; socketHandler({ close: () => { closed = true } }); assert.equal(closed, true)
})

function memoryBlob() {
  const objects = new Map()
  return {
    objects,
    put: async (path, data, options) => {
      assert.equal(options.access, 'private')
      if (objects.has(path) && !options.allowOverwrite) throw new Error('Blob already exists')
      objects.set(path, String(data)); return { pathname: path }
    },
    get: async path => objects.has(path) ? { statusCode: 200, blob: { size: Buffer.byteLength(objects.get(path)) }, stream: new Response(objects.get(path)).body } : null,
    list: async ({ prefix }) => ({ blobs: [...objects.keys()].filter(p => p.startsWith(prefix)).map(pathname => ({ pathname, url: pathname })), hasMore: false }),
    del: async paths => { for (const path of paths) objects.delete(path) },
  }
}

test('private storage reserves anonymous budgets atomically and rejects guessed capability paths', async () => {
  const blob = memoryBlob(), store = createRemoteStore(blob)
  const attempts = await Promise.allSettled([store.reserve('same-caller'), store.reserve('same-caller')])
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1)
  assert.ok(![...blob.objects.keys()].some(path => path.includes('same-caller')))
  assert.throws(() => reportPath('../report.json'))
  assert.throws(() => reportPath('a3c148c6-7d90-4c19-8dca-1e8ad7643b74'))
  await assert.rejects(store.read('2026-10-28.a3c148c6-7d90-4c19-8dca-1e8ad7643b74.' + '0'.repeat(64)))
})

test('HTTP MCP reviews with real Chromium, preserves private evidence across requests and verifies repairs', { timeout: 90_000 }, async () => {
  const blob = memoryBlob(), store = createRemoteStore(blob)
  let broken = true
  const execute = (input, options) => review(input, { ...options, contextPolicy: async context => {
    await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Remote review fixture</title></head><body><main><h1>Remote review</h1><button id="action">${broken ? '' : 'Continue'}</button></main></body></html>` }))
  } })
  const handler = createRemoteHandler({ store: { ...store, reserve: async () => {} }, execute, validateUrl: async () => {} })
  const http = createServer(handler)
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const endpoint = new URL(`http://127.0.0.1:${http.address().port}/mcp`)
  const client = new Client({ name: 'http-contract-test', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint))
    const tools = await client.listTools()
    assert.equal(tools.tools.length, 6)
    assert.equal(tools.tools[1].inputSchema.properties.visual, undefined)
    assert.equal((await client.callTool({ name: 'doctor', arguments: {} })).structuredContent.ok, true)
    const result = await client.callTool({ name: 'design_review', arguments: { url: 'https://example.com', readySelector: 'h1' } }, undefined, { timeout: 60_000 })
    const before = result.structuredContent
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(before.verdict, 'FAIL')
    assert.ok(before.findings.some(f => f.rule === 'button-name'))
    assert.match(before.id, /\.[a-f0-9]{64}$/)
    assert.equal(before.artifacts.directory, undefined)
    assert.equal(before.browserEvidence['initial-mobile'].coverage.viewport, 'mobile')
    assert.equal((await client.callTool({ name: 'get_review', arguments: { reviewId: before.id } })).structuredContent.id, before.id)
    const image = await client.callTool({ name: 'get_screenshot', arguments: { reviewId: before.id, scenario: 'initial', viewport: 'mobile' } })
    assert.equal(image.content[0].type, 'image')
    assert.equal((await client.callTool({ name: 'list_reviews', arguments: { reviewIds: [] } })).structuredContent.reviews.length, 0)
    const guessed = before.id.slice(0, -1) + (before.id.endsWith('a') ? 'b' : 'a')
    assert.equal((await client.callTool({ name: 'get_review', arguments: { reviewId: guessed } })).isError, true)
    broken = false
    const after = await client.callTool({ name: 'verify_fixes', arguments: { reviewId: before.id } }, undefined, { timeout: 60_000 })
    assert.equal(after.structuredContent.verification.allClear, true, JSON.stringify(after))
    assert.equal((await client.callTool({ name: 'design_review', arguments: { url: 'https://example.com', visual: 'codex' } })).isError, true)
    assert.equal((await fetch(endpoint)).status, 405)
    assert.equal((await fetch(endpoint, { method: 'OPTIONS' })).status, 204)
  } finally { await client.close(); await new Promise(resolve => http.close(resolve)) }
})
