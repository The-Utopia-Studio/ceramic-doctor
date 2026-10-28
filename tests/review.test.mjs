import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { review, verifyReview, readReview } from '../src/review.mjs'
import { runProjectQa, runCommand } from '../src/doctor.mjs'

const cleanPage = '<!doctype html><html lang="en"><head><title>Review fixture</title></head><body><main><h1>Preferences</h1><p>Choose your settings.</p><button id="open" onclick="document.getElementById(\'details\').hidden=false">Open details</button><section id="details" hidden><h2>Details</h2><p>Settings are visible.</p></section></main></body></html>'
const badPage = '<!doctype html><html lang="en"><head><title>Review fixture</title></head><body><main><h1>Preferences</h1><button id="unnamed"></button><div style="width:1800px">Wide content</div><img src="/missing.png"><script>throw new Error("fixture-render-failure")</script></main></body></html>'

test('real desktop/mobile review finds defects, saves evidence, then verifies the repaired same scope', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ceramic-review-test-'))
  let fixed = false
  const server = createServer((req, res) => {
    if (req.url === '/missing.png') { res.writeHead(404); res.end(); return }
    res.setHeader('Content-Type', 'text/html'); res.end(fixed ? cleanPage : badPage)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const input = { url: `http://127.0.0.1:${server.address().port}`, readySelector: 'h1' }
    const before = await review(input, { projectRoot: root })
    assert.equal(before.execution, 'completed', JSON.stringify(before.coverage))
    assert.equal(before.verdict, 'FAIL')
    assert.equal(before.doctor.ok, true)
    assert.match(before.doctor.scope, /installed/)
    for (const rule of ['button-name', 'image-alt', 'document-overflow', 'broken-image', 'runtime-error']) assert.ok(before.findings.some(f => f.rule === rule), rule)
    assert.equal(before.coverage.filter(c => c.scenario === 'initial' && c.status === 'completed').length, 2)
    assert.equal((await readFile(join(before.artifacts.directory, 'initial-mobile.png'))).subarray(0, 4).toString('hex'), '89504e47')
    const persisted = await readReview(before.id, root)
    assert.equal(persisted.finishedAt, before.finishedAt)
    fixed = true
    const after = await verifyReview(before.id, { projectRoot: root })
    assert.equal(after.execution, 'completed')
    assert.equal(after.findings.length, 0, JSON.stringify(after.findings))
    assert.equal(after.verification.fixed.length, before.findings.length)
    assert.equal(after.verification.allClear, true)
    assert.equal((await readReview(before.id, root)).verdict, 'FAIL', 'baseline must remain immutable')
    assert.equal(after.score.value, 100)
    assert.equal(after.verdict, 'PASS WITH RISKS', 'skipped visual and project tests must remain disclosed')

    const blocked = await review({ ...input, readySelector: '#does-not-exist', timeoutMs: 1000 }, { projectRoot: root })
    assert.equal(blocked.execution, 'partial')
    assert.equal(blocked.verdict, 'BLOCKED')
    assert.equal(blocked.score.value, null)

    const interactive = await review({ ...input, visual: 'codex', scenarios: [{ id: 'details', actions: [{ kind: 'click', selector: '#open' }, { kind: 'expectText', selector: '#details', value: 'Settings are visible.' }] }] },
      { projectRoot: root, visualJudge: async screens => { assert.equal(screens.length, 2); return { status: 'completed', provider: 'test-double', summary: 'Test adapter only', findings: [] } } })
    assert.ok(interactive.coverage.filter(c => c.scenario === 'details').every(c => c.actionsCompleted === 2))
    assert.equal(interactive.visual.status, 'completed')
    await assert.rejects(readReview('../../etc/passwd', root))
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})

test('existing QA runner is reused with structured output; absence and timeouts cannot pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ceramic-project-qa-'))
  try {
    assert.equal((await runProjectQa(root, 'browser')).status, 'blocked')
    const directory = join(root, '.agents/skills/design-system-ux-qa/scripts')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'run-qa.mjs'), 'console.log(JSON.stringify({args:process.argv.slice(2)}));process.exit(1)')
    const result = await runProjectQa(root, 'browser')
    assert.equal(result.status, 'failed')
    assert.deepEqual(JSON.parse(result.stdout).args, ['browser', '--json'])
    const timedOut = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 50 })
    assert.equal(timedOut.status, 'blocked')
    assert.equal(timedOut.timedOut, true)
    const controller = new AbortController()
    controller.abort()
    assert.equal((await runCommand(process.execPath, ['-e', 'process.exit(0)'], { cwd: root, signal: controller.signal })).status, 'blocked')
  } finally { await rm(root, { recursive: true, force: true }) }
})
