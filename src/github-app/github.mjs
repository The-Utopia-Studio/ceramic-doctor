import { createSign } from 'node:crypto'
import { sourceExtensions, unsupportedUiExtensions } from '../code-review.mjs'
import { addedLineRanges } from '../git-review.mjs'

const encode = value => encodeURIComponent(String(value))
export class GithubError extends Error {
  constructor(status, retryAfter = 0) { super(`GitHub request failed (${status}); no source approval was issued.`); this.status = status; this.retryAfter = retryAfter }
}
export function appJwt(appId, privateKey, now = Date.now()) {
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: String(appId) })}`
  return `${data}.${createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url')}`
}
export function createGithub({ appId, privateKey, fetchImpl = fetch, signal }) {
  async function request(path, { token, method = 'GET', body } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub API path')
    const response = await fetchImpl(`https://api.github.com${path}`, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Ceramic-Doctor-App', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) {
      await response.body?.cancel()
      const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000
      const resetAfter = response.headers.get('x-ratelimit-remaining') === '0' ? Math.max(1000, Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now()) : 0
      throw new GithubError(response.status, retryAfter || resetAfter)
    }
    if (response.status === 204) return null
    const reader = response.body.getReader(); let size = 0; const chunks = []
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4 * 1024 * 1024) throw new Error('GitHub response exceeded the review budget'); chunks.push(value) } }
    finally { await reader.cancel().catch(() => {}) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  return {
    async installation(job) {
      const auth = await request(`/app/installations/${job.installation}/access_tokens`, { token: appJwt(appId, privateKey), method: 'POST', body: {
        repository_ids: [job.repository], permissions: { contents: 'read', deployments: 'read', checks: 'write', pull_requests: 'write' },
      } })
      const prefix = `/repos/${job.fullName.split('/').map(encode).join('/')}`
      const call = (path, options = {}) => request(prefix + path, { ...options, token: auth.token })
      // Check identity against GitHub, not just the signed delivery's repository name.
      const repo = await call('')
      if (repo.id !== job.repository) throw new Error('Repository identity changed')
      return { call, repo }
    },
  }
}
export async function currentScope(job, api) {
  if (job.kind === 'pr') {
    const pr = await api.call(`/pulls/${job.number}`)
    return { current: pr.state === 'open' && pr.head.sha === job.head && pr.base.sha === job.base, pr }
  }
  try {
    const ref = await api.call(`/git/ref/${job.ref.slice(5).split('/').map(encode).join('/')}`)
    return { current: ref.object.sha === job.head }
  } catch (error) { if (error.status === 404) return { current: false }; throw error }
}
export async function collectSource(job, api, pr) {
  let base = job.base
  if (/^0+$/.test(base)) {
    const ref = await api.call(`/git/ref/heads/${api.repo.default_branch.split('/').map(encode).join('/')}`)
    base = ref.object.sha
    if (base === job.head) throw new Error('An initial default-branch snapshot requires a full-tree review; use the Actions check.')
  }
  let changed
  if (job.kind === 'pr') {
    if (!Number.isInteger(pr.changed_files) || pr.changed_files > 300) throw new Error('PR file-list coverage exceeds the 300-file budget')
    changed = []
    for (let page = 1; changed.length < pr.changed_files; page++) {
      const batch = await api.call(`/pulls/${job.number}/files?per_page=100&page=${page}`)
      if (!batch.length || page > 3) throw new Error('PR file-list coverage is incomplete')
      changed.push(...batch)
    }
    if (changed.length !== pr.changed_files) throw new Error('PR changed while source was collected')
  } else {
    const comparison = await api.call(`/compare/${base}...${job.head}`)
    changed = comparison.files
    if (!Array.isArray(changed) || changed.length >= 300) throw new Error('Push comparison coverage may be truncated')
  }
  // GitHub's contents API can dereference symlinks. Verify tree modes and blob
  // identities directly so a symlink can never masquerade as reviewed UI/policy.
  const trees = new Map()
  async function entryAt(revision, path) {
    let treeSha = revision
    const parts = path.split('/')
    if (parts.length > 30 || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe source path')
    for (let i = 0; i < parts.length; i++) {
      if (!trees.has(treeSha)) {
        if (trees.size >= 100) throw new Error('Source tree traversal exceeded the review budget')
        const tree = await api.call(`/git/trees/${treeSha}`)
        if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Source tree coverage is incomplete')
        trees.set(treeSha, tree.tree)
      }
      const entry = trees.get(treeSha).find(item => item.path === parts[i])
      if (!entry) return null
      if (i === parts.length - 1) return entry
      if (entry.type !== 'tree' || entry.mode !== '040000') throw new Error('Source path traverses a non-directory')
      treeSha = entry.sha
    }
  }
  let policy = {}
  const policyEntry = await entryAt(base, '.ceramic-review.json')
  if (policyEntry) {
    if (policyEntry.type !== 'blob' || !['100644','100755'].includes(policyEntry.mode)) throw new Error('Invalid base policy')
    const file = await api.call(`/git/blobs/${policyEntry.sha}`)
    if (file.encoding !== 'base64' || file.size > 16_384) throw new Error('Invalid base policy')
    policy = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
  }
  const relevant = changed.filter(file => file.status !== 'removed' && [sourceExtensions, unsupportedUiExtensions].some(set => set.has('.' + file.filename.split('.').at(-1).toLowerCase())))
  if (relevant.length > 20) throw new Error('Managed reviews currently allow 20 changed source files; larger coverage is blocked')
  let bytes = 0
  const files = []
  for (const file of relevant) {
    if (typeof file.patch !== 'string' || !/^[a-f0-9]{40}$/.test(file.sha)) throw new Error('A changed source diff is missing; no partial approval is issued')
    const entry = await entryAt(job.head, file.filename)
    if (!entry || entry.type !== 'blob' || !['100644','100755'].includes(entry.mode) || entry.sha !== file.sha) throw new Error('Changed source is a symlink, submodule or mismatched blob')
    const blob = await api.call(`/git/blobs/${file.sha}`)
    if (blob.encoding !== 'base64' || blob.size > 128 * 1024) throw new Error('Changed source exceeds the 128 KiB file budget')
    const content = Buffer.from(blob.content, 'base64').toString('utf8')
    bytes += Buffer.byteLength(content)
    if (bytes > 450 * 1024) throw new Error('Changed source exceeds the managed payload budget')
    const changedLines = addedLineRanges(file.patch)
    if (!changedLines.length) throw new Error('Changed source has no reviewable diff ranges')
    files.push({ path: file.filename, content, changedLines })
  }
  return { files, policy, base, changed }
}
