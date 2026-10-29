import { execFileSync } from 'node:child_process'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { reviewFiles, validateFiles, validatePolicy, sourceExtensions, unsupportedUiExtensions } from './code-review.mjs'

const git = (root, args, options = {}) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'], ...options })
export function resolveCommit(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 300) throw new Error('Invalid Git revision.')
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim()
}
export function addedLineRanges(diff) {
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map(m => m[2] === '0'
    ? { start: Math.max(1, Number(m[1])), end: Math.max(1, Number(m[1]) + 1) }
    : { start: Number(m[1]), end: Number(m[1]) + Number(m[2] ?? 1) - 1 })
}

export async function collectGitChanges({ projectRoot = process.cwd(), staged = false, base, head, policyRef } = {}) {
  if (staged && (base || head)) throw new Error('--staged cannot be combined with --base/--head.')
  if (head && !base) throw new Error('--head requires --base.')
  const root = git(projectRoot, ['rev-parse', '--show-toplevel']).trim()
  const resolvedHead = head || base ? resolveCommit(root, head ?? 'HEAD') : null
  let resolvedBase, comparisonBase, diffArgs, indexTree
  if (base) {
    // A new branch's all-zero remote SHA means there is no previous tree.
    if (/^0{40,64}$/.test(base)) {
      comparisonBase = git(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' }).trim()
      resolvedBase = comparisonBase
    } else {
      resolvedBase = resolveCommit(root, base)
      comparisonBase = git(root, ['merge-base', resolvedBase, resolvedHead]).trim()
    }
    diffArgs = [comparisonBase, resolvedHead]
  } else if (staged) {
    indexTree = git(root, ['write-tree']).trim()
    try { comparisonBase = resolveCommit(root, 'HEAD') }
    catch { comparisonBase = git(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' }).trim() }
    diffArgs = [comparisonBase, indexTree]
  } else diffArgs = ['HEAD']
  if (!base && !staged) {
    try { resolveCommit(root, 'HEAD') } catch { diffArgs = [git(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' }).trim()] }
  }
  const tracked = git(root, ['diff', ...diffArgs, '--name-only', '-z', '--diff-filter=ACMRT', '--no-renames', '--no-ext-diff', '--no-textconv']).split('\0').filter(Boolean)
  const untracked = !base && !staged ? git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean) : []
  const names = [...new Set([...tracked, ...untracked])]
  const files = [], collectionIssues = [], skipped = []
  let bytes = 0
  for (const path of names) {
    const extension = '.' + path.split('.').at(-1).toLowerCase()
    if (!sourceExtensions.has(extension) && !unsupportedUiExtensions.has(extension)) { skipped.push(path); continue }
    if (files.length >= 100) { collectionIssues.push({ path, message: 'Review file limit exceeded.' }); continue }
    try {
      let content
      if (base || staged) {
        const tree = base ? resolvedHead : indexTree
        const mode = git(root, ['ls-tree', tree, '--', path]).split(' ')[0]
        if (!['100644', '100755'].includes(mode)) throw new Error('Only regular source files can be reviewed; symlinks/submodules are not followed.')
        content = git(root, ['show', `${tree}:${path}`])
      } else {
        const fullPath = resolve(root, path)
        const stat = await lstat(fullPath)
        if (!stat.isFile() || stat.isSymbolicLink() || relative(root, await realpath(fullPath)).startsWith('..')) throw new Error('Source path leaves the repository or is not a regular file.')
        if (stat.size > 256 * 1024) throw new Error('Source file exceeds 256 KiB.')
        content = await readFile(fullPath, 'utf8')
      }
      bytes += Buffer.byteLength(content)
      if (Buffer.byteLength(content) > 256 * 1024 || bytes > 2 * 1024 * 1024) throw new Error('Source review payload limit exceeded.')
      const diff = untracked.includes(path) ? null : git(root, ['diff', ...diffArgs, '--unified=0', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', '--', path])
      const file = { path, content, ...(diff === null ? {} : { changedLines: addedLineRanges(diff) }) }
      validateFiles([file])
      files.push(file)
    } catch (error) { collectionIssues.push({ path, message: String(error.message).split('\n')[0].slice(0, 300) }) }
  }
  const trustedPolicyRef = policyRef ? resolveCommit(root, policyRef) : base && !/^0{40,64}$/.test(base) ? resolvedBase : staged ? indexTree : null
  let policy = {}, policySource = trustedPolicyRef ?? 'working-tree'
  try {
    if (trustedPolicyRef) {
      const exists = git(root, ['ls-tree', trustedPolicyRef, '--', '.ceramic-review.json'])
      if (exists) policy = JSON.parse(git(root, ['show', `${trustedPolicyRef}:.ceramic-review.json`]))
    } else {
      const path = resolve(root, '.ceramic-review.json')
      try { if (!(await lstat(path)).isFile()) throw new Error('Review policy must be a regular file.'); policy = JSON.parse(await readFile(path, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    policy = validatePolicy(policy)
  } catch { collectionIssues.push({ path: '.ceramic-review.json', message: 'Review policy is unreadable or invalid; no passing verdict is issued.' }); policy = validatePolicy() }
  return { root, files, policy, collectionIssues, context: { mode: base ? 'commit-range' : staged ? 'staged-index' : 'working-tree', base: resolvedBase, comparisonBase, head: resolvedHead, stagedTree: indexTree, policyRevision: policySource, skippedNonUiFiles: skipped.length } }
}

export async function reviewGitChanges(options = {}) {
  const collected = await collectGitChanges(options)
  const report = reviewFiles({ files: collected.files, policy: collected.policy, context: collected.context, failOn: options.failOn })
  if (collected.collectionIssues.length) {
    report.collectionIssues = collected.collectionIssues
    report.execution = 'partial'; report.verdict = 'BLOCKED'; report.score.value = null
  }
  return { report, root: collected.root }
}
