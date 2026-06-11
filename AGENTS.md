# AGENTS.md

## Project

**webpull** — Pull any public docs site into local markdown files. A Bun CLI with an optional full React web UI. Discovers pages via sitemaps/nav links/link crawling, renders SPAs with headless Chromium (Playwright), and converts to markdown with YAML frontmatter using Defuddle.

## Runtime & toolchain

- **Runtime**: [Bun](https://bun.sh) (target: `ESNext`, module: `Preserve`, `verbatimModuleSyntax`)
- **Lint/format**: [Biome](https://biomejs.dev) — tabs, double quotes, no semicolons, line width 120
- **TypeScript**: strict mode, `noUncheckedIndexedAccess`, `noImplicitOverride`, `skipLibCheck`, lib: `["ESNext", "DOM"]`
- **Dependencies**: `effect` (FP), `playwright` (SPA render), `linkedom` (DOM parse), `defuddle` (content extraction), `react` + `react-dom` + `react-router-dom` (web UI), `react-markdown` + `react-syntax-highlighter` (markdown preview)
- **CI**: GitHub Actions publishes to npm on `v*` tags

## Code conventions

- Semicolons omitted (`semicolons: "asNeeded"`). Double quotes for strings, tabs for indentation.
- Imports sorted by Biome's `organizeImports`.
- Prefer `Effect` for structured concurrency and error handling in server-side code.
- `WorkerPool` (in `src/pool.ts`) manages parallel fetching; worker logic lives in `src/worker.ts`.
- The renderer (`src/renderer.ts`) wraps Playwright; always close via `closeBrowser()`.

## Module layout

| Module | Purpose |
|--------|---------|
| `src/index.ts` | Entrypoint: no args → web server, with args → CLI |
| `src/server.ts` | Bun HTTP + WebSocket server, REST API |
| `src/pull.ts` | Core pull orchestration with progress callback |
| `src/db.ts` | SQLite persistence (pulls, documents, FTS5 search) |
| `src/discover.ts` | Page discovery (sitemaps, nav links, crawling) |
| `src/convert.ts` | HTML → markdown conversion + frontmatter |
| `src/detect.ts` | SPA detection heuristics |
| `src/renderer.ts` | Playwright Chromium lifecycle |
| `src/pool.ts` | Worker pool for parallel fetches |
| `src/worker.ts` | Worker logic (fetch + convert) |
| `src/routes.ts` | JS bundle route parsing |
| `src/ua.ts` | User-agent strings |
| `src/ui.ts` | Terminal UI (progress bar, status) |
| `src/write.ts` | Disk output with path preservation |
| `src/sources/` | Source adapters (YouTube, Twitter, Google Drive) |
| `scripts/daemon.ts` | Detached server launcher |
| `ui/` | React web frontend |

## Web UI (`ui/`)

- React 19 with `react-router-dom` v7, served by Bun with on-the-fly TSX transpilation
- Pages: Home (URL input + config), Pull (live WebSocket progress), Results (file tree + markdown preview + search), History (past pulls + global FTS5 search)
- Styles in `ui/src/styles.css` using CSS custom properties (dark theme)
- WebSocket at `/ws` for real-time pull events; REST API at `/api/*`

## Server lifecycle

The server auto-builds the React UI into memory on startup — no manual build step needed. It ignores SIGHUP/SIGTERM (survives terminal closes) and handles SIGINT for graceful shutdown.

| Command | What it does |
|---------|-------------|
| `bun run start` | Starts the server in the foreground (UI auto-built into memory) |
| `bun run dev` | Like `start` but watches `ui/src/` and hot-rebuilds the bundle on changes |
| `bun run server:start` | Starts a detached daemon (survives terminal close) |
| `bun run server:stop` | Kills all running webpull server processes |
| `bun run server:status` | Checks if the server is responding |
| `bun run build:ui` | One-shot UI bundle build to `ui/dist/main.js` (for CI/deploy) |

The UI bundle is built at startup via `buildUI()` in `src/server.ts` using `Bun.build` and cached in memory as a `Buffer`. The `/dist/main.js` route serves from memory; if the build hasn't completed yet, it falls back to `ui/dist/main.js` on disk. Set `WEBPULL_WATCH=1` to enable file-watching auto-rebuild during development.

The daemon launcher is at `scripts/daemon.ts` — it uses `Bun.spawn({ detached: true })` so the server runs in its own process group.

## Testing & verification

- TypeScript: `bun run tsc --noEmit`
- Server smoke: `bun run start` → builds UI, starts on http://localhost:3456
- Browser E2E (Playwright): `WEBPULL_PORT=3461 bun run server:start && WEBPULL_PORT=3461 bun run test/e2e.ts`
- CLI regression: `bun run src/index.ts https://example.com -m 5`
- Database at `~/.webpull/webpull.db` (SQLite WAL mode, FTS5)
- Before publishing: ensure `bun run tsc --noEmit` and `bun run biome check` pass clean