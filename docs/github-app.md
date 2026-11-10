# Managed Ceramic Doctor GitHub App

TUS-3136 adds a managed review service alongside the existing Actions and MCP paths. It uses the same deterministic Doctor engine. It does not require Rams credits, an LLM key, a browser installation on developer machines. The managed host runs Chromium against authorized previews; source files are parsed without executing project builds or scripts.

The service implementation is not a registered or installed GitHub App. Live activation needs the App's identity and key, a webhook secret, an authorized installation and a persistent host. The existing personal GitHub CLI login is not a substitute for App authentication.

## Architecture and scope

`events.mjs` validates signed event scope. `store.mjs` owns durable SQLite jobs, deduplication, lease fencing, quotas and retained history. `github.mjs` handles fixed-origin GitHub API requests and repository-scoped tokens. `worker.mjs` collects pinned source, invokes the bounded Doctor worker and publishes feedback. `render.mjs` selects a trusted deployment for the exact head and checks configured routes in sandboxed Chromium. `server.mjs` exposes webhook intake, health and an operator-only history endpoint.

Run one Node 24+ service replica with one persistent volume. Do not put this SQLite service in the existing stateless Vercel MCP function. Horizontal scaling needs a shared transactional queue/database first. No Convex, Clerk, OS workspace or production MCP settings are changed by this service.

The user-facing history is in GitHub check runs. Every PR has one maintained bot summary, with a technical score, exact revisions, coverage and findings. Check annotations provide inline file/line feedback (first 50 findings); the summary and retained report preserve the broader result within GitHub message limits. Separate PR review suggestion threads and a customer dashboard are not implemented. Updating a summary does not prove that an old finding was repaired; changed-line reviews cannot make that claim.

## Register and install

Use `integrations/github-app/manifest.json` as the registration template. Replace `YOUR_APP_HOST` with the actual HTTPS host. Registration should be under The Utopia Studio, initially private, and installed only on the pilot repositories.

Permissions: metadata, contents and deployments read; checks and pull requests write. No contents write, issues write or repository administration. PR comment operations use pull requests write permission. Subscribe to pull requests, pushes, check-run and deployment-status events; installation and repository-removal lifecycle events are also processed. GitHub App creation, private-key generation and installation must be completed by an authorized administrator.

Configure these server-side values without committing secrets:

| Variable | Purpose |
| --- | --- |
| `GITHUB_APP_ID` | Positive numeric GitHub App ID |
| `GITHUB_APP_SLUG` | Exact App slug, used to identify its own bot comments |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Read-only mounted PEM file; never log it |
| `GITHUB_APP_WEBHOOK_SECRET` | Random secret, at least 32 characters, matching GitHub |
| `GITHUB_APP_ALLOWED_INSTALLATIONS` | Comma-separated authorized installation IDs |
| `CERAMIC_DOCTOR_OPERATOR_TOKEN` | Separate random secret, at least 32 characters, for operator history |
| `CERAMIC_DOCTOR_DATABASE` | Persistent SQLite file; default `.ceramic/github-app/reviews.sqlite` |
| `CERAMIC_DOCTOR_MONTHLY_REVIEWS` | Attempt budget per installation per UTC month; default 500 |
| `CERAMIC_DOCTOR_PREVIEWS` | JSON array of authorized preview configurations; missing repository configuration blocks UI approval |
| `HOST`, `PORT` | Defaults `127.0.0.1`, `8787`; container binds `0.0.0.0` |

Run `npm run start:github-app`. For a container, build from the repository root with `docker build -f integrations/github-app/Dockerfile .`, mount `/data` and the key file, and inject the secrets through the host's secret manager. Put the service behind HTTPS. The image installs Chromium. Run as the non-root user on a host that supports the Chromium sandbox; do not disable the sandbox to make a deployment work. Limit container memory/CPU, deny access to cloud metadata/private networks at the host firewall, and keep the service single-replica. The existing Vercel MCP remains separate.

The service fails startup when required configuration is missing. `/health` reports readiness without credentials or tenant details. POST signed deliveries to `/webhooks/github`; source review happens after durable enqueue. The operator-only `GET /api/installations/INSTALLATION_ID/reviews` requires `Authorization: Bearer OPERATOR_TOKEN` and returns the most recent 100 retained records for an allowlisted installation. Do not put the operator token in a browser frontend.

## Rendered preview contract

UI reviews require both source and rendered coverage. Configure each installation/repository explicitly, for example (replace every example value):

```json
[{"installation":123,"repository":456,"environment":"Preview","origins":["https://preview.example.com"],"creatorIds":[789],"paths":["/","/settings"],"readySelector":"main h1"}]
```

`creatorIds` contains the trusted GitHub deployment/status publisher IDs, usually the deployment provider's bot. The latest authorized deployment must reference the exact reviewed SHA, use the configured environment, and have a latest successful status pointing to an exact allowlisted HTTPS origin. Wildcards and login credentials are not accepted. No fallback to an old successful deployment is allowed. Use an immutable deployment URL where possible; register rotating origins through operator configuration. The served document must attest its build SHA using either `X-Ceramic-Commit: FULL_HEAD_SHA` or `<meta name="ceramic-commit" content="FULL_HEAD_SHA">`. Populate this from the build's actual commit, not a request parameter. This trusts the allowlisted deployment publisher and build pipeline; it is not cryptographic build provenance.

The App checks one or two configured paths at 1440px and 390px with reduced motion enabled. It checks programmatic input labels, rendered contrast through axe, horizontal document overflow, active animation under reduced motion, and existing runtime/image/accessibility rules. Source review additionally checks same-tree JSX labels and conservative CSS motion guards. Cross-file CSS, dynamic names and custom controls need rendered coverage. Only the configured initial states are covered; essential animation, screenshots, screen-reader behavior, alternate themes and interaction flows require separate review.

Missing configuration, inaccessible previews, commit/origin mismatches, browser failure, resource failures or incomplete label/contrast measurement produce BLOCKED/action-required, never approval. Pending deployments receive bounded retries; a later successful `deployment_status` event queues a new review of matching retained scopes. Replayed delivery bodies do not create additional jobs. Deployment identity is checked again after rendering; PR head/base are checked before publication. Browser findings appear with route/viewport/selector evidence in the summary, without invented source-line annotations.

The browser has a sanitized environment and fresh contexts, without injected credentials. It uses the public DNS-pinned proxy: private targets, non-GET/HEAD requests, WebSockets and service workers are blocked. Redirected documents must remain on the configured origin. Preview JavaScript does run in the browser sandbox. Screenshots/observations are temporary and deleted after each review; bounded findings and coverage use normal report retention. The total rendering budget is 60 seconds, with 10-second browser steps, at most four screens and shared resource limits. Host resource limits remain necessary.

## Safety and lifecycle

- HMAC-SHA256 verifies raw request bytes before JSON use. Webhooks are capped at 1 MiB. Source blobs and tokens are never persisted.
- A digest of event plus body prevents replays even if the delivery header changes. Deduplication records remain for 90 days.
- Tokens are minted for one repository and the declared minimal permissions. GitHub repository identity is verified before reading source. Tokens are not exposed in reports or logs.
- PR source comes from file blob SHAs verified against head tree entries; symlinks and submodules are rejected; policy comes from the captured base SHA. Fork blobs that the installation cannot access produce blocked coverage, not an unreviewed pass.
- Compare the live PR head and base before review and before publishing. Push jobs compare the live branch head. Closed/deleted/superseded work cancels. Event arrival order is not trusted as commit order.
- A worker lease lasts three minutes; API work has a two-minute deadline and each HTTP request has a 20-second timeout. Source analysis has its existing 15-second/256 MiB worker budget. Process restart recovers expired leases; old lease owners cannot overwrite a newer result.
- Transient network/429/5xx errors retry with bounded backoff, at most three attempts. All attempts count toward the monthly budget. A final publication outage can leave a GitHub check incomplete; the operator record remains blocked and must be investigated. Never interpret an incomplete check as approval.
- Existing checks are recovered by external job ID and App identity. Existing summaries are updated only if owned by this App. Rerequesting a check creates a distinct review job.
- Uninstallation/suspension or repository removal records a tombstone, removes retained reports and blocks subsequent jobs. Delayed creation events cannot undo removal. Re-enabling requires an operator to verify live authorization and explicitly clear the relevant tombstone using the store's `restore` method; there is no unauthenticated restore endpoint.
- Reports expire after 30 days; aggregate monthly attempt counters are retained for at least 90 days; cleanup runs with the worker. Backups must follow the same retention and uninstall deletion policy. Configure encrypted host storage and private backups before external rollout.

## Coverage and costs

The first managed version allows 20 changed source files, 128 KiB each, a 450 KiB collected source budget and the shared worker's 500 KiB serialized payload limit. PR file lists are capped at 300 files and push comparisons at fewer than 300 to avoid GitHub truncation. Missing patches, unreadable policy, parse failures and unsupported formats remain blocked. An initial default-branch push requires a full-tree review through Actions; the App does not silently treat it as a clean comparison. Larger reviews can use the Actions path within its documented limits.

Reports distinguish PASS, FAIL, SKIP and BLOCKED. GitHub conclusions are success, failure, neutral and action-required respectively. The managed score combines detected source and rendered defects within the configured scope; it is not a visual-quality certification. Source and rendered results remain separately visible. The monthly limit counts attempts, including retries, and does not represent a currency spending cap.

The managed service records elapsed processing milliseconds and attempt counts. Its bill is persistent host/volume/backup cost plus traffic, not the Actions rate. Provider and capacity are not provisioned by this change, so no hosted monthly price or margin is asserted. LLM cost is zero for this deterministic path. Chromium adds CPU, memory and network cost; no managed per-review price is asserted before host measurements. Actions estimates and current competitor pricing remain in the linked Linear PRD.

## Activation checklist

1. Run `npm run check` and `npm test`, including signed HTTP intake and real-engine publication tests.
2. Register the App, generate/mount its private key and match the webhook secret. Deploy one persistent service replica; verify HTTPS and readiness.
3. Install on selected pilot repositories and allowlist the installation ID. Configure preview publisher IDs, origins, paths, readiness and the build commit marker. Confirm signed ping delivery, no source persistence and correct App attribution.
4. Exercise real GitHub PRs for clean UI, all four rendered regressions, repair, missing/stale previews, unsupported source, fork access, rapid pushes, deployment retries, rerequest, removal and uninstallation. Confirm stale work never turns the newest head green.
5. Verify API rate-limit recovery and process restart on the host. Inspect attempt budgets, retention and storage cost. Add monitoring for blocked records, queue age, disk capacity and failed deliveries.
6. Only after the pilot, choose whether to make the managed check required. Do not leave both an obsolete required Action name and a removed managed check in repository rules.

The live installation/host acceptance steps cannot be claimed from the local mock GitHub tests.

References: [GitHub App practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app), [check runs](https://docs.github.com/en/rest/checks/runs), [TUS-3136 PRD](https://linear.app/the-utopia-studio/document/prd-ceramic-doctor-github-cloud-integration-b0865c2b41a9).
