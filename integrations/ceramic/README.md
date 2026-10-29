# Doctor in the existing Ceramic MCP

Ceramic exposes `review_files` and `verify_code_fixes` on its existing MCP connection. The public endpoint stays `https://ceramic-chatgpt.vercel.app/mcp`; clients refresh/reconnect Ceramic once to discover the added tools. No separate Doctor server, client API key or deployed preview URL is required for source review.

The Ceramic coding agent reads its actual PR diff, submits authorized UI source, reviews file/line findings and coverage, applies authorized repairs, then revalidates updated whole files against the original report. The server does not read a local repository, edit files or merge a PR. Enforcing a merge gate remains a GitHub Action / repository-rules setting.

Both the Ceramic stdio server and hosted server reuse the same browser-free `@utopia-studio-design/ceramic-doctor-source` archive from the v0.3.1 release. Source is parsed by a 15-second / 256 MiB worker in the consuming server. It is never executed, persisted or proxied to the hosted Doctor service. The hosted Ceramic adapter permits at most two concurrent workers per process, preserves its catalog payload limit and keeps private token-library authorization separate. Source tools require no sign-in; existing private-library tools keep their original administrator checks.

This directory contains only the new reusable adapters. `hosted-adapter.mjs` registers the strict Zod schemas in an existing SDK server; `stdio-adapter.mjs` provides the definitions and programmatic wrappers for an existing stdio server. Install the source archive and, for the hosted example, Zod 4.6.7 or compatible. Reuse existing server instructions/authorization alongside the exported source instructions.

The private Ceramic workspace integration includes server registration, API exports, capability metadata, source-only HTTP limits, worker tracing, current plugin guidance and source-processing notices. Its scoped patch, baseline hashes and deployment evidence are retained inside that private workspace; no pre-existing private implementation, library snapshots or credentials are published here.

Validation records cover the 20 hosted MCP tests, four stdio/API tests, the full CLI regression command, 23 Doctor tests, package provenance and actual HTTPS review/repair verification. Static checks support JSX/TSX and CSS; they do not establish rendered contrast, responsive layout, keyboard behavior or visual taste. Unsupported/incomplete execution cannot receive a pass.

## Update an existing local Ceramic installation

The release includes a tested integration build based on the published CLI 0.8.10: `0.8.10-doctor.1`. All 46 original tools, including `ceramic_guide` and the existing library `doctor`, remain available; the two source tools bring the total to 48. All 534 unmodified published files match the baseline byte for byte. See [package verification](package-verification.json).

For an existing global installation:

```sh
npm install -g https://github.com/The-Utopia-Studio/ceramic-doctor/releases/download/v0.3.1/utopia-studio-design-design-system-cli-0.8.10-doctor.1.tgz
```

Keep the existing Ceramic server name, project directory and `CERAMIC_CONNECTION_FILE`, then reconnect. If your existing MCP entry uses a fixed `npx --package` version, replace only that package argument with the same archive URL; keep the existing `utopia-ds mcp` or `ceramic-mcp` command. This is a package upgrade, not a second MCP registration. Node.js 22.17+ is required.

This integration build is distributed as a GitHub release asset. The npm registry's `latest` CLI version was not changed; an ordinary `npm update` does not install this archive. Existing fixed-version clients are not silently upgraded. Hosted Ceramic users only refresh their existing connection.

Rebuild the archive with `npm run pack:ceramic-mcp`. The build starts from the pinned public npm package, never the private Ceramic workspace or its pending changes.
