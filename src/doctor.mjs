import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

export async function runDoctor(projectRoot) {
  const local = resolve(projectRoot, 'packages/design-system-cli/lib/api.mjs')
  const api = existsSync(local) ? await import(pathToFileURL(local).href) : await import('@utopia-studio-design/design-system-cli/api')
  return { scope: existsSync(local) ? 'project Ceramic library' : 'installed Ceramic library (not target application)', ...await api.repositoryDoctor() }
}

export function runCommand(program, args, { cwd, timeoutMs = 120_000, signal } = {}) {
  return new Promise(resolveResult => {
    if (signal?.aborted) return resolveResult({ status: 'blocked', message: 'QA cancelled.' })
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let stdout = '', stderr = '', timedOut = false
    const stop = () => { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch {} }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    signal?.addEventListener('abort', stop, { once: true })
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop) }
    child.stdout.on('data', c => { stdout = (stdout + c).slice(-100_000) })
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-100_000) })
    child.on('error', () => { cleanup(); resolveResult({ status: 'blocked', exitCode: null, message: 'Could not launch the QA command.', stdout, stderr }) })
    child.on('close', code => { cleanup(); resolveResult({ status: timedOut || signal?.aborted ? 'blocked' : code === 0 ? 'passed' : 'failed', exitCode: code, timedOut, stdout, stderr }) })
  })
}

export async function runProjectQa(projectRoot, mode, signal) {
  if (mode === 'none') return { status: 'skipped', message: 'Project QA gate was not requested.' }
  const script = resolve(projectRoot, '.agents/skills/design-system-ux-qa/scripts/run-qa.mjs')
  if (!existsSync(script)) return { status: 'blocked', message: 'The existing Ceramic QA runner is not installed in this project.' }
  return { command: ['node', '.agents/skills/design-system-ux-qa/scripts/run-qa.mjs', mode, '--json'], ...await runCommand(process.execPath, [script, mode, '--json'], { cwd: projectRoot, timeoutMs: 300_000, signal }) }
}
