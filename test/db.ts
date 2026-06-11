// Smoke tests for local SQLite persistence behavior.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dbDir = mkdtempSync(join(tmpdir(), "webpull-db-"))
process.env.WEBPULL_DB_DIR = dbDir

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
	const db = await import("../src/db")
	db.createPull({ id: "pull-1", url: "https://example.com", outDir: "/tmp/webpull-db", maxPages: 1, workerCount: 1 })

	db.insertDocuments([
		{ pullId: "pull-1", path: "index.md", url: "https://example.com/old", title: "Old", content: "old content" },
	])
	db.insertDocuments([
		{ pullId: "pull-1", path: "index.md", url: "https://example.com/new", title: "New", content: "new content" },
	])

	const docs = db.listDocs("pull-1")
	const doc = db.getDoc("pull-1", "index.md")
	const search = db.searchDocsInPull("pull-1", "new", 10)

	check("documents are unique by pull/path", docs.length === 1, `${docs.length} docs`)
	check("duplicate insert updates title", doc?.title === "New", doc?.title)
	check("duplicate insert updates url", doc?.url === "https://example.com/new", doc?.url)
	check("duplicate insert updates content", doc?.content === "new content", doc?.content)
	check(
		"FTS search sees updated content",
		search.length === 1 && search[0]?.title === "New",
		`${search.length} results`,
	)
} finally {
	rmSync(dbDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
