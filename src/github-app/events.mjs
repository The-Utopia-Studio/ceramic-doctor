import { createHmac, timingSafeEqual, createHash } from 'node:crypto'

export function verifySignature(body, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature ?? '')) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))
}
export const fingerprint = (event, body) => createHash('sha256').update(event).update(body).digest('hex')
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const id = value => Number.isSafeInteger(value) && value > 0

export function reviewEvent(event, payload) {
  const installation = payload.installation?.id, repo = payload.repository
  if (!id(installation) || !id(repo?.id) || !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name ?? '')) throw new Error('Invalid installation or repository')
  const job = { installation, repository: repo.id, fullName: repo.full_name }
  if (event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'ready_for_review', 'edited'].includes(payload.action)) {
    const pr = payload.pull_request
    if (!id(pr?.number) || !isSha(pr?.base?.sha) || !isSha(pr?.head?.sha) || pr.base.repo.id !== repo.id) throw new Error('Invalid PR scope')
    return { ...job, kind: 'pr', number: pr.number, base: pr.base.sha, head: pr.head.sha, scope: `pr:${pr.number}` }
  }
  if (event === 'push' && !payload.deleted && payload.ref?.startsWith('refs/heads/')) {
    if (!isSha(payload.before) || !isSha(payload.after) || payload.ref.length > 300) throw new Error('Invalid push scope')
    return { ...job, kind: 'push', ref: payload.ref, base: payload.before, head: payload.after, defaultBranch: repo.default_branch, scope: payload.ref }
  }
  return null
}
