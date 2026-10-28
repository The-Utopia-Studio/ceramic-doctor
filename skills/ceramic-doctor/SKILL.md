---
name: ceramic-doctor
description: Review rendered UI with Ceramic Doctor, browser accessibility and responsive checks, optional screenshot judgement, and evidence-backed fix verification. Use for design reviews and Rams replacement workflows.
---

# Ceramic Doctor

Use the `ceramic-doctor` MCP server when connected. The CLI provides the same engine.

- `doctor` without a URL checks Ceramic library contracts. This alone does not review an application.
- `design_review` (or `doctor` with `url`) checks a rendered application. Supply a visible `readySelector` for a hydrated app. A review creates fresh desktop/mobile Chromium sessions and stores JSON, Markdown and PNG evidence locally.
- `visual: "codex"` requests screenshot judgement using the existing Codex login/allowance. Without it, visual judgement is explicitly skipped. The model's suggestions are separate from automated findings.
- For meaningful interactions or loading/empty/error/RTL states, supply named scenarios and explicit actions. Prefer a test environment and preserve the user's authorized scope. Never invent state coverage from a page load. A forced direction is a layout probe, not evidence of native Arabic support.
- `qa: "browser"` reuses the existing Ceramic browser QA runner in the configured project. `quick` and `contracts` are also available. It never updates snapshots. An absent runner is blocked, not passed.
- Use `get_review` and `get_screenshot` to inspect evidence. Report execution, verdict, findings, coverage gaps and the smallest useful next step.

When the user requests fixes, edit the owning components, semantic tokens or registered patterns under the project's architecture. Preserve brand/content/behavior and any locks. The review engine only proposes repairs; the host agent applies explicitly scoped edits. Run `verify_fixes` with the original review ID afterward. It reruns the original scope and separates fixed, present, new and unverified findings. A failed/missing check or disappearing model opinion cannot prove a fix.

The technical score uses a published defect rubric; it is not a visual-quality grade or publication approval. Do not convert suggestions into observed defects, claim screen-reader coverage from axe, or call a partial run a pass.

CLI fallback:

```sh
ceramic-doctor review http://localhost:4173 --ready main --json
ceramic-doctor review http://localhost:4173 --ready main --visual codex --qa browser --json
ceramic-doctor verify REVIEW_ID --json
```

Use the package README for installation and scenario JSON syntax. Keep reports and screenshots private unless the user asks to share them.
