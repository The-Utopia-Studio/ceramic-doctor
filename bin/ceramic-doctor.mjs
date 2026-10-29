#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, cp, access, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { review, verifyReview, listReviews, readReview, runDoctor } from '../src/review.mjs'

const help = `Ceramic Doctor — evidence-backed design review

ceramic-doctor doctor [--url <url>]
ceramic-doctor check [--staged | --base <ref> --head <ref>] [--format github|json] [--out <directory>]
ceramic-doctor review-files <files.json> [--out <directory>]
ceramic-doctor verify-code <report.json> --files <files.json>
ceramic-doctor init-checks
ceramic-doctor install-hooks
ceramic-doctor review <url> [--ready <selector>] [--plan <json>] [--visual codex] [--qa browser|quick|contracts]
ceramic-doctor verify <review-id>
ceramic-doctor list
ceramic-doctor report <review-id>
ceramic-doctor mcp [--project <directory>]
ceramic-doctor install-browser
ceramic-doctor install-skill [--directory <skills-directory>]

Global: --project <directory>, --json, --help
Evidence: <project>/.ceramic/design-reviews/<id>/report.{json,md} and screenshots.
Exit codes: 0 completed without blocking defects, 1 findings block acceptance, 2 execution/input blocked.
Visual review is opt-in and uses an existing Codex CLI login/allowance.
`

async function cancellable(task) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try { return await task(controller.signal) }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string' }, url: { type: 'string' }, ready: { type: 'string' }, plan: { type: 'string' }, visual: { type: 'string' }, qa: { type: 'string' },
    directory: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
    staged: { type: 'boolean' }, base: { type: 'string' }, head: { type: 'string' }, 'policy-ref': { type: 'string' }, 'fail-on': { type: 'string' }, format: { type: 'string' }, out: { type: 'string' }, files: { type: 'string' },
  } })
  const [command, argument] = positionals
  const projectRoot = resolve(values.project ?? process.cwd())
  if (values.help || !command) console.log(help)
  else if (['check', 'review-files', 'verify-code'].includes(command)) {
    const { reviewFiles, verifyCodeFixes } = await import('../src/code-review.mjs')
    const { reviewGitChanges } = await import('../src/git-review.mjs')
    const { saveCodeReport, githubAnnotations, codeExitCode } = await import('../src/code-report.mjs')
    if (values.format && !['github', 'json'].includes(values.format)) throw new Error('Code report format must be github or json.')
    let report, root = projectRoot
    if (command === 'check') ({ report, root } = await reviewGitChanges({ projectRoot, staged: values.staged, base: values.base, head: values.head, policyRef: values['policy-ref'], failOn: values['fail-on'] }))
    else if (command === 'review-files') {
      const input = JSON.parse(await readFile(resolve(argument), 'utf8'))
      report = reviewFiles(Array.isArray(input) ? { files: input, failOn: values['fail-on'] } : input)
    } else {
      if (!values.files) throw new Error('verify-code requires --files with updated whole-file contents.')
      const input = JSON.parse(await readFile(resolve(values.files), 'utf8'))
      report = verifyCodeFixes({ previous: JSON.parse(await readFile(resolve(argument), 'utf8')), files: Array.isArray(input) ? input : input.files })
    }
    const directory = await saveCodeReport(report, { projectRoot: root, outputDirectory: values.out, github: values.format === 'github' })
    if (values.format === 'github') for (const annotation of githubAnnotations(report)) console.log(annotation)
    if (values.json || values.format === 'json') console.log(JSON.stringify(report, null, 2))
    else console.log(`${report.verdict} — ${report.findings.length} code findings; execution ${report.execution}\nReport: ${join(directory, 'report.md')}`)
    process.exitCode = codeExitCode(report)
  } else if (command === 'init-checks' || command === 'install-hooks') {
    const { initCodeWorkflow, installCodeHooks } = await import('../src/code-integration.mjs')
    console.log(JSON.stringify(await (command === 'init-checks' ? initCodeWorkflow(projectRoot) : installCodeHooks(projectRoot)), null, 2))
  }
  else if (command === 'mcp') {
    const { startMcp } = await import('../src/mcp.mjs')
    await startMcp(projectRoot)
  } else if (command === 'install-browser') {
    const playwrightCli = fileURLToPath(new URL('./cli.js', import.meta.resolve('playwright/package.json')))
    const child = spawn(process.execPath, [playwrightCli, 'install', 'chromium'], { stdio: 'inherit' })
    process.exitCode = await new Promise(resolveCode => { child.on('close', code => resolveCode(code ?? 2)); child.on('error', () => resolveCode(2)) })
  } else if (command === 'install-skill') {
    const root = resolve(values.directory ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills'))
    const destination = join(root, 'ceramic-doctor')
    const exists = await access(destination).then(() => true, () => false)
    if (exists) throw new Error(`Skill already exists at ${destination}. Review it before replacing it.`)
    await mkdir(root, { recursive: true })
    await cp(fileURLToPath(new URL('../skills/ceramic-doctor', import.meta.url)), destination, { recursive: true, errorOnExist: true, force: false })
    console.log(`Installed ${destination}. Reopen the agent session to discover $ceramic-doctor.`)
  } else {
    let result
    if (command === 'review' || command === 'doctor' && values.url) {
      const plan = values.plan ? JSON.parse(await readFile(resolve(values.plan), 'utf8')) : {}
      result = await cancellable(signal => review({ ...plan, url: values.url ?? argument, ...(values.ready ? { readySelector: values.ready } : {}), ...(values.visual ? { visual: values.visual } : {}), ...(values.qa ? { qa: values.qa } : {}) }, { projectRoot, signal }))
    } else if (command === 'doctor') result = await runDoctor(projectRoot)
    else if (command === 'verify') result = await cancellable(signal => verifyReview(argument, { projectRoot, signal }))
    else if (command === 'list') result = await listReviews(projectRoot)
    else if (command === 'report') result = await readReview(argument, projectRoot)
    else throw new Error(`Unknown command: ${command}. Use --help.`)
    if (values.json || !result.verdict) console.log(JSON.stringify(result, null, 2))
    else console.log(`${result.verdict} — ${result.findings.length} findings; execution ${result.execution}\nTechnical score: ${result.score.value ?? 'unavailable'}\nReview: ${result.id}\nReport: ${result.artifacts.markdown}`)
    if (result.execution && result.execution !== 'completed') process.exitCode = 2
    else if (result.verdict === 'FAIL' || result.ok === false) process.exitCode = 1
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }))
  process.exitCode = 2
}
