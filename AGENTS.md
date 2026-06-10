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
| `ui/` | React web frontend |

## Web UI (`ui/`)

- React 19 with `react-router-dom` v7, served by Bun with on-the-fly TSX transpilation
- Pages: Home (URL input + config), Pull (live WebSocket progress), Results (file tree + markdown preview + search), History (past pulls + global FTS5 search)
- Styles in `ui/src/styles.css` using CSS custom properties (dark theme)
- WebSocket at `/ws` for real-time pull events; REST API at `/api/*`

## Testing & verification

- TypeScript: `bun run tsc --noEmit`
- Server smoke: `bun run src/index.ts` (no args) → opens http://localhost:3457
- CLI regression: `bun run src/index.ts https://example.com -m 5`
- Database at `~/.webpull/webpull.db` (SQLite WAL mode, FTS5)
- Before publishing: ensure `bun run biome check` passes clean
EOF