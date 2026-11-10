import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifySignature, fingerprint, reviewEvent } from './events.mjs'
import { ReviewStore } from './store.mjs'
import { createGithub } from './github.mjs'
import { executeJob } from './worker.mjs'

function authorized(value, token) {
  const actual = Buffer.from(value ?? ''), expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
export function createAppHandler({ store, webhookSecret, operatorToken, allowedInstallations, appId }) {
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
  return async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { service: 'ceramic-doctor-github-app', status: 'ready' })
      const history = /^\/api\/installations\/(\d+)\/reviews$/.exec(req.url ?? '')
      if (req.method === 'GET' && history) {
        if (!authorized(req.headers.authorization, operatorToken)) return json(res, 401, { error: 'Unauthorized' })
        const installation = Number(history[1])
        if (!allowedInstallations.has(installation)) return json(res, 404, { error: 'Unknown installation' })
        return json(res, 200, { reviews: store.history(installation) })
      }
      if (req.method !== 'POST' || req.url !== '/webhooks/github') return json(res, 404, { error: 'Not found' })
      let bytes = 0; const chunks = []
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 1024 * 1024) return json(res, 413, { error: 'Webhook exceeds 1 MiB' })
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      if (!verifySignature(body, req.headers['x-hub-signature-256'], webhookSecret)) return json(res, 401, { error: 'Invalid signature' })
      const event = req.headers['x-github-event']
      if (typeof event !== 'string') return json(res, 400, { error: 'Missing event' })
      const payload = JSON.parse(body), digest = fingerprint(event, body)
      if (event === 'ping') return json(res, 200, { accepted: true })
      const installation = payload.installation?.id
      if (!allowedInstallations.has(installation)) return json(res, 403, { error: 'Installation is not enabled by the operator' })
      if (event === 'installation' || event === 'installation_repositories') {
        store.transaction(() => {
          if (!store.remember(digest)) return
          if (event === 'installation' && ['deleted','suspend'].includes(payload.action)) store.revoke(installation)
          // Lifecycle restoration is deliberately operator-controlled. A delayed
          // signed creation event must not resurrect a removed installation.
          if (event === 'installation_repositories' && payload.action === 'removed') {
            for (const repo of payload.repositories_removed ?? []) if (Number.isSafeInteger(repo.id)) store.revoke(installation, repo.id)
          }
        })
        return json(res, 202, { accepted: true })
      }
      if (event === 'check_run' && payload.action === 'rerequested') {
        if (payload.check_run?.app?.id !== appId) return json(res, 202, { ignored: true })
        const original = store.find(payload.check_run.external_id, installation, payload.repository?.id)
        return json(res, 202, original ? store.enqueue(original, digest, { rerun: true }) : { ignored: true })
      }
      if (!['pull_request','push'].includes(event)) return json(res, 202, { ignored: true })
      const job = reviewEvent(event, payload)
      json(res, 202, job ? store.enqueue(job, digest) : { ignored: true })
    } catch { if (!res.headersSent) json(res, 400, { error: 'Webhook or request could not be accepted' }); else res.end() }
  }
}
export async function startApp(env = process.env) {
  const appId = Number(env.GITHUB_APP_ID), appSlug = env.GITHUB_APP_SLUG
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET, operatorToken = env.CERAMIC_DOCTOR_OPERATOR_TOKEN
  const allowedInstallations = new Set((env.GITHUB_APP_ALLOWED_INSTALLATIONS ?? '').split(',').map(Number).filter(n => Number.isSafeInteger(n) && n > 0))
  const monthlyLimit = Number(env.CERAMIC_DOCTOR_MONTHLY_REVIEWS ?? 500)
  if (!Number.isSafeInteger(appId) || appId <= 0 || !/^[a-z0-9-]+$/.test(appSlug ?? '') || !env.GITHUB_APP_PRIVATE_KEY_FILE || webhookSecret?.length < 32 || !webhookSecret || operatorToken?.length < 32 || !operatorToken || !allowedInstallations.size || !Number.isSafeInteger(monthlyLimit) || monthlyLimit < 1) throw new Error('Configure App identity, private-key file, strong webhook/operator secrets, allowed installations and a positive monthly review limit.')
  const privateKey = await readFile(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8')
  const dbPath = resolve(env.CERAMIC_DOCTOR_DATABASE ?? '.ceramic/github-app/reviews.sqlite')
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 })
  const store = new ReviewStore(dbPath, { monthlyLimit })
  const server = createServer(createAppHandler({ store, webhookSecret, operatorToken, allowedInstallations, appId }))
  server.requestTimeout = 15_000; server.headersTimeout = 10_000
  let stopped = false, busy = false
  const tick = async () => {
    if (stopped || busy) return
    busy = true
    try {
      store.cleanup()
      const job = store.claim()
      if (job) await executeJob(job, { store, appId, appSlug, github: createGithub({ appId, privateKey, signal: AbortSignal.timeout(120_000) }) })
    } finally { busy = false }
  }
  const timer = setInterval(() => { void tick().catch(() => console.error('GitHub App worker unavailable; queued work retained.')) }, 1000)
  await new Promise(resolveListen => server.listen(Number(env.PORT ?? 8787), env.HOST ?? '127.0.0.1', resolveListen))
  return { server, store, async close() { stopped = true; clearInterval(timer); await new Promise(done => server.close(done)); while (busy) await new Promise(done => setTimeout(done,100)); store.close() } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startApp()
  console.log('Ceramic Doctor GitHub App is listening; source review is deterministic and installation-scoped.')
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { void app.close() })
}
