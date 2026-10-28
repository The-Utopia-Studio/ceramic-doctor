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
  } })
  const [command, argument] = positionals
  const projectRoot = resolve(values.project ?? process.cwd())
  if (values.help || !command) console.log(help)
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
