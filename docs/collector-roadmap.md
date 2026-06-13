# Collector Roadmap

webpull is moving from a one-off docs puller toward a living knowledge collector. This roadmap is intentionally product-shaped: it keeps the local Bun CLI useful, but makes the hosted Cloudflare app the always-on collector surface.

## Current Cloudflare Direction

Cloudflare's recent platform work maps cleanly onto webpull's next product layer:

- **Workers, Cron Triggers, and Workflows** should run saved-source refreshes. Cron can wake the system, while Workflows should own multi-step refresh runs that need retries, sleeps, approval gates, or long-running extraction.
- **Durable Objects and Queues** should coordinate source-level locks, dedupe refresh requests, fan out document jobs, and keep pull progress durable when browsers or clients disconnect.
- **Browser Run / Browser Rendering with Playwright** should remain the hosted rendering path for JavaScript-heavy sources, screenshots, PDF captures, and markdown conversion of dynamic pages.
- **Workers AI, AI Search, and Vectorize** should power Ask across buckets, semantic search, extraction quality scoring, structured classification, and entity/reference/changelog extraction.
- **Agents SDK and MCP** should expose webpull as an agent-ready collector: saved source tools, refresh tools, search/fetch tools, Ask tools with citations, and future scheduled agent tasks for watch mode.
- **R2 and Artifacts** should separate storage concerns: R2 for raw captures, markdown, screenshots, PDFs, JSON/CSV exports, and run artifacts; Artifacts, while still beta, is a strong future fit for versioned Git-compatible export snapshots and diffable knowledge bundles.
- **Secrets Store** should hold connector credentials and destination tokens at the account level instead of spreading provider keys across Worker-local secrets.
- **AI Gateway** should wrap all model calls so Ask, structured extraction, and diagnostics have observability, caching, provider routing, and spend controls.
- **Billable Usage and Budget Alerts** should be part of the production checklist for Workers, D1, R2, Queues, Vectorize, Durable Objects, and Containers/Browser-heavy workloads.

## Feature Plan

### 1. Projects, Sources, and Refreshes

Make the product hierarchy explicit:

```text
Project -> Sources -> Pull runs -> Documents -> Knowledge buckets
```

Implementation notes:

- Add first-class projects with name, description, default bucket, retention, and export preferences.
- Add saved sources with URL/provider, cadence, max pages, extraction modes, auth profile, destination profile, and enabled/paused state.
- Add refresh schedules with `manual`, `hourly`, `daily`, `weekly`, and custom cron-like cadence.
- On Cloudflare, enqueue refresh requests from Cron Triggers or Agents SDK scheduled tasks and execute them through Workflows.
- Add source locking so overlapping refreshes collapse into one active run per source.

Verification:

- Local DB migration test for project/source/schedule tables.
- API test for create/update/pause/run-now source flows.
- Cloudflare Worker contract test for queued scheduled refresh payloads.
- Deployed smoke that creates a source, triggers a run, and confirms it appears under the owning project.

### 2. Deduplication, Change Tracking, and Diffs

Track document versions across runs, not just current documents.

Implementation notes:

- Hash normalized markdown and source metadata per document.
- Mark each document version as `new`, `changed`, `unchanged`, `removed`, or `failed`.
- Store previous/next version ids and run ids for diff navigation.
- Generate text diffs server-side for markdown and structured JSON diffs for extracted records.
- Surface run-level summaries: new pages, changed pages, removed pages, unchanged pages, failures, and weak extractions.

Verification:

- Fixture-based pull replay where the second run is unchanged and the third changes/removes/adds pages.
- UI test for run diff summary and per-document diff view.
- Export test confirming lineage and version ids are included in markdown, JSON, and CSV outputs.

### 3. Quality and Extraction Diagnostics

Every collected page should explain whether webpull trusts the extraction.

Implementation notes:

- Persist diagnostics: extraction confidence, word count, title found, markdown length, link count, table count, render mode, detected source type, failed selector hints, and final extractor.
- Add optional screenshot/PDF capture for weak pages or user-selected sources.
- Flag documents as `good`, `warn`, or `poor` based on configurable thresholds.
- Make weak data loud in Results, History, exports, and Ask citations.

Verification:

- Unit tests for confidence scoring thresholds.
- Browser test where a deliberately sparse page is flagged as weak.
- Cloudflare Browser Run smoke for screenshot/PDF capture when the binding is configured.

### 4. Structured Extraction

Add schema-oriented extraction alongside markdown.

Implementation notes:

- Support extraction modes: `tables`, `api-reference`, `entities`, `pricing`, and `changelog`.
- Store structured extraction records by document version and mode.
- Export JSON and CSV with source URL, pull date, document version, extraction mode, and confidence.
- Use deterministic parsers first, then Workers AI-assisted extraction behind AI Gateway for ambiguous pages.
- Use Zod schemas to validate AI outputs before persistence.

Verification:

- Golden fixture tests for each structured mode.
- Invalid AI output test that proves schema failures are rejected or marked weak.
- Export tests for JSON/CSV shape and lineage fields.

### 5. Ask Across Buckets

Turn buckets into an answerable knowledge surface.

Implementation notes:

- Add an Ask page with bucket/project/source filters, recency filters, and citation controls.
- Index document versions into AI Search or Vectorize with D1 metadata joins.
- Return answers with citations that include source URL, title, pull date, run id, document version, bucket, extraction method, and last refresh.
- Route all model calls through AI Gateway and record token/model metadata for cost and debugging.
- Keep a no-key local fallback that performs lexical search and quoted snippets rather than pretending to be full RAG.

Verification:

- Local fallback test for citation-bearing lexical answers.
- Cloudflare configured-path test for AI Search/Vectorize query contracts.
- UI test selecting multiple buckets and verifying citations are visible.

### 6. Authenticated Connectors

Do one or two private knowledge connectors well before adding many shallow integrations.

Implementation notes:

- Start with GitHub repositories/issues and Google Drive/Docs folders because they map cleanly to documents, versions, and permissions.
- Store provider credentials through Secrets Store where available, with local `.env` development fallback.
- Model connector status explicitly: `not-configured`, `needs-auth`, `ready`, `rate-limited`, `error`.
- Keep public source adapters separate from authenticated connector profiles.
- Add import lineage that identifies provider object ids, revisions, and permission scope.

Verification:

- Mock connector tests for auth-required, rate-limited, and success states.
- Live opt-in tests gated by provider tokens.
- UI test that unavailable connectors show setup-required states without fake data.

### 7. Watch Mode and Alerts

Use change tracking to create a monitoring workflow.

Implementation notes:

- Add watch rules by source, bucket, path pattern, extraction mode, keyword, or semantic topic.
- Support alert types: page changed, page removed, new matching page, pricing changed, API reference changed, changelog changed, weak extraction, run failed.
- Start with in-app alerts and webhook export; add email or chat destinations later.
- Execute watch evaluation after each refresh Workflow finishes.

Verification:

- Rule evaluation tests over deterministic changed/unchanged fixtures.
- API/UI tests for acknowledge, mute, and resolve alert states.
- Deployed smoke for webhook delivery using a test endpoint.

### 8. Clean Export Destinations

Make exports destinations, not one-off buttons.

Implementation notes:

- Keep R2 as the default hosted archive.
- Add local ZIP for browser download and CLI output.
- Add GitHub repo export for docs-as-code workflows.
- Add Google Drive folder and Notion database exports after connector credential storage is solid.
- Add MCP resource endpoint exports so agents can browse project, source, run, document, and bucket resources.
- Keep export manifests with lineage for every file and answer.

Verification:

- Manifest snapshot tests for each export destination.
- R2 readback test in deployed Cloudflare smoke.
- MCP resources/list and resources/read tests for exported resources.

## Suggested Implementation Phases

1. **Foundation:** projects, saved sources, schedules, migrations, source APIs, UI hierarchy.
2. **Collector loop:** recurring refresh orchestration, Queues/Workflows, source locks, deployed refresh smoke.
3. **Versioning:** document hashes, statuses, removed-page detection, run summaries, diff UI.
4. **Diagnostics:** confidence scoring, extraction metadata, weak-page states, screenshot/PDF options.
5. **Ask:** indexing contract, Ask page, citations, AI Gateway routed model calls, lexical fallback.
6. **Structured data:** schema modes, JSON/CSV exports, validation, lineage.
7. **Connectors and destinations:** GitHub/Google connectors, Secrets Store, GitHub/Drive/Notion/MCP exports.
8. **Watch mode:** rules, alert evaluation, webhook/email destinations, cost dashboards and budget alerts.

## Verification Gaps To Close

The current scripts cover local smoke, packaging, Cloudflare UI/MCP/source surfaces, and Cloudflare enhancement contracts. The next implementation should add or extend tests for:

- Project/source/schedule persistence and migration rollback safety.
- Recurring refresh execution, source locking, and queue retry behavior.
- Document version status classification across multiple runs.
- Markdown and structured diff generation.
- Diagnostics scoring and screenshot/PDF capture paths.
- Ask across buckets with citation and lineage requirements.
- AI Search/Vectorize configured path plus local fallback behavior.
- Connector auth states and setup-required UI states.
- Export manifest lineage across R2, ZIP, GitHub, Drive, Notion, and MCP resources.
- Watch rule evaluation and alert delivery.

Recommended local gate:

```bash
bun run biome check
bun run cloudflare:build
bun run cloudflare:types
bun run tsc --noEmit
bun run test/cloudflare-extract.ts
bun run test:cloudflare-enhancements
bun run test:db
bun run test:api
bun run test:cli
bun run build:ui
bun run test:pack
bun run test:packed-runtime
bun run test:smoke
```

Recommended deployed gate:

```bash
bunx playwright install chromium
bun run cloudflare:deploy
bun run test:cloudflare-ui
bun run test:cloudflare-mcp
bun run test:cloudflare-sources
```

Set `WEBPULL_CLOUDFLARE_URL` to test a non-default Worker URL, and use `WEBPULL_TEST_URL` to point the deployed UI smoke at a deterministic public fixture.

## Cloudflare Research Links

- Workers overview: https://developers.cloudflare.com/workers/
- Workflows overview: https://developers.cloudflare.com/workflows/
- Browser Run Playwright: https://developers.cloudflare.com/browser-run/playwright/
- AI Search overview and Wrangler namespace commands: https://developers.cloudflare.com/ai-search/
- Agents changelog: https://developers.cloudflare.com/changelog/product/agents/
- Artifacts docs: https://developers.cloudflare.com/artifacts/
- Secrets Store docs: https://developers.cloudflare.com/secrets-store/
- AI Gateway docs: https://developers.cloudflare.com/ai-gateway/
- Budget alerts: https://developers.cloudflare.com/billing/manage/budget-alerts/
- Docs for Agents: https://developers.cloudflare.com/docs-for-agents/
