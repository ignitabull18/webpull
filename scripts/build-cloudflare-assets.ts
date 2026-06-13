import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const outDir = resolve(root, "cloudflare", "dist")

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const result = await Bun.build({
	entrypoints: [resolve(root, "ui", "src", "main.tsx")],
	outdir: outDir,
	target: "browser",
})

if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}

copyFileSync(resolve(root, "ui", "src", "styles.css"), resolve(outDir, "styles.css"))

const html = await readFile(resolve(root, "ui", "index.html"), "utf8")
await writeFile(
	resolve(outDir, "index.html"),
	html.replace("/src/styles.css", "/styles.css").replace("/dist/main.js", "/main.js"),
)

await writeFile(
	resolve(outDir, "_headers"),
	`/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' ws: wss: https://cloudflareinsights.com; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
`,
)
