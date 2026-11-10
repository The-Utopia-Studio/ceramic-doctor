import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { codeWorkflow } from '../src/code-integration.mjs'

// Execute the shipped shell blocks, rather than a second implementation.
function scriptFor(name) {
  const step = codeWorkflow().split(`      - name: ${name}\n`)[1]
  assert.ok(step, `Missing workflow step: ${name}`)
  return step.split('        run: |\n')[1].split('\n').slice(0)
    .filter((line, index, lines) => lines.slice(0, index + 1).every(value => value.startsWith('          ')))
    .map(line => line.slice(10)).join('\n')
}

test('workflow covers all branch pushes and PRs with bounded, independent runs', () => {
  const workflow = codeWorkflow()
  assert.match(workflow, /pull_request:\n  push:\n    branches: \['\*\*'\]/)
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|pull-requests: write/)
  assert.match(workflow, /github.event_name.*github.event.pull_request.number \|\| github.ref/)
  assert.match(workflow, /cancel-in-progress: true/)
  assert.match(workflow, /timeout-minutes: 10/)
  assert.match(workflow, /if: github.event.deleted != true/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /ceramic-doctor@[a-f0-9]{40}/)
})

test('new feature branches compare to the default branch; normal pushes and PR bases are preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ceramic-cloud-scope-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  try {
    git('init', '-b', 'trunk')
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
    await writeFile(join(root, 'README.md'), 'Initial')
    git('add', '.'); git('commit', '-m', 'Initial')
    const base = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/trunk', base)
    git('checkout', '-b', 'feature/new')
    await writeFile(join(root, 'README.md'), 'Changed')
    git('add', '.'); git('commit', '-m', 'Change')
    const head = git('rev-parse', 'HEAD')
    const run = async (inputBase, ref, defaultBranch = 'trunk') => {
      const output = join(root, 'output')
      await writeFile(output, '')
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', scriptFor('Resolve review commits')], {
        cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output,
          CD_BASE: inputBase, CD_REF: ref, CD_DEFAULT_BRANCH: defaultBranch },
      })
      return { ...result, output: await readFile(output, 'utf8') }
    }
    for (const input of ['0'.repeat(40), base]) {
      const result = await run(input, 'refs/heads/feature/new')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.output, `base=${base}\nhead=${head}\n`)
    }
    const initial = await run('0'.repeat(40), 'refs/heads/trunk')
    assert.equal(initial.status, 0)
    assert.match(initial.output, /base=0{40}\n/)
    const missing = await run('0'.repeat(40), 'refs/heads/feature/new', 'missing')
    assert.notEqual(missing.status, 0, 'Missing baseline must not silently pass')
    assert.equal(missing.output, '')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('usage summary rounds elapsed minutes and labels gross cost and missing billing coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ceramic-cloud-cost-'))
  try {
    const date = join(root, 'date'), summary = join(root, 'summary')
    await writeFile(date, '#!/bin/sh\nprintf "%s\\n" "$CD_TEST_NOW"\n')
    await chmod(date, 0o755)
    for (const [seconds, minutes, dollars] of [[1, 1, '0.006'], [60, 1, '0.006'], [61, 2, '0.012'], [600, 10, '0.060']]) {
      await writeFile(summary, '')
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', scriptFor('Summarize estimated runner cost')], {
        encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`,
          CD_STARTED: '1000', CD_TEST_NOW: String(1000 + seconds), GITHUB_STEP_SUMMARY: summary },
      })
      assert.equal(result.status, 0, result.stderr)
      const markdown = await readFile(summary, 'utf8')
      assert.ok(markdown.includes(`rounded estimate: ${minutes} Linux minutes`))
      assert.ok(markdown.includes(`USD ${dollars} at`))
      assert.match(markdown, /not an invoice/)
      assert.match(markdown, /Cancelled or timed-out jobs/)
      assert.match(markdown, /Push and PR events are separate runs/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
