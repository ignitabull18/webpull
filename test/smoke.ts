// Self-contained smoke runner for both app surfaces.
// Starts a temporary server, runs the browser UI and MCP app smoke tests, then stops it.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const PORT = process.env.WEBPULL_PORT || String(4100 + Math.floor(Math.random() * 1000))
const BASE_URL = `http://127.0.0.1:${PORT}`
const tempDir = mkdtempSync(join(tmpdir(), "webpull-smoke-"))
const LOG_PATH = join(tempDir, "server.log")
const DB_DIR = join(tempDir, "db")
const bun = Bun.which("bun") || "bun"

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForServer() {
	const startedAt = Date.now()
	while (Date.now() - startedAt < 15000) {
		try {
			const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(1000) })
			if (res.ok) return
		} catch {}
		await sleep(250)
	}
	const log = await Bun.file(LOG_PATH)
		.text()
		.catch(() => "")
	throw new Error(`Server did not start on ${BASE_URL}.\n${log}`)
}

async function runTest(label: string, script: string) {
	console.log(`\n${label}`)
	const proc = Bun.spawn({
		cmd: [bun, "run", script],
		cwd: ROOT,
		env: { ...process.env, WEBPULL_DB_DIR: DB_DIR, WEBPULL_PORT: PORT },
		stdout: "inherit",
		stderr: "inherit",
	})
	const code = await proc.exited
	if (code !== 0) throw new Error(`${label} failed with exit code ${code}`)
}

const server = Bun.spawn({
	cmd: [bun, "run", "src/index.ts", "--server"],
	cwd: ROOT,
	env: { ...process.env, WEBPULL_DB_DIR: DB_DIR, WEBPULL_PORT: PORT },
	stdout: Bun.file(LOG_PATH),
	stderr: Bun.file(LOG_PATH),
})

try {
	await waitForServer()
	console.log(`webpull smoke server ready at ${BASE_URL}`)
	await runTest("REST API smoke", "test/api.ts")
	await runTest("Browser UI smoke", "test/e2e.ts")
	await runTest("ChatGPT/Codex MCP smoke", "test/mcp.ts")
	console.log("\nSmoke tests passed")
} finally {
	server.kill()
	await server.exited.catch(() => undefined)
	rmSync(tempDir, { recursive: true, force: true })
}
