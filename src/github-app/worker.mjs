import { reviewRenderedJob } from './render.mjs'
import { technicalScore } from '../contracts.mjs'
import { runCodeTool } from '../code-tools.mjs'
import { codeMarkdown } from '../code-report.mjs'
import { currentScope, collectSource } from './github.mjs'

const name = 'Ceramic Doctor / managed review'
const quiet = value => String(value).replace(/@/g, '@\u200b')
const bodyFor = report => quiet(codeMarkdown(report)).slice(0, 55_000)
const marker = '<!-- ceramic-doctor:summary:v1 -->'
export async function executeJob(job, { store, github, appId, appSlug, review = input => runCodeTool('review_files', input), now = Date.now, previewConfigurations = [], render = reviewRenderedJob }) {
  const started = now(); let api, checkId = job.check_id
  const active = () => store.active(job)
  const update = body => checkId && api.call(`/check-runs/${checkId}`, { method: 'PATCH', body })
  const complete = (conclusion, summary) => update({ status: 'completed', conclusion, completed_at: new Date().toISOString(), output: { title: `Ceramic Doctor — ${conclusion}`, summary } })
  try {
    if (!active()) return
    api = await github.installation(job)
    let scope = await currentScope(job, api)
    // Recover a check created before a process crash, instead of creating duplicates.
    if (!checkId) {
      const checks = await api.call(`/commits/${job.head}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`)
      checkId = checks.check_runs?.find(check => check.external_id === job.id && check.app?.id === appId)?.id
    }
    if (!checkId && scope.current) {
      const check = await api.call('/check-runs', { method: 'POST', body: { name, head_sha: job.head, external_id: job.id, status: 'in_progress', started_at: new Date().toISOString(), output: { title: 'Reviewing changed UI source', summary: 'Source is parsed as data in a bounded worker. Source is never executed. Authorized commit previews are checked separately in isolated Chromium.' } } })
      checkId = check.id
    }
    if (checkId) store.check(job, checkId)
    if (!scope.current || !active()) {
      await complete('cancelled', 'Superseded, closed or removed before review.')
      return store.finish(job, 'cancelled', { durationMs: now() - started })
    }
    if (job.attempts > 3 || store.quotaExceeded(job)) {
      await complete('action_required', 'Review budget exhausted. No passing result was issued. An operator must adjust the budget or resolve repeated failures, then request a rerun.')
      return store.finish(job, 'blocked', { error: 'Review budget exhausted', durationMs: now() - started })
    }
    const source = await collectSource(job, api, scope.pr)
    const report = await review({ files: source.files, policy: source.policy })
    report.sourceResult = { execution: report.execution, verdict: report.verdict, score: report.score }
    if (report.coverage.some(cell => cell.relevant || cell.status === 'blocked')) {
      report.rendered = await render(job, api, previewConfigurations)
      const allFindings = [...report.findings, ...report.rendered.findings]
      const complete = report.execution === 'completed' && report.rendered.execution === 'completed'
      report.execution = complete ? 'completed' : 'partial'
      report.score = technicalScore(allFindings, complete)
      report.verdict = allFindings.some(f => ['critical','serious'].includes(f.severity)) ? 'FAIL' : !complete ? 'BLOCKED' : allFindings.length ? 'PASS WITH RISKS' : 'PASS'
      report.limits.push('Managed result combines source checks with the explicitly configured rendered routes. A source-only score never approves rendered UI.')
    }
    report.context = { installation: job.installation, repository: job.repository, base: source.base, head: job.head, policyRevision: source.base }
    if (!active() || !(await currentScope(job, api)).current) {
      await complete('cancelled', 'The source head or policy base changed while this review was running.')
      return store.finish(job, 'cancelled', { durationMs: now() - started })
    }
    const summary = bodyFor(report)
    // Summary updates are idempotent across retry; only comments owned by this App count.
    if (job.kind === 'pr') {
      let comments = []
      for (let page = 1; page <= 10; page++) {
        const batch = await api.call(`/issues/${job.number}/comments?per_page=100&page=${page}`)
        comments.push(...batch)
        if (batch.length < 100) break
        if (page === 10) throw new Error('PR comment history exceeds the publication budget')
      }
      const existing = comments.find(c => c.user?.login === `${appSlug}[bot]` && c.body?.startsWith(marker))
      const body = { body: `${marker}\n${summary}` }
      if (!active() || !(await currentScope(job, api)).current) throw new Error('Review superseded before publication')
      await api.call(existing ? `/issues/comments/${existing.id}` : `/issues/${job.number}/comments`, { method: existing ? 'PATCH' : 'POST', body })
      // Checks annotations supply inline file/line feedback without noisy duplicate
      // PR review threads. The full report retains all findings, beyond the 50 cap.
    }
    if (!active() || !(await currentScope(job, api)).current) {
      await complete('cancelled', 'Review superseded before check completion.')
      return store.finish(job, 'cancelled', { durationMs: now() - started })
    }
    const annotations = report.findings.slice(0, 50).map(f => ({ path: f.file, start_line: f.line, end_line: f.line, annotation_level: ['critical','serious'].includes(f.severity) ? 'failure' : 'warning', title: quiet(f.rule).slice(0,255), message: quiet(`${f.title}\n${f.fix}`).slice(0,4000) }))
    // Do not duplicate annotations on retry after a successful completion whose
    // response was lost. Reusing the same check also preserves its exact head.
    const previous = await api.call(`/check-runs/${checkId}`)
    const conclusion = report.execution !== 'completed' || report.verdict === 'BLOCKED' ? 'action_required' : report.verdict === 'FAIL' ? 'failure' : report.verdict === 'SKIP' ? 'neutral' : 'success'
    await update({ status: 'completed', conclusion, completed_at: new Date().toISOString(), output: { title: `Ceramic Doctor — ${report.verdict}`, summary, ...(previous.output?.annotations_count ? {} : { annotations }) } })
    store.finish(job, 'completed', { report, durationMs: now() - started })
  } catch (error) {
    const transient = error.status === 429 || error.status >= 500 || error.status === 403 && error.retryAfter || ['TypeError', 'TimeoutError', 'AbortError', 'PreviewPendingError'].includes(error.name)
    const message = error.status ? `GitHub API ${error.status}` : String(error.message).slice(0,300)
    if (transient && job.attempts < 3 && active()) {
      store.retry(job, message, error.retryAfter || 30_000 * 2 ** (job.attempts - 1), now() - started)
      return
    }
    // Publication failure is never converted into success. A retry can recover an
    // in-progress check if GitHub was unavailable even for this final update.
    try { await complete('action_required', 'Review or publication could not complete. No approval was issued. Consult the operator review record and request a rerun.') } catch {}
    store.finish(job, 'blocked', { error: message, durationMs: now() - started })
  }
}
