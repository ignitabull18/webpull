# Cloudflare Agent Platform — Complete Feature Inventory

All agent/AI features released by Cloudflare, organized chronologically from February through June 2026, plus products in docs without dedicated launch blog posts.

---

## webpull collector application plan

The implementation roadmap for applying this platform inventory to webpull lives in `docs/collector-roadmap.md`. The strongest product direction is to make webpull a hosted collector with:

- saved sources and recurring refreshes on Workers Cron, Workflows, Durable Objects, and Queues;
- project/source/run/document/bucket hierarchy in D1 with R2-backed captures and exports;
- deduplication, document versions, markdown/structured diffs, and run-level change summaries;
- extraction diagnostics, optional screenshots/PDFs, and Browser Run Playwright for dynamic sources;
- structured extraction modes for tables, API references, entities, pricing, and changelogs;
- Ask across buckets using Workers AI, AI Search, Vectorize, AI Gateway, and citation-rich lineage;
- authenticated connectors backed by Secrets Store, starting with GitHub and Google Drive/Docs;
- MCP and Agents SDK surfaces for agent-driven saved source, refresh, search, fetch, and Ask workflows;
- clean exports to R2, local ZIP, GitHub, Google Drive, Notion, MCP resources, and future Artifacts repositories;
- cost guardrails using AI Gateway spend limits plus Cloudflare billable usage and budget alerts.

Keep this file as the Cloudflare feature inventory. Keep implementation sequencing, verification gaps, and exact test commands in the roadmap.

---

## February 20, 2026

### Code Mode

The Cloudflare API has over 2,500 endpoints. Exposing each one as an MCP tool would consume over 2 million tokens. Code Mode collapses the entire API into two tools and roughly 1,000 tokens of context by letting agents write and execute JavaScript against a typed SDK in a sandboxed isolate. The same pattern now powers MCP server portals, Dynamic Workers, and the Agent Setup integrations.

**Docs:** https://developers.cloudflare.com/agents/tools/mcp/
**Blog:** https://blog.cloudflare.com/code-mode-mcp/

---

## March 24, 2026

### Dynamic Workers

Execute AI-generated code in secure, lightweight V8 isolates with millisecond startup — roughly 100x faster than traditional containers. The `WorkerLoader` binding lets you hand the Workers runtime arbitrary code at runtime and get back an isolated, sandboxed Worker on the same machine. Pricing is based on requests, CPU time, and unique Dynamic Workers created per day. Includes a Code Mode example (LLM writes and executes JavaScript to orchestrate multiple tools), a playground with real-time logs and timing, and a Dynamic Workflows playground.

**Docs:** https://developers.cloudflare.com/dynamic-workers/
**Blog:** https://blog.cloudflare.com/dynamic-workers/

---

## April 14, 2026

### Enterprise MCP reference architecture

Cloudflare published their internal playbook for governing MCP at scale: remote MCP servers deployed on Workers, Cloudflare Access as the OAuth provider, MCP server portals for centralized discovery and policy enforcement, AI Gateway for observability, and Gateway-based rules for detecting unauthorized "Shadow MCP" servers. Also covers DLP guardrails, per-portal tool-level access controls, and auto-generated CI/CD pipelines with secrets management.

**Docs:** https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
**Blog:** https://blog.cloudflare.com/enterprise-mcp/

### Managed OAuth for Access

Make internal apps agent-ready in one click. Adopts RFC 9728 so AI agents can authenticate on behalf of users against applications behind Cloudflare Access without using insecure service accounts. Agents receive scoped, short-lived tokens through standard OAuth flows rather than static API keys or shared credentials.

**Docs:** https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/
**Blog:** https://blog.cloudflare.com/managed-oauth-for-access/

---

## April 16, 2026

### Artifacts

A distributed, versioned filesystem that speaks Git, built for agents first. Create tens of millions of repos programmatically via Workers binding or REST API. Fork from any remote with `.import()`; create isolated read-only copies with `.fork()`. Built on Durable Objects with a ~100 KB Zig-to-Wasm Git server implementation (SHA-1, zlib inflate/deflate, delta encoding/decoding, pack parsing, full smart HTTP protocol — all from scratch with zero external dependencies). Already used inside Cloudflare for per-session agent state persistence, session sharing and forking, and time-travel debugging. Non-Git clients can use the REST API.

**Docs:** https://developers.cloudflare.com/artifacts/
**Blog:** https://blog.cloudflare.com/artifacts-git-for-agents-beta/

---

## April 17, 2026

### Shared Dictionaries

Compression built for the agentic web. Agentic crawlers, browsers, and tools now represent roughly 10% of all Cloudflare traffic (up ~60% year-over-year). AI-assisted development means teams ship faster, which evicts caches more often — a one-line fix can force every user and bot to re-download the entire bundle. Shared dictionaries use the previously cached version of a resource as the compression reference, so only the diff is sent. A 500 KB bundle with a one-line change compresses to a few kilobytes on the wire.

**Docs:** https://developers.cloudflare.com/speed/optimization/content/compression/
**Blog:** https://blog.cloudflare.com/shared-dictionaries/

### Flagship

Feature flags evaluated at the edge with sub-millisecond latency, built on KV and Durable Objects. Native Workers binding with typed methods for booleans, strings, numbers, and objects plus automatic fallback when a flag cannot be fetched. Targeting rules, evaluation context, and flag propagation are built in. Designed to eliminate the latency of third-party feature flag providers for agent-driven applications that need per-request flag decisions.

**Docs:** https://developers.cloudflare.com/flagship/
**Blog:** https://blog.cloudflare.com/flagship/

---

## April 20, 2026

### AI Code Review at scale

A CI-native AI code reviewer using OpenCode that launches up to seven specialized review agents per merge request: security, performance, code quality, documentation, release management, internal Engineering Codex compliance, and AGENTS.md verification. A coordinator agent deduplicates findings, judges severity, and posts a single structured review comment. Built on a composable plugin architecture where each plugin (GitLab VCS, AI Gateway, model tiers, Braintrust tracing, reviewer config, telemetry) implements a `ReviewPlugin` interface with bootstrap, configure, and postConfigure lifecycle phases. Running across tens of thousands of internal merge requests. Actively blocks merges when it finds genuine security vulnerabilities.

**Blog:** https://blog.cloudflare.com/ai-code-review/

---

## April 30, 2026

### Agents as Cloudflare customers (Stripe Projects)

Co-designed with Stripe as part of the Stripe Projects launch. Agents can now provision Cloudflare on behalf of their users: create a Cloudflare account, start a paid subscription, register a domain, and get back an API token to deploy code — all without any human dashboard steps (only terms-of-service acceptance required). Built on a three-part protocol: discovery (agents query the catalog of available services), authorization (platform attests to user identity, providers issue credentials), and payment (platform provides a payment token for subscriptions and purchases). Any platform with signed-in users can integrate using the same protocol. $100,000 in Cloudflare credits offered to Stripe Atlas startups.

**Blog:** https://blog.cloudflare.com/agents-stripe-projects/

---

## May 1, 2026

### Dynamic Workflows

A library (~300 lines of TypeScript) that routes durable execution to tenant-provided code at runtime. Built on Dynamic Workers, it lets a single Worker Loader dispatch every `create()` call to a different tenant's code, with the Workflows engine calling `run(event, step)` back to the correct code hours or days later. Enables platforms to serve millions of unique workflows at near-zero idle cost — every tenant, every agent, every request gets its own workflow class resolved at runtime. Includes a playground where you can write workflow logic in JavaScript and watch every step execute with live `console.log` streaming.

**Docs:** https://developers.cloudflare.com/workflows/
**Blog:** https://blog.cloudflare.com/dynamic-workflows/

---

## May 13, 2026

### Browser Run on Containers

Rebuilt Browser Run on Cloudflare Containers infrastructure (previously shared with Browser Isolation). Results: 4x higher concurrency (120 concurrent browsers, 60 browsers per minute spin-up), 50%+ faster Quick Action response times. Migrated container state tracking from KV (eventual consistency, 30-second TTL caused race conditions) to D1 + Queues (transactional, atomic browser assignment). Regional pools of pre-warmed DO-backed browser containers minimize latency. No customer changes required — improvements are live today.

**Docs:** https://developers.cloudflare.com/browser-run/
**Blog:** https://blog.cloudflare.com/browser-run-containers/

---

## May 19, 2026

### Claude Managed Agents on Cloudflare

Anthropic partnership integrating Claude Managed Agents with Cloudflare Sandboxes. "Brain on Anthropic, hands on Cloudflare." The core agent loop runs on the Claude Platform while code execution, connections, and custom tool calls run on Cloudflare. Default deployment template includes: enhanced security via customizable proxies (credential injection, data exfiltration prevention), sandbox control and observability (detailed metrics, logs, SSH access, custom images), lightweight V8 isolates or full microVMs, private service connectivity to internal backends, browser control with session recording and human-in-the-loop flows, per-agent email addresses, and custom tools deployable as plain functions.

**Docs:** https://developers.cloudflare.com/sandbox/tutorials/claude-managed-agents/
**Blog:** https://blog.cloudflare.com/claude-managed-agents/

---

## May 28, 2026

### Town Lake + Skipper (internal data platform with AI agent)

Cloudflare's internal unified data platform (Town Lake) provides a single SQL interface to all Cloudflare data across R2, ClickHouse, BigQuery, Kafka, Postgres, and more. Built on R2 for storage, Workers for compute, Cloudflare Access for authentication, and Workflows for orchestration. Skipper is an AI data agent running on top that answers plain-English questions with correct, auditable results in seconds — translating natural language to SQL, executing across the unified interface, and returning results with provenance.

**Blog:** https://blog.cloudflare.com/our-unified-data-platform/

---

## June 2, 2026

### Agents SDK v0.14.0

Major release adding four new ways to build with `@cloudflare/think`:

- **Agent Skills (experimental)** — On-demand catalog of instructions, resources, and scripts. Skills source from local directories (`agents:skills` import via Vite plugin), R2 buckets, or manifests. The model activates a skill only when a task matches, so a large library does not bloat every prompt. Exposes `activate_skill`, `read_skill_resource`, and optional `run_skill_script` tools. Failing sources are skipped with a warning rather than breaking the agent.

- **Messengers** — Connect a Think agent directly to chat platforms. Telegram ships as the first provider. Think owns the webhook route, conversation routing, durable reply fiber, and streamed delivery. Each chat thread maps to its own sub-agent by default. Multiple bots, custom conversation routing, and custom providers are supported.

- **Scheduled tasks** — Declarative, timezone-aware recurring prompts with a typed DSL (`every week on monday at 09:00`, `every day at 08:00 in Europe/London`). Think reconciles declarations on startup and rearms the next occurrence after each run, backed by durable idempotent submissions.

- **Think Workflows** — `ThinkWorkflow` + `step.prompt()` for durable model-driven reasoning steps with typed structured output (Zod schemas), configurable timeouts (hours or days), and approval gates inside Cloudflare Workflows.

- **Production-hardened chat recovery** — Turns survive mid-turn deploys and Durable Object evictions without losing completed work or re-running tools. New `isRecovering` flag on `useAgentChat` for UI progress indicators. `chatStreamStallTimeoutMs` routes hung provider streams into the recovery path. Sub-agents re-attach to their results on parent recovery instead of being abandoned and re-run.

- **MCP transport improvements** — Resumable SSE streams (clients reconnect with `Last-Event-ID`), readable server IDs via optional `addMcpServer` `id` parameter, and correct correlation of overlapping JSON-RPC requests across HTTP and RPC transports.

- **Compaction improvements** — Session `tokenCounter` now drives compaction boundary decisions ("what to compress"), not just the trigger.

- **Other** — `@cloudflare/worker-bundler` adds `virtualModules` option. Client-tool continuations coalesce parallel results into a single continuation.

**Docs:** https://developers.cloudflare.com/agents/
**Changelog:** https://developers.cloudflare.com/changelog/post/2026-06-02-agents-sdk-v0140/

---

## June 10, 2026

### AI Search Wrangler CLI

AI Search now supports namespace-level Wrangler commands: `list`, `create`, `get`, `update`, `delete`. Create namespaces for applications or tenants directly from the CLI. List with pagination and filter by name or description. Use `--json` with `list`, `create`, `get`, and `update` for structured output that automation and AI agents can parse. Instance-level commands also accept a `--namespace` flag.

**Docs:** https://developers.cloudflare.com/ai-search/wrangler-commands/
**Changelog:** https://developers.cloudflare.com/changelog/post/2026-06-10-ai-search-namespace-wrangler-commands/

---

## Products in docs without dedicated launch blog posts

### Agent Lee

An AI co-pilot built into the Cloudflare dashboard. Ask questions, run diagnostics, and take actions across your Cloudflare account using natural language — navigate, configure, and operate Cloudflare services without leaving the dashboard.

**Docs:** https://developers.cloudflare.com/agent-lee/

### Agent Memory

Persistent AI-powered memory for agents and applications. Automatically extracts entities, classifies knowledge, and stores structured memories from conversations. Scoped by namespaces (applications) and profiles (individual users or agents). Available via Workers binding (`env.AGENT_MEMORY`) or HTTP API. Supports memory ingestion, recall queries, and profile management.

**Docs:** https://developers.cloudflare.com/agent-memory/

### Agent Setup

Guided setup pages for connecting major coding agents to Cloudflare: Claude Code, Codex (OpenAI), Cursor, GitHub Copilot, OpenCode, and Windsurf. Each guide covers installing the agent, connecting Cloudflare skills and MCP servers, and deploying to Cloudflare — all from the user's editor or terminal.

**Docs:** https://developers.cloudflare.com/agent-setup/

### AI Crawl Control

Monitor and control how third-party AI crawlers access your website content. Analyze AI traffic patterns, manage crawler allow/block lists, and configure actions per crawler. Integrates with Cloudflare Bots, Transform Rules (for licensing headers), and WAF custom rules.

**Pay Per Crawl** — A monetization model where site owners charge AI crawlers for access. Includes Stripe integration for payouts, per-crawl pricing configuration, crawler verification, activity monitoring, and an FAQ. AI owners can discover payable content, verify their crawler identity, and crawl pages through the Pay Per Crawl protocol.

**Docs:** https://developers.cloudflare.com/ai-crawl-control/

### Docs for Agents

How AI agents and LLMs consume Cloudflare documentation. Every product has an `llms.txt` index listing all documentation pages. Every page can be retrieved as Markdown by sending an `Accept: text/markdown` header to the page URL. Designed so coding agents can fetch exactly the docs they need without scraping HTML.

**Docs:** https://developers.cloudflare.com/docs-for-agents/

### Secrets Store

Encrypt and store sensitive information as account-level secrets that are securely reusable across Workers, AI Gateway (bring-your-own-keys), and other Cloudflare services. Includes role-based access control, audit logging for create/update/delete operations, REST API, and Wrangler integration.

**Docs:** https://developers.cloudflare.com/secrets-store/

---

## Previously existing agent-relevant products

These products predate the Spring 2026 agent push but are foundational to the agent platform:

| Product | Description |
|---------|-------------|
| **Workers** | Serverless compute at the edge — the runtime everything else runs on |
| **Durable Objects** | Stateful compute with strong consistency, used by Agents SDK, Artifacts, Workflows, and Flagship |
| **Workflows** | Durable execution engine — multi-step programs that survive failures, sleep for days, and resume exactly where they left off |
| **Workers AI** | Run AI models (Whisper, Llama, DeepSeek, etc.) on Cloudflare's global network with no external API keys |
| **AI Gateway** | Observe, control, and cache AI provider requests — rate limiting, spend limits, logging, analytics |
| **AI Search** | Fully managed RAG pipelines — ingest, embed, and search documents with vector + full-text search |
| **Vectorize** | Global vector database for storing and querying embeddings |
| **R2** | Object storage without egress fees, used by Artifacts, Agent Memory, and Browser Run |
| **D1** | Managed SQLite databases with Durable Object-backed transactional semantics |
| **Queues** | Reliable message delivery without egress fees |
| **KV** | Global, low-latency key-value store |
| **Sandbox SDK** | Full stateful Linux microVMs at scale — used by Claude Managed Agents and Browser Run |
| **Containers** | Serverless containers alongside Workers for resource-intensive workloads, custom runtimes, and existing container images |
| **Browser Run** | Programmatic headless browser control for agents — screenshots, PDF rendering, content extraction, web interaction |
| **Pipelines** | Real-time data stream ingestion into R2 |
| **Email Service** | Send transactional email via REST API, Workers binding, or SMTP |
| **Turnstile** | Smart CAPTCHA alternative |
| **Pages** | Full-stack serverless application deployment |
| **Hyperdrive** | Global database query acceleration |
| **Zaraz** | Third-party tool execution at the edge |
