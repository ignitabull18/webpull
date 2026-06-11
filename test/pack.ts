// Smoke test for npm package contents.
// Run after bun run build:ui so ui/dist/main.js exists.
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

function readNpmPackJson(stdout: string) {
	const start = stdout.indexOf("[")
	const end = stdout.lastIndexOf("]")
	if (start === -1 || end === -1 || end < start) throw new Error(`npm pack did not return JSON:\n${stdout}`)
	return JSON.parse(stdout.slice(start, end + 1))
}

const npm = Bun.which("npm") || "npm"
const proc = Bun.spawn({
	cmd: [npm, "pack", "--dry-run", "--json"],
	stdout: "pipe",
	stderr: "pipe",
})

const [code, stdout, stderr] = await Promise.all([
	proc.exited,
	new Response(proc.stdout).text(),
	new Response(proc.stderr).text(),
])

if (code !== 0) {
	console.error(stderr)
	process.exit(code)
}

const pack = readNpmPackJson(stdout)[0]
const files = new Set<string>(pack.files.map((file: { path: string }) => file.path))

for (const path of [
	"bin/webpull",
	"src/index.ts",
	"src/server.ts",
	"src/chatgpt-app.ts",
	"src/chatgpt-widget.html",
	"ui/index.html",
	"ui/src/main.tsx",
	"ui/dist/main.js",
	"scripts/daemon.ts",
	"package.json",
	"README.md",
	"LICENSE",
]) {
	check(`package includes ${path}`, files.has(path))
}

for (const path of [
	".github/workflows/ci.yml",
	"test/smoke.ts",
	"docs/index.md",
	"example.com/index.md",
	"pulls/mcp-smoke-example/index.md",
	"src/.tmp-push/index.md",
	"download.html",
]) {
	check(`package excludes ${path}`, !files.has(path))
}

check("package has a compact file count", pack.entryCount < 80, `${pack.entryCount} entries`)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
