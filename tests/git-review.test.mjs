import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectGitChanges, reviewGitChanges, addedLineRanges } from '../src/git-review.mjs'
import { installCodeHooks, initCodeWorkflow } from '../src/code-integration.mjs'

const cli = fileURLToPath(new URL('../bin/ceramic-doctor.mjs', import.meta.url))
const bad = 'export const Card=()=> <img src="x" />\n'
const good = 'export const Card=()=> <img src="x" alt="Company" />\n'
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'ceramic-git-review-'))
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(root, 'README.md'), 'Fixture\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'Initial')
  await mkdir(join(root, 'src'))
  return root
}

test('staged review uses the exact index tree, not unstaged replacements, with safe space/quote paths', async () => {
  const root = await repository()
  try {
    const path = "src/Card 'one'.tsx"
    await writeFile(join(root, path), bad); git(root, 'add', '--', path)
    await writeFile(join(root, path), good)
    const staged = await reviewGitChanges({ projectRoot: root, staged: true })
    assert.equal(staged.report.verdict, 'FAIL')
    assert.equal(staged.report.context.mode, 'staged-index')
    assert.match(staged.report.context.stagedTree, /^[a-f0-9]{40,64}$/)
    assert.equal(staged.report.findings[0].file, path)
    assert.equal((await reviewGitChanges({ projectRoot: root })).report.verdict, 'PASS')
    await writeFile(join(root, 'src/Untracked.tsx'), bad)
    assert.ok((await collectGitChanges({ projectRoot: root })).files.some(f => f.path === 'src/Untracked.tsx'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('PR review pins base/head, reports only changed lines, and reads policy from the base commit', async () => {
  const root = await repository()
  try {
    await writeFile(join(root, '.ceramic-review.json'), JSON.stringify({ semanticTokens: true }))
    await writeFile(join(root, 'src/Card.tsx'), bad)
    git(root, 'add', '.'); git(root, 'commit', '-m', 'Baseline with existing defect')
    const base = git(root, 'rev-parse', 'HEAD')
    await mkdir(join(root, 'src/pages'))
    await writeFile(join(root, 'src/Card.tsx'), bad + 'export const Save=()=> <button />\n')
    await writeFile(join(root, 'src/pages/Home.tsx'), 'import "./oneoff.css"; export const Home=()=> <main>Home</main>')
    await writeFile(join(root, '.ceramic-review.json'), JSON.stringify({ semanticTokens: false, ignore: ['**'] }))
    git(root, 'add', '.'); git(root, 'commit', '-m', 'Add new UI defects and attempt to weaken policy')
    const head = git(root, 'rev-parse', 'HEAD')
    const { report } = await reviewGitChanges({ projectRoot: root, base, head })
    assert.equal(report.context.base, base); assert.equal(report.context.head, head)
    assert.equal(report.context.policyRevision, base)
    assert.ok(!report.findings.some(f => f.rule === 'jsx-a11y/alt-text'))
    assert.ok(report.findings.some(f => f.rule === 'jsx-a11y/control-has-associated-label'))
    assert.ok(report.findings.some(f => f.rule === 'ceramic/page-style-ownership'))
    await assert.rejects(reviewGitChanges({ projectRoot: root, base: '--help' }))
    const command = spawnSync(process.execPath, [cli, 'check', '--project', root, '--base', base, '--head', head, '--format', 'github', '--out', join(root, 'reports')], { encoding: 'utf8' })
    assert.equal(command.status, 1, command.stderr)
    assert.match(command.stdout, /::error file=src\/Card.tsx,line=2/)
    assert.equal(JSON.parse(await readFile(join(root, 'reports/report.sarif'), 'utf8')).version, '2.1.0')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unsupported UI and symlinks block coverage; new-branch and unborn-index snapshots work', async () => {
  const root = await repository()
  try {
    await symlink('/etc/hosts', join(root, 'src/Escape.tsx'))
    assert.equal((await reviewGitChanges({ projectRoot: root })).report.execution, 'partial')
    await rm(join(root, 'src/Escape.tsx'))
    await writeFile(join(root, 'src/App.vue'), '<template />')
    assert.equal((await reviewGitChanges({ projectRoot: root })).report.verdict, 'BLOCKED')
    await rm(join(root, 'src/App.vue'))
    await writeFile(join(root, 'src/Card.tsx'), bad); git(root, 'add', '.'); git(root, 'commit', '-m', 'Add UI')
    assert.equal((await reviewGitChanges({ projectRoot: root, base: '0'.repeat(40), head: 'HEAD' })).report.verdict, 'FAIL')
    const unborn = await mkdtemp(join(tmpdir(), 'ceramic-unborn-'))
    try {
      git(unborn, 'init'); await writeFile(join(unborn, 'Card.tsx'), bad); git(unborn, 'add', '.')
      assert.equal((await reviewGitChanges({ projectRoot: unborn, staged: true })).report.verdict, 'FAIL')
      assert.equal((await reviewGitChanges({ projectRoot: unborn })).report.verdict, 'FAIL')
    } finally { await rm(unborn, { recursive: true, force: true }) }
  } finally { await rm(root, { recursive: true, force: true }) }
  assert.deepEqual(addedLineRanges('@@ -1,2 +1,0 @@\n@@ -4 +3,2 @@'), [{ start: 1, end: 2 }, { start: 3, end: 4 }])
})

test('opt-in hooks block bad commits and pushes, allow repairs, and preserve existing hook managers', async () => {
  const root = await repository()
  try {
    await installCodeHooks(root)
    await writeFile(join(root, 'src/Card.tsx'), bad); git(root, 'add', '.')
    assert.notEqual(spawnSync('git', ['commit', '-m', 'Must block'], { cwd: root, encoding: 'utf8' }).status, 0)
    await writeFile(join(root, 'src/Card.tsx'), good); git(root, 'add', '.')
    assert.equal(spawnSync('git', ['commit', '-m', 'Valid UI'], { cwd: root, encoding: 'utf8' }).status, 0)
    const head = git(root, 'rev-parse', 'HEAD')
    const prepush = spawnSync(join(root, '.git/hooks/pre-push'), [], { cwd: root, encoding: 'utf8', input: `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n` })
    assert.equal(prepush.status, 0, prepush.stderr)
    await writeFile(join(root, 'src/Card.tsx'), bad); git(root, 'add', '.')
    git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Controlled invalid push fixture')
    const badHead = git(root, 'rev-parse', 'HEAD')
    const blockedPush = spawnSync(join(root, '.git/hooks/pre-push'), [], { cwd: root, encoding: 'utf8', input: `refs/heads/main ${badHead} refs/heads/main ${head}\n` })
    assert.equal(blockedPush.status, 1, blockedPush.stderr)
    await assert.rejects(installCodeHooks(root))
    await initCodeWorkflow(root)
    assert.match(await readFile(join(root, '.github/workflows/ceramic-doctor.yml'), 'utf8'), /pull_request:/)
    await assert.rejects(initCodeWorkflow(root))
    const customRoot = await repository()
    try { git(customRoot, 'config', 'core.hooksPath', '.husky'); await assert.rejects(installCodeHooks(customRoot), /custom core.hooksPath/) }
    finally { await rm(customRoot, { recursive: true, force: true }) }
  } finally { await rm(root, { recursive: true, force: true }) }
})
