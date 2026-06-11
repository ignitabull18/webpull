import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { Effect } from "effect"
import { handleMcpRequest } from "./chatgpt-app"
import {
	createProject,
	createPull,
	deleteProject,
	deletePull,
	getDoc,
	getDocById,
	getProject,
	getProjectDocCount,
	getPull,
	insertDocuments,
	listDocs,
	listDocsByProject,
	listProjects,
	listPulls,
	listPullsByProject,
	type SearchResult,
	searchDocs,
	searchDocsInProject,
	searchDocsInPull,
	setPullProject,
	updateProject,
	updatePull,
} from "./db"
import { type PullEvent, runPull } from "./pull"

const PORT = parseInt(process.env.WEBPULL_PORT || "3456", 10)
const UI_DIR = resolve(import.meta.dir, "..", "ui")
const ROOT_DIR = resolve(import.meta.dir, "..")
const PULLS_DIR = resolve(ROOT_DIR, "pulls")

// Ensure pulls directory exists
try {
	mkdirSync(PULLS_DIR, { recursive: true })
} catch {}

// --- opencli helpers ---

function getDoctorResult(): { installed: boolean; connected: boolean } {
	try {
		const out = execSync("opencli doctor", { encoding: "utf8", timeout: 8000 })
		return {
			installed: true,
			connected: out.includes("[OK] Extension"),
		}
	} catch {
		return { installed: false, connected: false }
	}
}

function getYtDlpInstalled(): boolean {
	try {
		execSync("yt-dlp --version", { encoding: "utf8", timeout: 5000 })
		return true
	} catch {
		return false
	}
}

function getGwsAuthStatus(): { installed: boolean; authenticated: boolean } {
	try {
		const out = execSync("opencli gws auth status", { encoding: "utf8", timeout: 8000 })
		if (out.includes("Authenticated")) return { installed: true, authenticated: true }
		return { installed: true, authenticated: false }
	} catch {
		return { installed: false, authenticated: false }
	}
}

// --- In-memory UI bundle (auto-built on startup) ---
let uiBundle: Buffer | null = null

async function buildUI(): Promise<Buffer> {
	const entry = resolve(UI_DIR, "src", "main.tsx")
	const result = await Bun.build({
		entrypoints: [entry],
		outdir: "/tmp/webpull-ui-build",
		target: "browser",
	})
	if (!result.success) {
		for (const log of result.logs) console.error("[UI build]", log)
		throw new Error("UI build failed")
	}
	return Buffer.from(await Bun.file(resolve("/tmp/webpull-ui-build", "main.js")).arrayBuffer())
}

buildUI()
	.then((bytes) => {
		uiBundle = bytes
	})
	.catch((err) => console.error("UI build error:", err))

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

function resolveInside(root: string, childPath: string): string | null {
	const full = resolve(root, childPath)
	const rel = relative(resolve(root), full)
	if (rel.startsWith("..") || isAbsolute(rel)) return null
	return full
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

		if (path === "/mcp") {
			return handleMcpRequest(req)
		}

		// --- API routes ---

		if (path === "/api/pull" && req.method === "POST") {
			try {
				const body: any = await req.json()
				const { url: targetUrl, source, target, dest, outDir, maxPages, workerCount, projectId } = body
				const isSourcePull = !!(source && target)
				const pullUrl = isSourcePull ? target : targetUrl
				if (!pullUrl || typeof pullUrl !== "string") return error("url or target is required")
				let normalizedUrl = pullUrl
				if (!isSourcePull && !/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`
				if (!isSourcePull) {
					try {
						new URL(normalizedUrl)
					} catch {
						return error("Invalid URL")
					}
				}
				const out = outDir || `./${isSourcePull ? "pulls" : new URL(normalizedUrl).hostname}`
				const max = maxPages || 500
				const workers = workerCount || 0
				const pullId = generateId()
				createPull({
					id: pullId,
					url: normalizedUrl,
					source: source || "",
					dest: dest || "",
					outDir: resolve(out),
					maxPages: max,
					workerCount: workers,
					projectId: projectId || undefined,
				})
				const controller = new AbortController()
				activePulls.set(pullId, controller)
				Effect.runPromise(
					runPull(
						{
							url: normalizedUrl,
							out: resolve(out),
							max,
							workerCount: workers || undefined,
							pullId,
							signal: controller.signal,
						},
						(event: PullEvent) => {
							server.publish("pull-events", JSON.stringify({ pullId, event }))
							handlePullEvent(pullId, event)
						},
					),
				).catch((err) => {
					if (controller.signal.aborted) return
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

		if (
			path.startsWith("/api/pulls/") &&
			!path.includes("/docs") &&
			!path.endsWith("/export") &&
			!path.endsWith("/project") &&
			req.method === "GET"
		) {
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
			activePulls.get(id)?.abort()
			deletePull(id)
			activePulls.delete(id)
			docBuffers.delete(id)
			return json({ ok: true })
		}

		if (path === "/api/search" && req.method === "GET") {
			const q = url.searchParams.get("q") || ""
			const pullId = url.searchParams.get("pullId") || undefined
			const projectId = url.searchParams.get("projectId") || undefined
			const limit = parseInt(url.searchParams.get("limit") || "50", 10)
			let results: SearchResult[]
			if (pullId) {
				results = searchDocsInPull(pullId, q, limit)
			} else if (projectId) {
				results = searchDocsInProject(projectId, q, limit)
			} else {
				results = searchDocs(q, limit)
			}
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

			const tmpDir = mkdtempSync(`/tmp/webpull-export-${id}-`)
			try {
				for (const doc of docs) {
					const filePath = resolveInside(tmpDir, doc.path)
					if (!filePath) return error(`Unsafe document path: ${doc.path}`, 400)
					mkdirSync(dirname(filePath), { recursive: true })
					await Bun.write(filePath, doc.content)
				}
				const summary = `# ${pull.url}\n\nPulled ${pull.pages_ok} pages\n`
				await Bun.write(resolve(tmpDir, "README.md"), summary)

				const zipPath = resolve(tmpDir, "..", `${id}.zip`)
				const proc = Bun.spawnSync(["zip", "-rq", zipPath, "."], { cwd: tmpDir })
				if (proc.exitCode !== 0) return error("Failed to create archive", 500)

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

		// --- Document single ---

		if (path.startsWith("/api/docs/") && req.method === "GET") {
			const docId = parseInt(path.split("/")[3]!, 10)
			if (Number.isNaN(docId)) return error("Invalid doc id", 400)
			const doc = getDocById(docId)
			if (!doc) return error("Not found", 404)
			return json(doc)
		}

		// --- Project CRUD ---

		if (path === "/api/projects" && req.method === "GET") {
			return json(listProjects())
		}

		if (path === "/api/projects" && req.method === "POST") {
			try {
				const body: any = await req.json()
				const { name, description } = body
				if (!name || typeof name !== "string") return error("name is required")
				const project = createProject(name, description || "")
				return json(project)
			} catch (_e: any) {
				return error(String(_e), 500)
			}
		}

		if (path.startsWith("/api/projects/") && req.method === "GET") {
			const id = path.split("/")[3]!
			if (url.searchParams.get("docs") === "1") {
				return json(listDocsByProject(id))
			}
			if (url.searchParams.get("pulls") === "1") {
				return json(listPullsByProject(id))
			}
			const project = getProject(id)
			if (!project) return error("Not found", 404)
			const docCount = getProjectDocCount(id)
			return json({ ...project, docCount })
		}

		if (path.startsWith("/api/projects/") && req.method === "PUT") {
			try {
				const id = path.split("/")[3]!
				const body: any = await req.json()
				updateProject(id, { name: body.name, description: body.description })
				return json({ ok: true })
			} catch (_e: any) {
				return error(String(_e), 500)
			}
		}

		if (path.startsWith("/api/projects/") && req.method === "DELETE") {
			const id = path.split("/")[3]!
			deleteProject(id)
			return json({ ok: true })
		}

		// --- Move pull to/from project ---

		if (path.startsWith("/api/pulls/") && path.endsWith("/project") && req.method === "PUT") {
			try {
				const id = path.split("/")[3]!
				const body: any = await req.json()
				setPullProject(id, body.projectId || null)
				return json({ ok: true })
			} catch (_e: any) {
				return error(String(_e), 500)
			}
		}

		// --- Source/destination status ---

		if (path === "/api/source-status" && req.method === "GET") {
			const doctor = getDoctorResult()
			getYtDlpInstalled()
			const gws = getGwsAuthStatus()
			return json({
				youtube: {
					installed: doctor.connected,
					authenticated: doctor.connected,
					message: doctor.connected
						? "Ready"
						: "Chrome extension not connected. Install from https://github.com/jackwener/opencli/releases",
				},
				twitter: {
					installed: doctor.connected,
					authenticated: doctor.connected,
					message: doctor.connected
						? "Ready"
						: "Chrome extension not connected. Install from https://github.com/jackwener/opencli/releases",
				},
				gdrive: {
					installed: gws.installed,
					authenticated: gws.authenticated,
					message: gws.authenticated ? "Authenticated" : "Run gws auth login to connect Google Drive",
				},
			})
		}

		if (path === "/api/destination-status" && req.method === "GET") {
			const gws = getGwsAuthStatus()
			return json({
				gdrive: {
					installed: gws.installed,
					authenticated: gws.authenticated,
					message: gws.authenticated ? "Ready to push" : "Run gws auth login to connect",
				},
			})
		}

		if (path === "/api/drive/folders" && req.method === "GET") {
			return json({ folders: [] })
		}

		if (path === "/api/source/preview" && req.method === "POST") {
			const body: any = await req.json().catch(() => ({}))
			const { source, target } = body
			if (!source || !target) return error("source and target required")
			return json({ items: [], total: 0 })
		}

		if (path === "/api/destination/push" && req.method === "POST") {
			const body: any = await req.json().catch(() => ({}))
			const { pullId, destination } = body
			if (!pullId || !destination) return error("pullId and destination required")
			const gws = getGwsAuthStatus()
			if (!gws.authenticated)
				return error("Google Drive not authenticated. Click the Connect button in the Pull tab to sign in first.", 401)
			return json({ ok: 0, err: 0, files: [], note: "Google Drive push not yet implemented" })
		}

		if (path === "/api/auth/gdrive" && req.method === "POST") {
			return new Promise((resolve) => {
				try {
					Bun.spawn(["opencli", "gws", "auth", "login"], {
						env: { ...process.env },
						onExit(_proc, exitCode, signalCode) {
							if (exitCode === 0) resolve(json({ ok: true }))
							else resolve(error(signalCode ? "Login cancelled" : "Login failed", 500))
						},
					})
				} catch (e) {
					resolve(error(String(e), 500))
				}
			})
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

		// Built bundle (in-memory or fallback to disk)
		if (path === "/dist/main.js") {
			if (uiBundle) {
				return new Response(uiBundle as any, {
					headers: { "content-type": "application/javascript" },
				})
			}
			const res = serveFile(resolve(UI_DIR, "dist", "main.js"))
			if (res) return res
		}
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
try {
	Bun.spawn(["open", `http://localhost:${PORT}`], { stdio: ["ignore", "ignore", "ignore"] })
} catch {}

export { server }
