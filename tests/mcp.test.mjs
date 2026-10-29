import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const cli = fileURLToPath(new URL('../bin/ceramic-doctor.mjs', import.meta.url))

test('official MCP client initializes, reviews a real URL, reads evidence and verifies fixes', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ceramic-mcp-review-'))
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="en"><head><title>MCP review</title></head><body><main><h1>Review through MCP</h1><p>Ready.</p></main></body></html>') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--project', root], stderr: 'pipe' })
  const client = new Client({ name: 'ceramic-doctor-contract-test', version: '1' })
  try {
    await client.connect(transport)
    assert.equal(client.getServerVersion().name, 'ceramic-doctor')
    const list = await client.listTools()
    assert.deepEqual(list.tools.map(t => t.name), ['review_files', 'verify_code_fixes', 'doctor', 'design_review', 'verify_fixes', 'list_reviews', 'get_review', 'get_screenshot'])
    const code = await client.callTool({ name: 'review_files', arguments: { files: [{ path: 'Card.tsx', content: 'export const Card=()=> <img src="x" />' }] } })
    assert.equal(code.structuredContent.verdict, 'FAIL')
    assert.equal(code.isError, false)
    const repaired = await client.callTool({ name: 'verify_code_fixes', arguments: { previous: code.structuredContent, files: [{ path: 'Card.tsx', content: 'export const Card=()=> <img src="x" alt="Company" />' }] } })
    assert.equal(repaired.structuredContent.verification.allClear, true)
    const doctor = await client.callTool({ name: 'doctor', arguments: {} })
    assert.equal(doctor.structuredContent.ok, true)
    const result = await client.callTool({ name: 'design_review', arguments: { url: `http://127.0.0.1:${server.address().port}`, readySelector: 'h1' } }, undefined, { timeout: 60_000 })
    assert.equal(result.isError, false, JSON.stringify(result))
    const report = result.structuredContent
    assert.equal(report.execution, 'completed')
    assert.equal((await client.callTool({ name: 'get_review', arguments: { reviewId: report.id } })).structuredContent.id, report.id)
    const screenshot = await client.callTool({ name: 'get_screenshot', arguments: { reviewId: report.id, scenario: 'initial', viewport: 'mobile' } })
    assert.equal(screenshot.content[0].type, 'image')
    assert.equal((await client.callTool({ name: 'list_reviews', arguments: {} })).structuredContent.reviews.length, 1)
    const verified = await client.callTool({ name: 'verify_fixes', arguments: { reviewId: report.id } }, undefined, { timeout: 60_000 })
    assert.equal(verified.structuredContent.verification.allClear, true)
    const invalid = await client.callTool({ name: 'design_review', arguments: { url: 'file:///etc/passwd' } })
    assert.equal(invalid.isError, true)
    assert.equal((await client.callTool({ name: 'get_review', arguments: { reviewId: '../escape' } })).isError, true)
  } finally { await client.close(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})

test('CLI installs the packaged skill and rejects overwriting an existing skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ceramic-skill-install-'))
  try {
    const first = spawnSync(process.execPath, [cli, 'install-skill', '--directory', root], { encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    assert.match(await readFile(join(root, 'ceramic-doctor/SKILL.md'), 'utf8'), /name: ceramic-doctor/)
    assert.equal(spawnSync(process.execPath, [cli, 'install-skill', '--directory', root], { encoding: 'utf8' }).status, 2)
    await access(join(root, 'ceramic-doctor/agents/openai.yaml'))
    const invalid = spawnSync(process.execPath, [cli, 'review', 'file:///etc/passwd', '--project', root, '--json'], { encoding: 'utf8' })
    assert.equal(invalid.status, 2)
    // Browsers are already provisioned for this suite; exercise the real install entrypoint.
    const browserInstall = spawnSync(process.execPath, [cli, 'install-browser'], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(browserInstall.status, 0, browserInstall.stderr)
  } finally { await rm(root, { recursive: true, force: true }) }
})
