// Smoke test the website CLI path.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const outDir = mkdtempSync(join(tmpdir(), "webpull-cli-"))
const bun = Bun.which("bun") || "bun"

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

try {
	const proc = Bun.spawn({
		cmd: [bun, "run", "src/index.ts", "https://example.com", "-m", "1", "-o", outDir],
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	})
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	const indexPath = join(outDir, "index.md")
	const content = await Bun.file(indexPath)
		.text()
		.catch(() => "")
	const output = `${stderr}\n${stdout}`

	check("CLI exits successfully", code === 0, code === 0 ? "" : output)
	check("CLI writes index.md", await Bun.file(indexPath).exists())
	check("CLI writes markdown content", content.includes("Example Domain"))
	check("CLI prints completion summary", stderr.includes("Done!"))
} finally {
	rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
