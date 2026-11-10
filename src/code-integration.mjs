import { execFileSync } from 'node:child_process'
import { access, mkdir, writeFile, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function codeWorkflow() {
  return `name: Ceramic Doctor code review
on:
  pull_request:
  push:
    branches: ['**']
  workflow_dispatch:
    inputs:
      base:
        description: Full base commit SHA to compare
        required: true
      head:
        description: Full head commit SHA to inspect
        required: true
permissions:
  contents: read
concurrency:
  # Keep the PR check independent of the push check on the same branch.
  group: ceramic-doctor-\${{ github.workflow }}-\${{ github.event_name }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
jobs:
  code-review:
    name: Ceramic Doctor / code changes
    if: github.event.deleted != true
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Start usage measurement
        id: usage
        shell: bash
        run: echo "started=$(date +%s)" >> "$GITHUB_OUTPUT"
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: \${{ inputs.head || github.event.pull_request.head.sha || github.sha }}
      - name: Resolve review commits
        id: scope
        shell: bash
        env:
          CD_BASE: \${{ inputs.base || github.event.pull_request.base.sha || github.event.before }}
          CD_DEFAULT_BRANCH: \${{ github.event.repository.default_branch }}
          CD_REF: \${{ github.ref }}
        run: |
          # A new feature branch has no previous SHA. Compare with the default
          # branch instead of reviewing the entire repository as newly added.
          if [[ "$CD_BASE" =~ ^0{40,64}$ && "$CD_REF" != "refs/heads/$CD_DEFAULT_BRANCH" ]]; then
            CD_BASE=$(git rev-parse --verify --end-of-options "refs/remotes/origin/$CD_DEFAULT_BRANCH^{commit}")
          fi
          echo "base=$CD_BASE" >> "$GITHUB_OUTPUT"
          echo "head=$(git rev-parse --verify HEAD)" >> "$GITHUB_OUTPUT"
      - uses: The-Utopia-Studio/ceramic-doctor@ea165cd066dfd991038e72ce045993b5f3511b7e # v0.3.1
        with:
          base: \${{ steps.scope.outputs.base }}
          head: \${{ steps.scope.outputs.head }}
      - name: Summarize estimated runner cost
        if: always() && steps.usage.outputs.started != ''
        shell: bash
        env:
          CD_STARTED: \${{ steps.usage.outputs.started }}
        run: |
          elapsed=$(( $(date +%s) - CD_STARTED ))
          minutes=$(( (elapsed + 59) / 60 ))
          estimate=$(awk -v minutes="$minutes" 'BEGIN { printf "%.3f", minutes * 0.006 }')
          {
            echo '### Runner usage estimate'
            echo "Measured step window: $elapsed seconds; rounded estimate: $minutes Linux minutes."
            echo "Gross compute estimate: USD $estimate at USD 0.006/minute (rate checked 2026-11-10)."
            echo 'This is not an invoice. Runner startup/cleanup, storage, allowances and discounts are excluded. Standard public-repository runners are free.'
            echo 'Push and PR events are separate runs; count both. Cancelled or timed-out jobs may have no summary but can still incur usage.'
          } >> "$GITHUB_STEP_SUMMARY"
`
}

export async function initCodeWorkflow(projectRoot) {
  const path = resolve(projectRoot, '.github/workflows/ceramic-doctor.yml')
  await mkdir(resolve(projectRoot, '.github/workflows'), { recursive: true })
  await writeFile(path, codeWorkflow(), { flag: 'wx' })
  return { path, message: 'Workflow created. Commit it to enable PR checks. Making the check required for merge is a repository rules setting.' }
}

const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'"
export async function installCodeHooks(projectRoot) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot, encoding: 'utf8' }).trim()
  let custom = ''
  try { custom = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch (error) { if (error.status !== 1) throw error }
  if (custom) throw new Error('A custom core.hooksPath is configured. Add ceramic-doctor check to the existing hook manager instead.')
  return installAtDefault(root)
}

async function installAtDefault(root) {
  const hooks = resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' }).trim())
  const helper = join(hooks, 'ceramic-doctor-hooks.cjs')
  const paths = [helper, join(hooks, 'pre-commit'), join(hooks, 'pre-push')]
  for (const path of paths) if (await access(path).then(() => true, () => false)) throw new Error('An existing Git hook would be overwritten. Keep it and add the Ceramic check command manually.')
  const cli = fileURLToPath(new URL('../bin/ceramic-doctor.mjs', import.meta.url))
  const source = `// Installed by Ceramic Doctor. Remove only these owned hook files to uninstall.\nconst {spawnSync}=require('node:child_process');\nconst {readFileSync}=require('node:fs');\nconst run=args=>{const result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},'check','--project',${JSON.stringify(root)},...args],{stdio:'inherit'});if(result.status!==0)process.exit(result.status??2)};\nif(process.argv[2]==='pre-commit')run(['--staged']);\nelse for(const line of readFileSync(0,'utf8').split('\\n').filter(Boolean)){const parts=line.trim().split(/\\s+/);const local=parts[1],remote=parts[3];if(!/^[a-f0-9]{40,64}$/.test(local||'')||!/^[a-f0-9]{40,64}$/.test(remote||''))process.exit(2);if(!/^0+$/.test(local))run(['--base',remote,'--head',local])}\n`
  const created = []
  try {
    await mkdir(hooks, { recursive: true })
    await writeFile(helper, source, { flag: 'wx', mode: 0o700 }); created.push(helper)
    for (const name of ['pre-commit', 'pre-push']) {
      const path = join(hooks, name)
      await writeFile(path, `#!/bin/sh\n# Installed by Ceramic Doctor\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(name)} "$@"\n`, { flag: 'wx', mode: 0o755 }); created.push(path)
    }
    return { paths: created, message: 'Repository-only pre-commit and pre-push checks installed. Existing hooks and global Git settings were not replaced.' }
  } catch (error) { await Promise.all(created.map(path => unlink(path).catch(() => {}))); throw error }
}
