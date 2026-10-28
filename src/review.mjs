import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { normalizeInput, scopeHash, viewports, finding, mergeFindings, technicalScore, verifyFindings } from './contracts.mjs'
import { runDoctor, runProjectQa } from './doctor.mjs'
import { launchBrowser, inspectScenario } from './browser.mjs'
import { codexVisualReview } from './model.mjs'

export { runDoctor, normalizeInput, verifyFindings }

export async function review(input, { projectRoot = process.cwd(), baseline, visualJudge = codexVisualReview, signal, browserLauncher = launchBrowser, contextPolicy } = {}) {
  signal?.throwIfAborted()
  input = normalizeInput(input)
  if (baseline && baseline.scopeHash !== scopeHash(input)) throw new Error('Verification scope differs from the original review.')
  const id = randomUUID(), directory = resolve(projectRoot, '.ceramic/design-reviews', id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const report = { schemaVersion: 1, id, startedAt: new Date().toISOString(), input, scopeHash: scopeHash(input),
    execution: 'running', verdict: 'BLOCKED', score: { value: null, kind: 'automated', rubric: 'ceramic-technical-v1' },
    doctor: null, projectQa: null, visual: input.visual === 'codex' ? { status: 'pending' } : { status: 'skipped', message: 'Visual judgement was not requested.' }, coverage: [], findings: [], artifacts: { directory, report: join(directory, 'report.json'), markdown: join(directory, 'report.md') },
    limitations: [
      'Only the listed scenarios and desktop/mobile Chromium viewports are covered.',
      'Tab samples are evidence of focus movement, not a complete keyboard or screen-reader audit.',
      'Loading, empty, error, RTL and other themes require explicit scenarios. Forced dir is a layout probe, not native Arabic coverage.',
      'Technical score measures automated defects under ceramic-technical-v1; it is not a taste score or publishing approval.',
      'No source repair is applied. Fix proposals require a scoped edit followed by verify.',
    ] }
  const persist = async () => {
    await writeFile(join(directory, 'report.tmp'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    await rename(join(directory, 'report.tmp'), report.artifacts.report)
    await writeFile(report.artifacts.markdown, markdownReport(report), { mode: 0o600 })
  }
  await persist()
  try {
    try {
      report.doctor = await runDoctor(projectRoot)
      report.coverage.push({ scenario: 'library', viewport: 'library', status: 'completed', checks: ['doctor-contract'] })
      if (!report.doctor.ok) report.findings.push(finding({ rule: 'doctor-contract', category: 'contract', severity: 'serious', title: 'Ceramic library contract failed', evidence: { viewport: 'library', detail: report.doctor.missing?.join('\n') }, fix: 'Repair the missing registered manifest/document or contract. Re-run Doctor.' }))
    } catch (error) { report.doctor = { ok: false, status: 'blocked', message: error.message }; report.coverage.push({ scenario: 'library', viewport: 'library', status: 'blocked', checks: [] }) }
    report.projectQa = await runProjectQa(projectRoot, input.qa, signal)
    if (input.qa !== 'none') {
      report.coverage.push({ scenario: 'project-qa', viewport: 'project-qa', status: report.projectQa.status === 'blocked' ? 'blocked' : 'completed', checks: report.projectQa.status === 'blocked' ? [] : ['project-qa'] })
      if (report.projectQa.status === 'failed') report.findings.push(finding({ rule: 'project-qa', category: 'project-qa', severity: 'serious', title: 'Existing project QA gate failed', scenario: 'project-qa', evidence: { viewport: 'project-qa', detail: 'See projectQa stdout/stderr in report.json.' }, fix: 'Use the preserved QA output to reproduce the failed test and fix its owning source. Baselines are never updated by this review.' }))
    }
    await persist()
    let browser
    const screens = []
    const closeBrowser = () => { void browser?.close().catch(() => {}) }
    signal?.addEventListener('abort', closeBrowser, { once: true })
    try {
      signal?.throwIfAborted()
      browser = await browserLauncher()
      for (const scenario of input.scenarios) for (const viewport of viewports) {
        signal?.throwIfAborted()
        const screen = await inspectScenario(browser, input, scenario, viewport, directory, contextPolicy)
        screens.push(screen)
        report.coverage.push(screen.coverage)
        report.findings.push(...screen.findings)
        await writeFile(join(directory, `${scenario.id}-${viewport.id}.json`), JSON.stringify(screen, null, 2) + '\n', { mode: 0o600 })
        await persist()
      }
    } catch (error) {
      report.browserError = `Could not start Chromium. Run ceramic-doctor install-browser. ${String(error.message).slice(0, 1000)}`
      for (const scenario of input.scenarios) for (const viewport of viewports) if (!report.coverage.some(c => c.scenario === scenario.id && c.viewport === viewport.id)) report.coverage.push({ scenario: scenario.id, viewport: viewport.id, status: 'blocked', checks: [], message: report.browserError })
    } finally { signal?.removeEventListener('abort', closeBrowser); await browser?.close().catch(() => {}) }
    signal?.throwIfAborted()
    if (input.visual === 'codex') {
      const captured = screens.filter(s => s.coverage.status === 'completed')
      if (captured.length) {
        try {
          report.visual = { status: 'running' }
          await persist()
          const result = await visualJudge(captured, directory, signal)
          report.visual = { ...result, findings: undefined, screensReviewed: captured.map(s => `${s.coverage.scenario}/${s.coverage.viewport}`) }
          report.findings.push(...result.findings)
        } catch (error) { report.visual = { status: 'blocked', message: error.message } }
      } else report.visual = { status: 'blocked', message: 'No completed browser evidence is available for visual judgement.' }
    }
    signal?.throwIfAborted()
    report.findings = mergeFindings(report.findings)
    const complete = report.coverage.every(c => c.status === 'completed')
    report.execution = complete && report.visual.status !== 'blocked' ? 'completed' : 'partial'
    report.score = technicalScore(report.findings, complete)
    const blockers = report.findings.some(f => f.source === 'automated' && ['critical', 'serious'].includes(f.severity))
    const incomplete = report.coverage.some(c => c.incomplete?.length)
    report.verdict = blockers ? 'FAIL' : report.execution !== 'completed' ? 'BLOCKED' : report.findings.length || incomplete || report.visual.status === 'skipped' || input.qa === 'none' ? 'PASS WITH RISKS' : 'PASS'
    if (baseline) {
      report.baselineId = baseline.id
      report.verification = verifyFindings(baseline, report)
    }
    return report
  } catch (error) {
    report.execution = 'interrupted'
    report.error = signal?.aborted ? 'Review cancelled. Completed evidence is preserved.' : String(error.message).slice(0, 1000)
    return report
  } finally { report.finishedAt = new Date().toISOString(); await persist() }
}

const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export async function readReview(id, projectRoot = process.cwd()) {
  if (!validId.test(id)) throw new Error('Use a review id returned by design_review or list_reviews.')
  const report = JSON.parse(await readFile(resolve(projectRoot, '.ceramic/design-reviews', id, 'report.json'), 'utf8'))
  if (report.schemaVersion !== 1 || report.id !== id || report.scopeHash !== scopeHash(normalizeInput(report.input))) throw new Error('Invalid or incompatible review report.')
  return report
}

export async function listReviews(projectRoot = process.cwd()) {
  const entries = await readdir(resolve(projectRoot, '.ceramic/design-reviews')).catch(() => [])
  const reports = await Promise.all(entries.filter(id => validId.test(id)).map(id => readReview(id, projectRoot).catch(() => null)))
  return reports.filter(Boolean).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20).map(r => ({ id: r.id, url: r.input.url, verdict: r.verdict, execution: r.execution, startedAt: r.startedAt, findings: r.findings.length }))
}

export async function verifyReview(id, options = {}) {
  const baseline = await readReview(id, options.projectRoot)
  if (!['completed', 'partial'].includes(baseline.execution)) throw new Error('This review did not finish. Run a new review.')
  return review(baseline.input, { ...options, baseline })
}

export function markdownReport(report) {
  const clean = value => String(value ?? '').replace(/[\r\n|]/g, ' ')
  return `${report.verdict} — Ceramic Design Review\n\nExecution: ${report.execution}\nURL: ${report.input.url}\nReview: ${report.id}\nTechnical score: ${report.score.value ?? 'unavailable'} (${report.score.rubric})\nVisual review: ${report.visual.status}\n\n## Findings\n\n${report.findings.length ? report.findings.map(f => `### ${f.severity} — ${clean(f.title)}\n\nID: ${f.id} · ${f.source} · ${f.rule}\nLocation: ${clean(f.scenario)} ${clean(f.selector)}\n\n${f.evidence.map(e => `- ${clean(e.viewport)}: ${clean(e.detail || e.screenshot || 'report.json')}`).join('\n')}\n\nFix proposal: ${f.fix}\n`).join('\n') : 'None observed within the executed checks.\n'}\n## Coverage\n\n| Scenario | Viewport | Execution | Checks |\n| --- | --- | --- | --- |\n${report.coverage.map(c => `| ${clean(c.scenario)} | ${clean(c.viewport)} | ${c.status} | ${c.checks.length} |`).join('\n')}\n\n${report.verification ? `## Fix verification\n\n${JSON.stringify(report.verification, null, 2)}\n\n` : ''}## Limits\n\n${report.limitations.map(l => `- ${l}`).join('\n')}\n\nEvidence and exact runtime details: report.json and per-scenario JSON/PNG files.\n`
}
