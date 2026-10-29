# Doctor in the existing Ceramic MCP

Ceramic exposes `review_files` and `verify_code_fixes` on its existing MCP connection. The public endpoint stays `https://ceramic-chatgpt.vercel.app/mcp`; clients refresh/reconnect Ceramic once to discover the added tools. No separate Doctor server, client API key or deployed preview URL is required for source review.

The Ceramic coding agent reads its actual PR diff, submits authorized UI source, reviews file/line findings and coverage, applies authorized repairs, then revalidates updated whole files against the original report. The server does not read a local repository, edit files or merge a PR. Enforcing a merge gate remains a GitHub Action / repository-rules setting.

Both the Ceramic stdio server and hosted server reuse the same browser-free `@utopia-studio-design/ceramic-doctor-source` archive from the v0.3.1 release. Source is parsed by a 15-second / 256 MiB worker in the consuming server. It is never executed, persisted or proxied to the hosted Doctor service. The hosted Ceramic adapter permits at most two concurrent workers per process, preserves its catalog payload limit and keeps private token-library authorization separate. Source tools require no sign-in; existing private-library tools keep their original administrator checks.

This directory contains only the new reusable adapters. `hosted-adapter.mjs` registers the strict Zod schemas in an existing SDK server; `stdio-adapter.mjs` provides the definitions and programmatic wrappers for an existing stdio server. Install the source archive and, for the hosted example, Zod 4.6.7 or compatible. Reuse existing server instructions/authorization alongside the exported source instructions.

The private Ceramic workspace integration includes server registration, API exports, capability metadata, source-only HTTP limits, worker tracing, current plugin guidance and source-processing notices. Its scoped patch, baseline hashes and deployment evidence are retained inside that private workspace; no pre-existing private implementation, library snapshots or credentials are published here.

Validation records cover the 20 hosted MCP tests, four stdio/API tests, the full CLI regression command, 23 Doctor tests, package provenance and actual HTTPS review/repair verification. Static checks support JSX/TSX and CSS; they do not establish rendered contrast, responsive layout, keyboard behavior or visual taste. Unsupported/incomplete execution cannot receive a pass.
