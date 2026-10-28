# Ceramic Doctor

Evidence-backed design review for Ceramic and ordinary websites. Runs through a CLI, an MCP server, or the bundled agent skill. It combines the existing Ceramic Doctor with desktop/mobile browser QA, optional visual judgement, actionable findings and repeatable fix verification.

Ceramic Doctor is independently runnable. It does not require Rams or Rams credits.

## Connect to the hosted MCP

**URL: `https://ceramic-doctor.vercel.app/mcp`**

Choose Streamable HTTP / remote MCP and authentication **None** in your client. No local installation, Node, browser, Codex CLI or API key is required.

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

The hosted server executes Doctor, Chromium and axe checks. Call `get_screenshot` and let your connected AI model judge visual hierarchy/readability/brand fit separately from measured defects. Hosted requests do not invoke the operator's personal Codex account. `visual` and project `qa` options belong to local execution only.

Hosted tools have the same names below. `design_review` returns a complete **private `reviewId`**, including its random access capability. Supply that entire value to `get_review`, `get_screenshot`, and `verify_fixes`; it grants access for 24 hours, so keep it private. `list_reviews` accepts `reviewIds: [...]` and lists only those known reports, never other people's work. Reports and screenshots are stored in a private Blob store. Access expires after 24 hours; daily cleanup removes stored files after 48–72 hours.

Anonymous browser execution is bounded: one run per caller per minute, a shared 30 runs per hour, up to two scenarios × two viewports, six explicit actions per scenario, and a 100-second execution budget. These are storage-backed reservations across server instances. A limit or unavailable check returns an error/partial run, never a fabricated pass.

Hosted review accepts public HTTP(S) targets on ports 80/443. Localhost, private/reserved addresses, WebSockets and non-GET network operations are blocked. Every resource and redirect is checked through a DNS-pinned network proxy; site features depending on blocked operations may be incomplete and require local QA. The hosted service cannot inspect your local source files or authenticated/private applications.

The service is deployed on Vercel. For self-hosting, link a **private** Vercel Blob store (providing `BLOB_READ_WRITE_TOKEN`) and set a random `CRON_SECRET` for the scheduled cleanup endpoint. Keep those deployment credentials in your host environment. No client API key is needed.

## Install from GitHub

Local execution requires Node.js 22.17+. Distribution is GitHub; no npm publication is assumed.

```sh
npm install -g github:The-Utopia-Studio/ceramic-doctor#v0.2.0
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
npx --yes --package=github:The-Utopia-Studio/ceramic-doctor#v0.2.0 ceramic-doctor doctor
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
      "args": ["--yes", "--package=github:The-Utopia-Studio/ceramic-doctor#v0.2.0", "ceramic-doctor", "mcp", "--project", "/absolute/path/to/your-project"]
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

원격 MCP 주소 `https://ceramic-doctor.vercel.app/mcp`에 인증 없음으로 연결하면 로컬 설치 없이 공개 웹사이트를 검사할 수 있습니다. 기본 실행은 Doctor와 브라우저 접근성·모바일 넘침·런타임 오류를 검사합니다. `get_screenshot`으로 실제 이미지를 받아 연결한 AI가 디자인을 판단하고, 에이전트가 소스를 수정한 뒤 `verify_fixes`로 같은 조건을 재검증합니다. 반환된 전체 reviewId는 비공개 보고서 접근 권한이므로 공유하지 마세요. localhost·소스 검사·Codex CLI 시각 리뷰가 필요하면 로컬 실행을 사용하세요.
