# webpull

Pull any public docs site into local markdown files.

```
$ webpull https://docs.example.com

  ⚡ webpull · 16 workers
  docs.example.com → ./docs.example.com

  ●●●·●●●●·●●●●●●●·
  ├─ ✓ getting-started/installation.md
  ├─ ✓ api/authentication.md
  ├─ ✓ guides/deployment.md
  █████████████░░░░░░░ 68% 102/150 · 6p/s · 17.2s
```

## Install

```bash
bun install -g webpull
```

## Usage

```
webpull <url> [options]

Options:
  -o, --out <dir>   Output directory (default: ./<hostname>)
  -m, --max <n>     Max pages to pull (default: 500)
```

## Examples

```bash
# Pull React docs
webpull https://react.dev/reference

# Custom output dir, limit to 100 pages
webpull https://docs.python.org -o ./python-docs -m 100
```

## ChatGPT / Codex app

webpull also exposes an Apps SDK-compatible MCP endpoint with an embedded widget.

```bash
bun run start
```

The MCP endpoint is:

```text
http://localhost:3456/mcp
```

Opening `/mcp` in a normal browser shows a small status page. The embedded app UI appears inside ChatGPT or Codex when the `webpull_open_app` tool is invoked. The regular browser UI remains available at:

```text
http://localhost:3456/
```

For ChatGPT Developer Mode, expose that endpoint over HTTPS with Secure MCP Tunnel, ngrok, or Cloudflare Tunnel, then create a connector that points to:

```text
https://your-tunnel.example/mcp
```

Available tools:

- `webpull_open_app` opens the full interactive ChatGPT app widget.
- `webpull_start_pull` starts a public docs pull into local markdown.
- `webpull_list_pulls` lists recent pulls and statuses.
- `webpull_show_pull` shows one pull and its pulled documents.
- `search` searches the pulled markdown archive.
- `fetch` returns exact markdown for a document returned by search.

## How it works

1. **Discovers pages** via sitemap.xml, nav link extraction, JS bundle route parsing, or link crawling
2. **Fetches in parallel** using a worker pool sized to your CPU cores
3. **Renders SPAs** with headless Chromium when JavaScript-rendered content is detected
4. **Converts to markdown** using [Defuddle](https://github.com/nichochar/defuddle) for intelligent content extraction
5. **Writes to disk** preserving the URL path structure with YAML frontmatter

Each markdown file includes metadata:

```yaml
---
title: "Getting Started"
url: "https://docs.example.com/getting-started"
---
```

## Requirements

- [Bun](https://bun.sh) runtime
- [Playwright](https://playwright.dev) Chromium (auto-used for SPAs; install with `npx playwright install chromium`)

## Verification

Use the smoke tests to check the main app surfaces:

```bash
bun run test:smoke
```

This starts an isolated temporary local server and database, then runs the REST API pull flow, browser UI smoke test, and ChatGPT/Codex MCP app smoke test.

Before publishing or opening a PR, run the full local gate:

```bash
bun run biome check
bun run tsc --noEmit
bun run test:db
bun run test:cli
bun run build:ui
bun run test:pack
bun run test:packed-runtime
bun run test:smoke
```

## License

MIT
