// Smoke test the npm tarball itself, not just the working tree.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const PORT = process.env.WEBPULL_PACKED_PORT || String(5200 + Math.floor(Math.random() * 1000))
const BASE_URL = `http://127.0.0.1:${PORT}`
const npm = Bun.which("npm") || "npm"
const bun = Bun.which("bun") || "bun"
const tempDir = mkdtempSync(join(tmpdir(), "webpull-packed-"))
const packageDir = join(tempDir, "package")
const logPath = join(tempDir, "server.log")

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
	if (condition) {
		console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`)
		passed++
	} else {
		console.log(`  ✗ ${name}${detail ? ` (${detail})` : ""}`)
		failed++
	}
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function run(cmd: string[], cwd = ROOT) {
	const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" })
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	if (code !== 0) throw new Error(`${cmd.join(" ")} failed with exit code ${code}\n${stdout}\n${stderr}`)
	return { stdout, stderr }
}

function readNpmPackJson(stdout: string) {
	const start = stdout.indexOf("[")
	const end = stdout.lastIndexOf("]")
	if (start === -1 || end === -1 || end < start) throw new Error(`npm pack did not return JSON:\n${stdout}`)
	return JSON.parse(stdout.slice(start, end + 1))
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
	const log = await Bun.file(logPath)
		.text()
		.catch(() => "")
	throw new Error(`Packed server did not start on ${BASE_URL}.\n${log}`)
}

mkdirSync(packageDir, { recursive: true })

let server: ReturnType<typeof Bun.spawn> | null = null

try {
	const { stdout } = await run([npm, "pack", "--json"])
	const tarball = readNpmPackJson(stdout)[0]?.filename
	if (!tarball) throw new Error("npm pack did not return a tarball filename")

	await run(["tar", "-xzf", tarball, "-C", tempDir])

	const pkg = await Bun.file(join(packageDir, "package.json")).json()
	check("packed package keeps CLI bin", pkg.bin?.webpull === "bin/webpull")
	check("packed package has built UI", await Bun.file(join(packageDir, "ui", "dist", "main.js")).exists())
	check("packed package has ChatGPT widget", await Bun.file(join(packageDir, "src", "chatgpt-widget.html")).exists())

	server = Bun.spawn({
		cmd: [bun, "run", "bin/webpull", "--server"],
		cwd: packageDir,
		env: { ...process.env, NODE_PATH: join(ROOT, "node_modules"), WEBPULL_PORT: PORT },
		stdout: Bun.file(logPath),
		stderr: Bun.file(logPath),
	})

	await waitForServer()
	const [home, mcpLanding] = await Promise.all([
		fetch(BASE_URL),
		fetch(`${BASE_URL}/mcp`, { headers: { accept: "text/html" } }),
	])
	const homeText = await home.text()
	const landingText = await mcpLanding.text()
	check("packed server serves browser UI", home.ok && homeText.includes('<div id="root"></div>'))
	check("packed server serves MCP landing", mcpLanding.ok && landingText.includes("webpull_open_app"))
} finally {
	server?.kill()
	await server?.exited.catch(() => undefined)
	rmSync(tempDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
