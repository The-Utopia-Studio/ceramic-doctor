# Ceramic Doctor

Review UI code before committing, pushing to GitHub, or merging a PR. Ceramic Doctor provides an offline source checker, Git hooks, a reusable GitHub Action, remote/local MCP tools and an agent skill. Browser review remains available as a separate evidence layer.

Ceramic Doctor is independently runnable. It does not require Rams or Rams credits.

## Check code before commit, push and merge

Install in the project you want to check:

```sh
npm install --save-dev github:The-Utopia-Studio/ceramic-doctor#v0.3.0
npx ceramic-doctor check --staged
npx ceramic-doctor check --base origin/main --head HEAD
```

No preview URL, browser download, API key, or model login is required for source checks. `check` without a range inspects the working tree plus untracked UI files. `--staged` snapshots and checks the exact index contents, including partially staged files. A commit range compares the merge base to the exact head commit. Findings outside changed lines and their relevant JSX/CSS context are excluded. Deletion-only hunks retain adjacent context, so removing a label or alt attribute is still checked. Syntax failures and incomplete coverage fail execution.

Supported source: JSX/TSX, JS/TS containing JSX, and CSS. The engine checks static JSX accessibility with `eslint-plugin-jsx-a11y`, syntax, and CSS focus-outline risks. Optional Ceramic policy checks cover page-owned CSS/inline presentation and raw color use outside declared token/theme files. It never loads the target repository's ESLint config, imports submitted modules, or runs target npm scripts. This is not a visual-taste judge, a type checker or a replacement for the target's existing test/build jobs. Vue/Svelte/Swift/HTML/preprocessed CSS changes explicitly block unsupported coverage instead of receiving a pass.

### GitHub PR check

```sh
npx ceramic-doctor init-checks
```

This creates `.github/workflows/ceramic-doctor.yml` without replacing an existing file. Commit the generated workflow. On PRs and pushes to `main`, the **Ceramic Doctor / code changes** job uses the same source engine, emits file/line annotations, adds a job summary, and uploads JSON/Markdown/SARIF reports as a seven-day artifact. It does not post PR comments or require write permissions to your source repository.

The reusable Action can also be added to an existing workflow:

```yaml
permissions:
  contents: read
jobs:
  code-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: The-Utopia-Studio/ceramic-doctor@v0.3.0
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
```

Use this job under a `pull_request` trigger; the generated workflow also handles pushes and manual validation. Pin the Action to its release commit SHA if your repository requires immutable action references. The engine is installed in its own trusted Action directory with install scripts disabled, and PR code is read as data. CI reads `.ceramic-review.json` from the base commit, so a PR cannot silently disable its own checks by weakening the policy. New-branch pushes with an all-zero base inspect the full head tree. The Action runs locally on the GitHub runner and **does not upload your source to the hosted MCP**.

Serious/critical findings fail by default. `fail-on` can set the failure threshold. A check with no relevant UI source is labelled `SKIP`; missing/oversized/unreadable/unsupported UI files yield `BLOCKED`, not a pass. To require the check before merging, select **Ceramic Doctor / code changes** in your repository's branch/ruleset settings. Installing a workflow alone does not change branch protections.

### Local Git hooks (explicit opt-in)

```sh
npx ceramic-doctor install-hooks
```

This installs repository-local pre-commit (`check --staged`) and pre-push (exact outgoing commit ranges) hooks. It refuses to overwrite existing hooks or a custom `core.hooksPath`; integrate the command with Husky or your current hook manager in that case. Global Git configuration is never changed. Each developer installs hooks locally; the committed workflow supplies the shared PR check. The generated hook helper points at this installation, so reinstall the hooks if you move/remove the package. To uninstall, remove only the three Ceramic-owned files reported by the install command. Hooks are verified on macOS/Linux; they are not a security boundary against someone deliberately bypassing local Git hooks.

### Policy and reports

Optional `.ceramic-review.json`:

```json
{
  "version": 1,
  "semanticTokens": true,
  "pagePatterns": ["src/pages/**"],
  "tokenPatterns": ["**/themes/**", "**/tokens/**", "**/core.css"],
  "ignore": []
}
```

Generic projects leave `semanticTokens` false (the default). Semantic mode also recognizes Ceramic's Button, IconButton, Input, Textarea and NativeSelect wrappers. Other cross-file/custom framework wrappers may need manual review. Inline ESLint suppression comments do not disable this review engine; policy exclusions remain explicit and are reported.

Reports include exact source hashes, Git head/base/index-tree scope, policy revision, file/line findings, remediation, coverage and a technical defect index. Default output: `.ceramic/code-reviews/<id>/report.json`, `report.md`, `report.sarif`. Use `--out <directory>`, `--json` or `--format github`. Exit codes: `0` no blocking finding / explicit skip, `1` findings exceed the threshold, `2` incomplete execution or invalid input. Report artifacts contain findings and source hashes, not full source files; treat them according to your repository's confidentiality.

For programmatic or agent use:

```sh
ceramic-doctor review-files files.json --json
ceramic-doctor verify-code report.json --files updated-whole-files.json --json
```

`files.json` is an array of `{ "path": "src/Card.tsx", "content": "...", "changedLines": [{ "start": 3, "end": 8 }] }`. Omit `changedLines` to inspect the whole file. Verification requires whole-file contents for all original files and the same policy. Moved lines alone never count as fixes; ambiguous sibling failures remain unverified. Whole-file verification may reveal issues outside an earlier diff, so “new” means newly observed, not proven newly introduced. Local limits: 100 source files, 256 KiB per file, 2 MiB total, 500 diagnostics per file and 2,000 per report; exceeding them blocks coverage.

### Source review over MCP

The same remote URL below now exposes **`review_files`** and **`verify_code_fixes`**. Your coding agent can submit the explicitly selected changed UI files, receive findings/score/fix proposals, edit locally, and revalidate. The server does not pull a local repository or require GitHub credentials. Submitted source is parsed in an isolated 256 MiB worker with a 15-second budget and is not persisted by the application.

MCP payloads allow 20 files, 128 KiB per file and 500 KiB total (including a previous report for verification). Send only source authorized for review; split larger requests into explicit batches and keep coverage gaps visible. Hosted source and browser reviews share the anonymous quota; local CLI/GitHub Action checks have no hosted quota. The host AI may add clearly labelled judgement from the code, while deterministic source findings remain separate from model opinions and rendered evidence.

## Connect to the hosted MCP

**URL: `https://ceramic-doctor.vercel.app/mcp`**

Choose Streamable HTTP / remote MCP and authentication **None** in your client. No local installation, Node, browser, Codex CLI or API key is required.

Enter the URL in your client's **MCP server/connector settings**. Opening it in a normal browser takes you to this connection guide; actual MCP calls use HTTP POST. Protocol GET requests remain unsupported by this stateless server.

```json
{
  "mcpServers": {
    "ceramic-doctor": {
      "url": "https://ceramic-doctor.vercel.app/mcp"
    }
  }
}
```

For Codex:

```sh
codex mcp add ceramic-doctor --url https://ceramic-doctor.vercel.app/mcp
```

Ask: “Use Ceramic Doctor to review https://utopia-design-system.vercel.app. Wait for `h1`, inspect desktop and mobile screenshots, explain the findings, then verify my fixes.” Substitute your public site and its actual readiness selector when reviewing your own work.

For code changes, use `review_files` / `verify_code_fixes`. For URL review, the hosted server executes Doctor, Chromium and axe checks. Call `get_screenshot` and let your connected AI model judge visual hierarchy/readability/brand fit separately from measured defects. Hosted requests do not invoke the operator's personal Codex account. `visual` and project `qa` options belong to local execution only.

Hosted tools have the same names below. `design_review` returns a complete **private `reviewId`**, including its random access capability. Supply that entire value to `get_review`, `get_screenshot`, and `verify_fixes`; it grants access for 24 hours, so keep it private. `list_reviews` accepts `reviewIds: [...]` and lists only those known reports, never other people's work. Reports and screenshots are stored in a private Blob store. Access expires after 24 hours; daily cleanup removes expired date buckets, with a storage retention bound of 72 hours when the scheduled job operates normally.

Anonymous hosted reviews share a bounded quota: one run per caller per minute and 30 runs per hour across the service. Browser runs allow up to two scenarios × two viewports, six explicit actions per scenario, and a 100-second execution budget. Source calls use the separate worker/payload limits above. Quotas are storage-backed reservations across server instances. A limit or unavailable check returns an error/partial run, never a fabricated pass.

Hosted URL review accepts public HTTP(S) targets on ports 80/443. Localhost, private/reserved addresses, WebSockets and non-GET network operations are blocked. Every resource and redirect is checked through a DNS-pinned network proxy; site features depending on blocked operations may be incomplete and require local QA. The hosted service cannot access your local filesystem or authenticated/private applications; source review checks only the file contents explicitly supplied by the client.

The service is deployed on Vercel. For self-hosting, link a **private** Vercel Blob store (providing `BLOB_READ_WRITE_TOKEN`) and set a random `CRON_SECRET` for the scheduled cleanup endpoint. Keep those deployment credentials in your host environment. No client API key is needed.

## Install from GitHub

Local execution requires Node.js 22.17+. Distribution is GitHub; no npm publication is assumed.

```sh
npm install -g github:The-Utopia-Studio/ceramic-doctor#v0.3.0
ceramic-doctor install-browser
ceramic-doctor review http://localhost:4173 --ready main
```

Or clone and run locally:

```sh
git clone https://github.com/The-Utopia-Studio/ceramic-doctor.git
cd ceramic-doctor
npm ci
node bin/ceramic-doctor.mjs install-browser
node bin/ceramic-doctor.mjs review https://utopia-design-system.vercel.app --ready h1 --json
```

For a one-off invocation:

```sh
npx --yes --package=github:The-Utopia-Studio/ceramic-doctor#v0.3.0 ceramic-doctor doctor
```

Browser installation is one-time per Playwright version. On Linux, use `npx playwright install --with-deps chromium` from the cloned repository when system libraries are missing.

## Connect over local MCP

After global installation, you can alternatively run the server locally over stdio. Choose the project root where reports should be saved. This mode can access localhost and your existing Ceramic project QA gates.

```json
{
  "mcpServers": {
    "ceramic-doctor": {
      "command": "ceramic-doctor",
      "args": ["mcp", "--project", "/absolute/path/to/your-project"]
    }
  }
}
```

An npx configuration can run without a global CLI install. The initial GitHub dependency install can exceed MCP clients' startup timeout; preinstall the CLI as above for reliable startup, or increase your client's startup timeout before using this alternative:

```json
{
  "mcpServers": {
    "ceramic-doctor": {
      "command": "npx",
      "args": ["--yes", "--package=github:The-Utopia-Studio/ceramic-doctor#v0.3.0", "ceramic-doctor", "mcp", "--project", "/absolute/path/to/your-project"]
    }
  }
}
```

For Codex CLI after global installation:

```sh
codex mcp add ceramic-doctor -- ceramic-doctor mcp --project /absolute/path/to/your-project
```

| MCP tool | Behavior |
| --- | --- |
| `doctor` | Library contracts; include `url` to run Design Review |
| `design_review` | Render desktop/mobile, run checks, preserve evidence, propose fixes |
| `verify_fixes` | Repeat the saved scope and classify fixed/present/new/unverified findings |
| `list_reviews` | Last 20 project runs |
| `get_review` | Full report and coverage |
| `get_screenshot` | Inline screenshot for a recorded scenario/viewport |

Example request: “Use Ceramic Doctor to review http://localhost:4173. Wait for `main`, inspect mobile and desktop, propose fixes, then verify them.”

Tool input for visual review:

```json
{
  "url": "http://localhost:4173",
  "readySelector": "main",
  "visual": "codex"
}
```

The default run uses no model. `visual: "codex"` runs the installed, signed-in Codex CLI on captured screenshots, consuming its allowance. It returns model suggestions separately from measured failures. Model errors preserve browser evidence and produce a partial run. Missing login is never reported as a successful visual review.

## Use the skill

```sh
ceramic-doctor install-skill
```

This installs `skills/ceramic-doctor` into your Codex skills directory without overwriting an existing skill. Reopen your agent session and invoke `$ceramic-doctor`. Other agents can use the same `skills/ceramic-doctor/SKILL.md` directly, or copy the folder to their supported skill directory.

## Review and verify

```sh
ceramic-doctor doctor --project /path/to/Ceramic-Design-System
ceramic-doctor review http://localhost:4173 --ready main --visual codex --json
ceramic-doctor list
ceramic-doctor report REVIEW_ID --json
# Apply the proposed source changes in your editor/agent, then:
ceramic-doctor verify REVIEW_ID --json
```

`doctor` reuses `repositoryDoctor()` from Ceramic's CLI. In the Ceramic source repository it loads the local implementation; elsewhere it validates the installed Ceramic library. The report names this scope explicitly. Library health is not proof that the target application follows every Ceramic contract.

With `--project /path/to/Ceramic-Design-System --qa browser`, a review also invokes the existing `.agents/skills/design-system-ux-qa/scripts/run-qa.mjs browser --json`. The runner's real Playwright assertions/output are retained. `--qa quick` and `--qa contracts` reuse those gates. These options execute the selected project's trusted QA code, may run a large suite, and have a five-minute process budget. A missing or timed-out gate is blocked. No snapshots are updated.

Generic URL inspection adapts the existing Ceramic AI-user-testing observation and browser-QA evidence pattern: fresh sessions, rendered geometry, visible controls, keyboard samples and explicit assertion steps. It adds axe-core WCAG rules and structured findings.

Reports are stored privately under `<project>/.ceramic/design-reviews/<uuid>/`:

- `report.json`: machine-readable scope, verdict, findings, score, coverage, QA output and verification.
- `report.md`: readable findings, fix proposals and coverage.
- `<scenario>-desktop.png`, `<scenario>-mobile.png`: actual viewport captures.
- Matching JSON: DOM observations, focus samples, failed requests and exact runtime state.

Add `.ceramic/design-reviews/` to the target project's `.gitignore`. Screenshots and page text can contain project data. Nothing is uploaded by the default run; opt-in visual review sends screenshots/text through Codex. Do not share evidence containing secrets or private data unintentionally.

## Interaction and state coverage

For hydrated apps, supply a visible readiness selector. Without one, only the initial visible `body` is guaranteed. Captures are viewport screenshots; the model does not inspect content below the captured area.

Save `review-plan.json`:

```json
{
  "readySelector": "main",
  "scenarios": [
    { "id": "ready", "actions": [] },
    {
      "id": "menu-open",
      "actions": [
        { "kind": "click", "selector": "[data-slot='menu-trigger']" },
        { "kind": "expectVisible", "selector": "[role='menu']" }
      ]
    },
    { "id": "rtl-probe", "direction": "rtl", "reducedMotion": "reduce", "actions": [] }
  ]
}
```

```sh
ceramic-doctor review http://localhost:4173 --plan review-plan.json --json
```

MCP accepts the same `scenarios` array. Up to eight scenarios × two viewports, twenty actions each. Supported actions: `click`, `press`, `fill`, `select`, `expectVisible`, `expectText`. `expectText` uses a CSS selector. Actions should exercise an authorized test environment; unlike passive review, a supplied click/fill/key can change application state. Each scenario has a fresh context. Optional `url` must share the review origin; `locale` sets browser locale, while `direction` forces document direction and is explicitly marked as a probe. Native localization, loading, empty/error states, modes and themes need explicit routes/actions/assertions.

## Results and limits

Execution and product verdict are independent: a completed review can return `FAIL` because it successfully found defects. Browser/model/QA execution failures remain visible as partial runs. CLI exit codes: `0` completed without blockers, `1` blockers or failed Doctor contracts, `2` blocked/partial execution or invalid input.

The deterministic **ceramic-technical-v1** index starts at 100 and subtracts 25/10/3/1 for unique critical/serious/moderate/minor automated findings. A critical caps the value at 59. Same rule, scenario and selector across viewports counts once. Model suggestions never affect this score; incomplete automated execution gives `null`. This is a technical defect index, not calibrated visual taste, accessibility certification or release approval.

Verification preserves the original report, reruns the same URL/readiness/scenarios/viewports, and checks every originally affected viewport. A finding is fixed only when its deterministic rule completed without that finding. axe checks requiring manual review remain incomplete. An absent model suggestion stays unverified. Browser errors, timeouts and skipped checks cannot erase defects.

Source repair is handled by the host agent/editor, using the proposed smallest fix under existing project contracts. This release does not apply model-generated patches, authenticate into sites, run a full screen-reader audit, cover every browser/theme/state, or claim Rams quality parity. The visual reviewer and deterministic engine are replaceable modules.

## Development

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run check
npm test
npm pack --dry-run
```

Tests exercise real Chromium defects, same-scope fix verification, unavailable coverage, stdio/HTTP MCP calls and inline images with the official SDK, private report capabilities, atomic anonymous reservations, public-network restrictions, model-output validation and skill installation. Codex calls are opt-in and excluded from CI.

## 한국어

GitHub 업로드·PR 머지 전에는 `check --staged` 또는 `check --base ... --head ...`로 변경 코드를 검사합니다. `init-checks`로 PR 체크를 추가하고 `install-hooks`로 로컬 커밋·푸시 검사를 선택 설치할 수 있습니다. 원격 MCP의 `review_files`·`verify_code_fixes`도 같은 소스 엔진을 사용하며 URL 없이 동작합니다. 원격 MCP 주소 `https://ceramic-doctor.vercel.app/mcp`는 그대로 유지됩니다. 별도로 공개 웹사이트도 검사할 수 있습니다. 기본 실행은 Doctor와 브라우저 접근성·모바일 넘침·런타임 오류를 검사합니다. `get_screenshot`으로 실제 이미지를 받아 연결한 AI가 디자인을 판단하고, 에이전트가 소스를 수정한 뒤 `verify_fixes`로 같은 조건을 재검증합니다. 반환된 전체 reviewId는 비공개 보고서 접근 권한이므로 공유하지 마세요. localhost 브라우저 검사나 Codex CLI 시각 리뷰가 필요하면 로컬 실행을 사용하세요.
