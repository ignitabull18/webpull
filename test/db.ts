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

	const project = db.createProject("Collector")
	const source = db.createSavedSource({
		name: "Example Docs",
		url: "https://example.com/docs",
		projectId: project.id,
		cadence: "daily",
		config: { maxPages: 10 },
	})
	check("saved source is created with project", source.project_id === project.id, source.project_id || "")
	check("saved source has next refresh", !!source.next_refresh_at, source.next_refresh_at || "")

	db.updateSavedSource(source.id, { cadence: "weekly", config: { maxPages: 20 } })
	const updatedSource = db.getSavedSource(source.id)
	check("saved source update persists cadence", updatedSource?.cadence === "weekly", updatedSource?.cadence)
	check(
		"saved source update persists config",
		updatedSource?.config_json.includes("20") === true,
		updatedSource?.config_json,
	)

	db.updateSavedSource(source.id, { nextRefreshAt: "2000-01-01T00:00:00.000Z" })
	const due = db.listDueSavedSources(new Date("2000-01-02T00:00:00.000Z"))
	check(
		"due saved sources are listed",
		due.some((row) => row.id === source.id),
		`${due.length} due`,
	)

	db.createPull({
		id: "pull-source-1",
		url: source.url,
		sourceId: source.id,
		outDir: "/tmp/webpull-db/source-1",
		maxPages: 10,
		workerCount: 1,
		projectId: project.id,
	})
	db.insertDocuments([
		{
			pullId: "pull-source-1",
			path: "a.md",
			url: "https://example.com/docs/a",
			title: "A",
			content: "same content",
		},
		{
			pullId: "pull-source-1",
			path: "b.md",
			url: "https://example.com/docs/b",
			title: "B",
			content: "old content",
		},
	])
	const firstSummary = db.getPullChangeSummary("pull-source-1")
	check("first source run marks documents new", firstSummary.new === 2, JSON.stringify(firstSummary))

	db.markSavedSourceRefreshed(source.id, "pull-source-1", new Date("2026-01-01T00:00:00.000Z"))
	const refreshedSource = db.getSavedSource(source.id)
	check(
		"saved source records last pull",
		refreshedSource?.last_pull_id === "pull-source-1",
		refreshedSource?.last_pull_id || "",
	)

	db.createPull({
		id: "pull-source-2",
		url: source.url,
		sourceId: source.id,
		outDir: "/tmp/webpull-db/source-2",
		maxPages: 10,
		workerCount: 1,
		projectId: project.id,
	})
	db.insertDocuments([
		{
			pullId: "pull-source-2",
			path: "a.md",
			url: "https://example.com/docs/a",
			title: "A",
			content: "same content",
		},
		{
			pullId: "pull-source-2",
			path: "b.md",
			url: "https://example.com/docs/b",
			title: "B",
			content: "new content",
		},
		{
			pullId: "pull-source-2",
			path: "c.md",
			url: "https://example.com/docs/c",
			title: "C",
			content: "brand new",
		},
	])
	const secondSummary = db.getPullChangeSummary("pull-source-2")
	check("second source run marks unchanged", secondSummary.unchanged === 1, JSON.stringify(secondSummary))
	check("second source run marks changed", secondSummary.changed === 1, JSON.stringify(secondSummary))
	check("second source run marks new", secondSummary.new === 1, JSON.stringify(secondSummary))

	db.createPull({
		id: "pull-source-3",
		url: source.url,
		sourceId: source.id,
		outDir: "/tmp/webpull-db/source-3",
		maxPages: 10,
		workerCount: 1,
		projectId: project.id,
	})
	db.insertDocuments([
		{
			pullId: "pull-source-3",
			path: "a.md",
			url: "https://example.com/docs/a",
			title: "A",
			content: "same content",
		},
	])
	const removed = db.recordRemovedDocumentsForPull("pull-source-3")
	const thirdSummary = db.getPullChangeSummary("pull-source-3")
	check("removed documents are recorded", removed === 2, `${removed} removed`)
	check("removed documents appear in change summary", thirdSummary.removed === 2, JSON.stringify(thirdSummary))

	const version = db.listDocumentChanges("pull-source-2").find((row) => row.path === "b.md")
	const changedDoc = db.getDoc("pull-source-2", "b.md")
	if (changedDoc && version) {
		const diagnostic = db.recordDocumentDiagnostics({
			documentId: changedDoc.id,
			versionId: version.id,
			extractionConfidence: 0.82,
			wordCount: 2,
			titleFound: true,
			markdownQuality: 0.9,
			renderMode: "chromium",
			failedSelectors: ["main .missing"],
		})
		const extract = db.createStructuredExtract({
			documentId: changedDoc.id,
			versionId: version.id,
			kind: "entities",
			data: { entities: ["Example"] },
		})
		const ask = db.createAskSession({ question: "What changed?", answer: "B changed.", bucketIds: ["bucket-1"] })
		const citation = db.addAskCitation({
			sessionId: ask.id,
			documentId: changedDoc.id,
			versionId: version.id,
			sourceUrl: changedDoc.url,
			title: changedDoc.title,
			path: changedDoc.path,
			pullId: changedDoc.pull_id,
			bucketId: "bucket-1",
			snippet: "new content",
		})
		check("diagnostics are recorded", diagnostic.render_mode === "chromium", diagnostic.render_mode)
		check("structured extracts are recorded", extract.kind === "entities", extract.kind)
		check("Ask citations are recorded", db.listAskCitations(ask.id)[0]?.id === citation.id, `${citation.id}`)
	} else {
		check("changed document version exists", false)
	}

	const exportJob = db.createExportJob({
		pullId: "pull-source-2",
		projectId: project.id,
		sourceId: source.id,
		destination: "github",
		format: "json",
		metadata: { branch: "docs" },
	})
	db.updateExportJob(exportJob.id, { status: "complete", outputUrl: "https://example.com/export.zip" })
	const completedExport = db.getExportJob(exportJob.id)
	check("export job status updates", completedExport?.status === "complete", completedExport?.status)
	check(
		"export job output is stored",
		completedExport?.output_url === "https://example.com/export.zip",
		completedExport?.output_url || "",
	)
} finally {
	rmSync(dbDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
