// Smoke test the REST API pull flow.
// Requires the server to be running. Set WEBPULL_PORT env var to match.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PORT = process.env.WEBPULL_PORT || "3456"
const BASE_URL = `http://127.0.0.1:${PORT}`
const outDir = mkdtempSync(join(tmpdir(), "webpull-api-"))

let passed = 0
let failed = 0
let pullId = ""

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

async function jsonFetch(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE_URL}${path}`, init)
	const text = await res.text()
	let body: any = null
	try {
		body = text ? JSON.parse(text) : null
	} catch {
		body = text
	}
	return { res, body }
}

async function waitForPull(id: string) {
	const startedAt = Date.now()
	while (Date.now() - startedAt < 30000) {
		const { res, body } = await jsonFetch(`/api/pulls/${id}`)
		if (!res.ok) throw new Error(`Failed to load pull ${id}: ${JSON.stringify(body)}`)
		if (body.status === "complete" || body.status === "failed") return body
		await sleep(500)
	}
	throw new Error(`Timed out waiting for pull ${id}`)
}

try {
	const start = await jsonFetch("/api/pull", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ url: "https://example.com", maxPages: 1, workerCount: 2, outDir }),
	})
	pullId = start.body?.pullId ?? ""
	check("POST /api/pull starts a pull", start.res.ok && !!pullId, start.res.ok ? pullId : JSON.stringify(start.body))

	if (pullId) {
		const pull = await waitForPull(pullId)
		check("REST pull completes", pull.status === "complete", pull.status)
		check("REST pull records one successful page", pull.pages_ok === 1, `${pull.pages_ok} ok`)
		check("REST pull records no errors", pull.pages_err === 0, `${pull.pages_err} err`)

		const docs = await jsonFetch(`/api/pulls/${pullId}/docs`)
		check("GET /api/pulls/:id/docs returns docs", docs.res.ok && Array.isArray(docs.body) && docs.body.length === 1)
		const doc = Array.isArray(docs.body) ? docs.body[0] : null
		check("REST doc has title", doc?.title === "Example Domain", doc?.title)
		check(
			"REST doc has markdown content",
			typeof doc?.content === "string" && doc.content.includes("documentation examples"),
		)

		const search = await jsonFetch(`/api/search?q=${encodeURIComponent("Example Domain")}&pullId=${pullId}&limit=5`)
		check("GET /api/search finds pulled doc", search.res.ok && Array.isArray(search.body) && search.body.length >= 1)

		const fileContent = await Bun.file(join(outDir, "index.md"))
			.text()
			.catch(() => "")
		check("REST pull writes output file", fileContent.includes("Example Domain"))

		const unsafeDocs = await jsonFetch("/api/pull/docs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pullId,
				documents: [
					{
						path: "../../escape.md",
						url: "https://example.com/escape",
						title: "Unsafe",
						content: "unsafe",
					},
				],
			}),
		})
		check("POST /api/pull/docs can add test doc", unsafeDocs.res.ok)
		const unsafeExport = await fetch(`${BASE_URL}/api/pulls/${pullId}/export`)
		check("Export rejects unsafe document paths", unsafeExport.status === 400, String(unsafeExport.status))
	}

	const cancelOutDir = mkdtempSync(join(tmpdir(), "webpull-api-cancel-"))
	const cancelStart = await jsonFetch("/api/pull", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ url: "https://example.com", maxPages: 10, workerCount: 2, outDir: cancelOutDir }),
	})
	const cancelPullId = cancelStart.body?.pullId ?? ""
	check("POST /api/pull starts cancellable pull", cancelStart.res.ok && !!cancelPullId)
	if (cancelPullId) {
		const deleted = await fetch(`${BASE_URL}/api/pulls/${cancelPullId}`, { method: "DELETE" })
		check("DELETE /api/pulls/:id cancels pull", deleted.ok)
		await sleep(1000)
		const deletedPull = await jsonFetch(`/api/pulls/${cancelPullId}`)
		check("Cancelled pull stays deleted", deletedPull.res.status === 404, String(deletedPull.res.status))
	}
	rmSync(cancelOutDir, { recursive: true, force: true })
} finally {
	if (pullId) {
		await fetch(`${BASE_URL}/api/pulls/${pullId}`, { method: "DELETE" }).catch(() => undefined)
	}
	rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
