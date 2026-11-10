import { chromium } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectScenario } from '../browser.mjs'
import { mergeFindings, technicalScore, viewports } from '../contracts.mjs'
import { createPublicNetworkPolicy, resolvePublicUrl } from '../public-network.mjs'

export class PreviewPendingError extends Error {
  constructor() { super('Waiting for a successful authorized deployment of this head.'); this.name = 'PreviewPendingError'; this.retryAfter = 30_000 }
}
export function previewConfiguration(raw = '[]') {
  const configurations = JSON.parse(raw), keys = new Set()
  if (!Array.isArray(configurations) || configurations.length > 100) throw new Error('Preview configuration must be an array of at most 100 repositories.')
  for (const config of configurations) {
    if (!config || Object.keys(config).some(k => !['installation','repository','environment','origins','creatorIds','paths','readySelector'].includes(k)) || ![config.installation, config.repository].every(n => Number.isSafeInteger(n) && n > 0) || typeof config.environment !== 'string' || !config.environment || config.environment.length > 100) throw new Error('Invalid preview repository/environment.')
    const key = `${config.installation}:${config.repository}`
    if (keys.has(key)) throw new Error('Duplicate preview repository.')
    keys.add(key)
    if (!Array.isArray(config.origins) || !config.origins.length || config.origins.length > 20 || config.origins.some(origin => { const u = new URL(origin); return u.protocol !== 'https:' || u.hostname.includes('*') || u.origin !== origin || u.username || u.password || u.port })) throw new Error('Preview origins must be explicit HTTPS origins without wildcards.')
    if (!Array.isArray(config.creatorIds) || !config.creatorIds.length || config.creatorIds.length > 20 || config.creatorIds.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('Allowlist the deployment publisher IDs.')
    if (!Array.isArray(config.paths) || !config.paths.length || config.paths.length > 2 || config.paths.some(path => typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\?#\x00-\x20]/.test(path) || new URL(path,'https://preview.example').pathname !== path)) throw new Error('Configure one or two normalized preview paths without queries.')
    if (typeof config.readySelector !== 'string' || !config.readySelector || config.readySelector.length > 500) throw new Error('Configure an explicit rendered readiness selector.')
  }
  return configurations
}
export async function resolvePreview(job, api, config) {
  const deployments = await api.call(`/deployments?sha=${job.head}&environment=${encodeURIComponent(config.environment)}&per_page=100`)
  if (!Array.isArray(deployments) || deployments.length === 100) throw new Error('Deployment coverage is incomplete.')
  const candidates = deployments.filter(d => d.sha === job.head && d.environment === config.environment && config.creatorIds.includes(d.creator?.id) && Number.isSafeInteger(d.id) && d.id > 0).sort((a,b) => b.id-a.id)
  // Never fall back to an older successful deployment when the latest is pending.
  const deployment = candidates[0]
  if (!deployment) throw new PreviewPendingError()
  const statuses = await api.call(`/deployments/${deployment.id}/statuses?per_page=1`)
  const status = statuses[0]
  if (!status || ['queued','pending','in_progress'].includes(status.state)) throw new PreviewPendingError()
  if (status.state !== 'success' || !config.creatorIds.includes(status.creator?.id)) throw new Error('Latest preview deployment is unsuccessful or has an unauthorized publisher.')
  const url = new URL(status.environment_url)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !config.origins.includes(url.origin)) throw new Error('Preview URL is outside the operator allowlist.')
  return { deploymentId: deployment.id, statusId: status.id, origin: url.origin, head: job.head }
}
export async function renderPreview(preview, config, {
  browserLauncher = () => chromium.launch({ headless: true, chromiumSandbox: true,
    env: Object.fromEntries(['PATH','HOME','TMPDIR','PLAYWRIGHT_BROWSERS_PATH'].filter(k => process.env[k]).map(k => [k,process.env[k]])),
    args: ['--disable-quic','--disable-background-networking','--dns-prefetch-disable','--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }),
  contextPolicy = createPublicNetworkPolicy(), validateUrl = resolvePublicUrl, timeoutMs = 60_000,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(),'ceramic-app-render-'))
  let browser, timer, expired = false
  const result = { execution: 'partial', verdict: 'BLOCKED', score: technicalScore([],false), deployment: preview, findings: [], coverage: [],
    limits: ['Rendered checks cover only the configured routes at 1440px and 390px, with reduced motion requested. They do not certify all states, themes, screen readers or design quality.', 'Preview JavaScript runs only in isolated Chromium; repository builds, scripts and modules are never executed by the service. No credentials are injected.', 'Screenshots and page observations are temporary and deleted after review; retained reports contain bounded findings and coverage only.'] }
  try {
    const deadline = new Promise((_,reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Rendered review timed out.')); void browser?.close().catch(()=>{}) },timeoutMs) })
    const bounded = promise => Promise.race([promise,deadline])
    browser = await bounded(Promise.resolve().then(browserLauncher).then(async instance => {
      if (expired) { await instance.close(); throw new Error('Rendered review timed out.') }
      return instance
    }))
    if (expired) throw new Error('Rendered review timed out.')
    for (const [index,path] of config.paths.entries()) for (const viewport of viewports) {
      if (expired) throw new Error('Rendered review timed out.')
      const url = new URL(path, preview.origin).href
      await bounded(validateUrl(url))
      const screen = await bounded(inspectScenario(browser, { url, timeoutMs: 10_000, readySelector: config.readySelector, expectedCommit: preview.head, expectedOrigin: preview.origin }, { id: `route-${index+1}`, actions: [], reducedMotion: 'reduce' }, viewport, directory, contextPolicy))
      const incomplete = screen.coverage.incomplete?.filter(item => ['color-contrast','label','select-name'].includes(item.rule)) ?? []
      const coverage = { scenario: screen.coverage.scenario, viewport: viewport.id, path, status: screen.coverage.status, checks: screen.coverage.checks,
        ...(screen.coverage.message ? { reason: screen.coverage.message } : {}), incomplete }
      if (screen.failedRequests.length || incomplete.length) { coverage.status = 'blocked'; coverage.reason = 'Resource failures or incomplete accessibility checks prevent rendered approval.' }
      result.coverage.push(coverage)
      result.findings.push(...screen.findings.map(f => ({ ...f, evidence: f.evidence.map(({screenshot,...evidence})=>evidence) })))
    }
    result.findings = mergeFindings(result.findings)
    const complete = result.coverage.length === config.paths.length * viewports.length && result.coverage.every(c=>c.status==='completed')
    result.execution = complete ? 'completed' : 'partial'
    result.score = technicalScore(result.findings,complete)
    result.verdict = result.findings.some(f=>['critical','serious'].includes(f.severity)) ? 'FAIL' : !complete ? 'BLOCKED' : result.findings.length ? 'PASS WITH RISKS' : 'PASS'
  } catch (error) { result.reason = expired ? `Rendered review exceeded its ${timeoutMs}-millisecond budget.` : String(error.message).slice(0,500) }
  finally { clearTimeout(timer); await browser?.close().catch(()=>{}); await rm(directory,{recursive:true,force:true}) }
  return result
}
export async function reviewRenderedJob(job, api, configurations, options) {
  const config = configurations.find(c=>c.installation===job.installation && c.repository===job.repository)
  if (!config) return { execution:'partial', verdict:'BLOCKED', score:technicalScore([],false), findings:[], coverage:[], reason:'Configure an authorized preview deployment and routes for this repository. Source-only results cannot approve rendered UI.' }
  const preview = await resolvePreview(job,api,config)
  const result = await renderPreview(preview,config,options)
  const latest = await resolvePreview(job,api,config)
  if (latest.deploymentId !== preview.deploymentId || latest.statusId !== preview.statusId || latest.origin !== preview.origin) return { ...result,execution:'partial',verdict:'BLOCKED',score:technicalScore([],false),reason:'Deployment changed during rendered review.' }
  return result
}
