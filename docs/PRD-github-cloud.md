# Ceramic Doctor GitHub cloud integration

Issue: [TUS-3136](https://linear.app/the-utopia-studio/issue/TUS-3136/ceramic-doctor-github-cloud-integration)
Updated: 10 November 2026
Product owner: Aiden Kim. Engineering and rollout: Ceramic maintainers and an authorized Utopia Studio repository administrator.

## Outcome and current status

Give developers a repeatable UI review on each pull request or branch push, with actionable findings, explicit coverage and visible running cost. Reuse the same Doctor engine locally, through MCP and in GitHub.

The Actions pilot is merged: [Doctor #1](https://github.com/The-Utopia-Studio/ceramic-doctor/pull/1) and [Design System #90](https://github.com/The-Utopia-Studio/Ceramic-Design-System/pull/90), after all checks passed. The managed App implementation and rendered-check integration are in [Doctor #2](https://github.com/The-Utopia-Studio/ceramic-doctor/pull/2). Live App registration, credentials, hosting and installation are still required. A merged service implementation is not a live installation.

The existing Actions pilot pins released Doctor v0.3.1. Merging new source rules does not silently update that immutable pin or previously published source packages. Release and consumer-pin updates must be tracked separately from the managed service rollout.

## Problem and users

Developers need precise feedback without remembering a local command. Reviewers need consistent source policy and evidence from the actual rendered commit. Administrators need selected-repository access, bounded work, tenant isolation and predictable cost. A source score alone cannot establish readable contrast or a working mobile layout.

A diagnostic sample exposed four gaps in the original source-only path: missing input labels, unrestricted animation, low rendered text contrast and fixed-width mobile overflow. The requested scope now includes deterministic rendered checks in the managed App; broader model-based design judgement remains separate.

## Product flow

Administrator registers the App, selects repositories, and configures trusted preview publishers, origins, paths and readiness. A signed PR or push event queues a review. The worker reads the exact source blobs and trusted base policy, inspects source, and locates the latest authorized preview for that head. Sandboxed Chromium visits the configured routes at desktop and mobile widths. GitHub receives a maintained PR summary and a check with separate source/rendered evidence. A repair or successful deployment triggers a new review. The worker verifies current PR head/base before publishing.

GitHub check runs provide review history. Source findings receive file/line annotations; browser findings use route, viewport and selector evidence in the summary. A score is limited to detected technical defects in the executed scope. It is not a design-quality certification.

## Requirements and acceptance

| Requirement | Acceptance |
| --- | --- |
| Programmatic form labels | Source recognizes associated/wrapped labels and meaningful ARIA names; unrelated component IDs and null/empty labels do not satisfy it. Rendered controls require an actual name; placeholder alone is insufficient. |
| Reduced motion | Source flags missing CSS guards conservatively. Browser requests reduced motion and reports visible active animation above 10ms; essential motion needs manual review. |
| Contrast | axe measures the rendered page. Incomplete label/contrast checks block approval rather than produce a score. |
| Responsive layout | Render at 1440px and 390px; document width greater than viewport width reports overflow. |
| Repair verification | Real Chromium detects all four defects in the regression fixture; the repaired equivalent scope passes. This small sample is not a population accuracy benchmark. |
| Trusted preview | Exact commit SHA, configured deployment environment, authorized deployment/status publisher IDs and exact HTTPS origin; latest status must succeed. Require a build-populated full-SHA response header or meta marker. Recheck deployment identity after rendering. |
| Fail closed | Missing/stale preview, absent configuration, browser failure, resource failure, incomplete coverage and budget exhaustion never produce approval. Non-UI changes are SKIP/neutral. |
| Current-head publication | Recheck head/base before review and publication; stale work cancels. Rendered findings never fabricate source locations. |
| Durable lifecycle | Signed bytes, replay deduplication, restart recovery, lease fencing, bounded retries, scoped tokens, quotas, repository-removal/uninstall tombstones and report deletion. Successful deployment events rerun retained matching scopes without duplicate delivery jobs. |
| Review evidence | Source and rendered verdicts, score availability, source hashes, exact head/base, deployment identity, per-route coverage and elapsed processing time. |

The first managed release reviews at most 20 changed source files, 128 KiB/file and 450 KiB collected source. Unsupported or truncated changes block coverage. Rendering covers one or two operator-selected initial routes at two widths, with a 60-second total budget and 10-second browser steps. Other themes, interaction states, authenticated pages and screen-reader behavior are not certified.

## Architecture and security

Use one Node 24+ service replica and a persistent SQLite volume, separate from the stateless Vercel MCP. Domain review logic stays shared; GitHub transport, durable jobs and rendering are separate modules. Source review parses data in a bounded worker and never executes target builds, installs or configuration modules. Preview JavaScript runs in Chromium with its sandbox enabled, fresh contexts and a sanitized environment.

App permissions are metadata/contents/deployments read and checks/pull requests write. No contents write or administration permission is requested. Tokens are short-lived and scoped to one repository. Signed webhook payloads are capped at 1 MiB. API work has a two-minute deadline; source analysis has a 15-second/256 MiB budget. At most three transient attempts are made, with bounded backoff.

The public network proxy pins DNS resolution and blocks private addresses, non-GET/HEAD methods, WebSockets and service workers. No credentials are injected into the browser. The host must enforce CPU/memory limits and network isolation and support the Chromium sandbox. Do not disable it to make hosting work. Preview commit markers trust the configured publisher/build pipeline; they are not cryptographic build provenance.

Temporary screenshots and observations are deleted after review. Retain bounded findings, coverage, source hashes, usage and job metadata for 30 days; deduplication and aggregate attempt counters for at least 90 days. Uninstall/removal deletes retained reports and prevents delayed deliveries from resurrecting access. Backups must follow the same policy. History APIs require a separate operator token, never a browser-exposed secret.

Deployment instructions and the exact environment-variable/configuration contract are in [the App runbook](github-app.md).

## Ceramic and OS contract

Ceramic owns review rules, semantic-policy compatibility and evidence. OS may later surface repository, head, execution, verdict, score availability, findings, coverage, duration and usage through an authenticated service integration. GitHub remains the first user-facing history. No new Clerk workspace, Convex deployment, billing model or browser-exposed operator token is introduced. Separate PR suggestion threads, a customer dashboard and automatic fixes are outside this slice.

## Performance and costs

The original nine-target synthetic source sample detected five targets; the updated source engine detects seven, with no findings in its safe-form control. The rendered regression independently covers all four original misses and its repair. Do not combine these into a general accuracy percentage or claim Rams parity.

The baseline local source worker measured median 387ms and p95 569ms across 20 runs. Those timings exclude runner setup and differ from a cloud review's network/model latency. A fresh Rams run on the approved team account is still pending connection refresh; previous-session quota output belongs to the old connection and does not establish the team account's quota. No Rams speed or accuracy advantage is asserted.

Actions cost is billed runner minutes plus retained artifacts, subject to public-repository treatment and shared organization allowances. The prior planning assumption was two billed Linux minutes per run at the then-checked $0.006/minute: $1.20/100, $6/500 and $24/2,000 runs before allowances; it is not measured monthly spend. Push and PR runs can duplicate work. Actual billing must be checked against [GitHub pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing).

The managed App adds persistent host, Chromium CPU/memory, disk/backups, traffic, monitoring and support. Deterministic review uses no LLM tokens. Attempt quotas include retries and are not currency caps. Host selection, measured cost per rendered review and hosted pricing remain open. Rams published pricing and capabilities are comparison context, not evidence of equivalent coverage; see [Rams](https://www.rams.ai/).

## Release gates and open activation work

1. Pass syntax, full regression, actual Chromium and package-content checks. Run CI on the exact final head before merging.
2. Register the private App under the authorized organization, provision credentials and one persistent sandbox-capable host, and install only selected pilot repositories.
3. Configure trusted previews with real build-SHA markers. Exercise live clean/failing/repaired/missing/stale previews, fork access, rapid pushes, retries, removal and uninstall.
4. Measure the first 50 completed runs. Target at least 95% of normal reviews within three minutes; this remains an unverified target. Inspect actual host usage and billing before pricing claims.
5. Decide whether to require the check only after pilot acceptance. No ruleset change is included. Rollback must remove a required-check rule before removing its service/workflow.

Latest local validation: 39 regression tests, including actual Chromium and HTTP webhook replay tests; package inspection excludes secrets, databases and dependency directories. There are no production UI changes in this slice: pre-commit Doctor UI review is SKIP with no score, not a UI pass. Live host sandbox behavior and real GitHub installation flows still need pilot acceptance.

## Knowledge-base synchronization

- [Ceramic knowledge base](https://factory.8090.ai/project/cdb7de9f-3266-4076-9474-8964b8122092/knowledge-base/51313b6b-b1a9-4da6-879b-c2f6d8047dad)
- [Utopia OS knowledge base](https://factory.8090.ai/project/fd8466b5-9222-4ff3-baee-fc2876985a29/knowledge-base/e49e1061-6f88-405d-adad-25aad4296eff)

Both destinations were identified and their original English PRDs created. The latest rendered-check update is prepared here for both. On 10 November, factory.8090.ai repeatedly timed out; saving/reloading this update there is unverified. Linear and this versioned document are the current verified specification until 8090 synchronization succeeds.
