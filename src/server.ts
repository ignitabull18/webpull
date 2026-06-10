import { mkdtempSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { Effect } from "effect"
import {
	createPull,
	deletePull,
	getDoc,
	getPull,
	insertDocuments,
	listDocs,
	listPulls,
	searchDocs,
	searchDocsInPull,
	updatePull,
} from "./db"
import { type PullEvent, runPull } from "./pull"

const PORT = parseInt(process.env.WEBPULL_PORT || "3456", 10)
const UI_DIR = resolve(import.meta.dir, "..", "ui")
const ROOT_DIR = resolve(import.meta.dir, "..")

const activePulls = new Map<string, AbortController>()

const docBuffers = new Map<string, { pullId: string; path: string; url: string; title: string; content: string }[]>()
const FLUSH_THRESHOLD = 50

function flushDocs(pullId: string) {
	const docs = docBuffers.get(pullId)
	if (!docs || docs.length === 0) return
	const batch = docs.splice(0)
	try {
		insertDocuments(batch)
	} catch {}
}

function addDoc(pullId: string, doc: { path: string; url: string; title: string; content: string }) {
	let buffer = docBuffers.get(pullId)
	if (!buffer) {
		buffer = []
		docBuffers.set(pullId, buffer)
	}
	buffer.push({ pullId, ...doc })
	if (buffer.length >= FLUSH_THRESHOLD) flushDocs(pullId)
}

function handlePullEvent(pullId: string, event: PullEvent) {
	if (event.type === "progress" && event.status === "ok" && event.file && event.title !== undefined) {
		addDoc(pullId, { path: event.file, url: event.url, title: event.title ?? "", content: event.content ?? "" })
	} else if (event.type === "complete") {
		flushDocs(pullId)
		updatePull(pullId, { status: "complete", pagesOk: event.ok, pagesErr: event.err })
		activePulls.delete(pullId)
		docBuffers.delete(pullId)
	} else if (event.type === "error") {
		flushDocs(pullId)
		updatePull(pullId, { status: "failed" })
		activePulls.delete(pullId)
		docBuffers.delete(pullId)
	}
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

function error(msg: string, status = 400): Response {
	return json({ error: msg }, status)
}

function serveFile(filepath: string): Response | null {
	try {
		const file = Bun.file(filepath)
		if (!file.size) return null
		const ext = filepath.split(".").pop()
		const types: Record<string, string> = {
			html: "text/html",
			htm: "text/html",
			js: "application/javascript",
			mjs: "application/javascript",
			ts: "application/javascript",
			tsx: "application/javascript",
			css: "text/css",
			svg: "image/svg+xml",
			png: "image/png",
			json: "application/json",
			ico: "image/x-icon",
		}
		return new Response(file, { headers: { "content-type": types[ext!] || "application/octet-stream" } })
	} catch {
		return null
	}
}

function generateId(): string {
	return crypto.randomUUID()
}

const server = Bun.serve({
	port: PORT,
	async fetch(req, server) {
		const url = new URL(req.url)
		const path = url.pathname

		// --- API routes ---

		if (path === "/api/pull" && req.method === "POST") {
			try {
				const body: any = await req.json()
				const { url: targetUrl, outDir, maxPages, workerCount } = body
				if (!targetUrl || typeof targetUrl !== "string") return error("url is required")
				let normalizedUrl = targetUrl
				if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`
				try {
					new URL(normalizedUrl)
				} catch {
					return error("Invalid URL")
				}
				const out = outDir || `./${new URL(normalizedUrl).hostname}`
				const max = maxPages || 500
				const workers = workerCount || 0
				const pullId = generateId()
				createPull({ id: pullId, url: normalizedUrl, outDir: resolve(out), maxPages: max, workerCount: workers })
				const controller = new AbortController()
				activePulls.set(pullId, controller)
				Effect.runPromise(
					runPull(
						{ url: normalizedUrl, out: resolve(out), max, workerCount: workers || undefined, pullId },
						(event: PullEvent) => {
							server.publish("pull-events", JSON.stringify({ pullId, event }))
							handlePullEvent(pullId, event)
						},
					),
				).catch((err) => {
					const errEvent: PullEvent = { type: "error", message: String(err) }
					server.publish("pull-events", JSON.stringify({ pullId, event: errEvent }))
					handlePullEvent(pullId, errEvent)
				})
				return json({ pullId })
			} catch (e) {
				return error(String(e), 500)
			}
		}

		if (path === "/api/pull/docs" && req.method === "POST") {
			try {
				const body: any = await req.json()
				const { pullId, documents } = body
				if (!pullId || !Array.isArray(documents)) return error("pullId and documents[] required")
				insertDocuments(
					documents.map((d: any) => ({ pullId, path: d.path, url: d.url, title: d.title, content: d.content })),
				)
				return json({ ok: true })
			} catch (e) {
				return error(String(e), 500)
			}
		}

		if (path.startsWith("/api/pulls/") && !path.includes("/docs") && req.method === "GET") {
			const id = path.split("/")[3]!
			const pull = getPull(id)
			if (!pull) return error("Not found", 404)
			return json(pull)
		}

		if (path.startsWith("/api/pulls/") && path.endsWith("/docs") && req.method === "GET") {
			const parts = path.split("/")
			const id = parts[3]!
			const docPath = url.searchParams.get("path")
			if (docPath) {
				const doc = getDoc(id, docPath)
				if (!doc) return error("Not found", 404)
				return json(doc)
			}
			return json(listDocs(id))
		}

		if (path === "/api/pulls" && req.method === "GET") {
			return json(listPulls())
		}

		if (path.startsWith("/api/pulls/") && req.method === "DELETE") {
			const id = path.split("/")[3]!
			deletePull(id)
			activePulls.delete(id)
			docBuffers.delete(id)
			return json({ ok: true })
		}

		if (path === "/api/search" && req.method === "GET") {
			const q = url.searchParams.get("q") || ""
			const pullId = url.searchParams.get("pullId") || undefined
			const results = pullId ? searchDocsInPull(pullId, q) : searchDocs(q)
			return json(results)
		}

		// --- Export pull as ZIP ---
		if (path.startsWith("/api/pulls/") && path.endsWith("/export") && req.method === "GET") {
			const parts = path.split("/")
			const id = parts[3]!
			const pull = getPull(id)
			if (!pull) return error("Not found", 404)
			if (pull.status !== "complete") return error("Pull not complete", 400)

			const docs = listDocs(id)
			if (docs.length === 0) return error("No documents", 404)

			// Write docs to temp dir
			const tmpDir = mkdtempSync(`/tmp/webpull-export-${id}-`)
			try {
				for (const doc of docs) {
					const filePath = resolve(tmpDir, doc.path)
					const dir = filePath.substring(0, filePath.lastIndexOf("/"))
					Bun.spawnSync(["mkdir", "-p", dir])
					await Bun.write(filePath, doc.content)
				}
				const summary = `# ${pull.url}\n\nPulled ${pull.pages_ok} pages\n`
				await Bun.write(resolve(tmpDir, "README.md"), summary)

				const zipPath = resolve(tmpDir, "..", `${id}.zip`)
				const proc = Bun.spawnSync(["zip", "-rq", zipPath, "."], { cwd: tmpDir })
				if (proc.exitCode !== 0) return error("Failed to create archive", 500)

				// Read zip into memory so we can clean up immediately
				const zipBytes = await Bun.file(zipPath).arrayBuffer()
				const zipName = (() => {
					try {
						return new URL(pull.url).hostname
					} catch {
						return "docs"
					}
				})()
				return new Response(zipBytes, {
					headers: {
						"content-type": "application/zip",
						"content-disposition": `attachment; filename="${zipName}.zip"`,
					},
				})
			} finally {
				try {
					rmSync(tmpDir, { recursive: true })
				} catch {}
				try {
					Bun.spawnSync(["rm", "-f", resolve(tmpDir, "..", `${id}.zip`)])
				} catch {}
			}
		}

		// --- WebSocket upgrade ---
		if (path === "/ws") {
			if (server.upgrade(req)) return
			return error("WebSocket upgrade failed", 500)
		}

		// --- Static file serving ---

		// node_modules for import map resolution
		if (path.startsWith("/node_modules/")) {
			const res = serveFile(resolve(ROOT_DIR, path.slice(1)))
			if (res) return res
		}

		// Built bundle
		if (path.startsWith("/dist/")) {
			const res = serveFile(resolve(UI_DIR, path.slice(1)))
			if (res) return res
		}

		// UI files
		if (path.startsWith("/src/")) {
			const res = serveFile(resolve(UI_DIR, path.slice(1)))
			if (res) return res
		}

		// Root → index.html
		if (path === "/") {
			const res = serveFile(resolve(UI_DIR, "index.html"))
			if (res) return res
		}

		// SPA fallback: any unmatched route returns index.html
		const indexFile = Bun.file(resolve(UI_DIR, "index.html"))
		if (indexFile.size) {
			return new Response(indexFile, { headers: { "content-type": "text/html" } })
		}

		return error("Not found", 404)
	},

	websocket: {
		open(ws) {
			ws.subscribe("pull-events")
		},
		close(ws) {
			ws.unsubscribe("pull-events")
		},
		message() {},
	},
})

console.log(`\n  ⚡ webpull server · http://localhost:${PORT}\n`)
// Open browser — ignore if it fails (e.g. headless env)
try { Bun.spawn(["open", `http://localhost:${PORT}`], { stdio: ["ignore", "ignore", "ignore"] }) } catch {}

export { server }
