import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { Effect } from "effect"
import { handleMcpRequest } from "./chatgpt-app"
import {
	addAskCitation,
	createAskSession,
	createExportJob,
	createProject,
	createPull,
	createSavedSource,
	createStructuredExtract,
	deleteProject,
	deletePull,
	deleteSavedSource,
	getDoc,
	getDocById,
	getProject,
	getProjectDocCount,
	getPull,
	getPullChangeSummary,
	getSavedSource,
	insertDocuments,
	listDocs,
	listDocsByProject,
	listDocumentChanges,
	listDocumentDiagnostics,
	listDueSavedSources,
	listExportJobs,
	listProjects,
	listPulls,
	listPullsByProject,
	listSavedSources,
	listStructuredExtracts,
	markSavedSourceRefreshed,
	recordDocumentDiagnostics,
	recordRemovedDocumentsForPull,
	type SearchResult,
	searchDocs,
	searchDocsInProject,
	searchDocsInPull,
	setPullProject,
	updateProject,
	updatePull,
	updateSavedSource,
} from "./db"
import { type PullEvent, runPull } from "./pull"
import {
	gdriveAdapter,
	type SourceAdapter,
	type SourceConfig,
	type SourceItem,
	twitterAdapter,
	youtubeAdapter,
} from "./sources"
import { write } from "./write"

const PORT = parseInt(process.env.WEBPULL_PORT || "3456", 10)
const UI_DIR = resolve(import.meta.dir, "..", "ui")
const ROOT_DIR = resolve(import.meta.dir, "..")
const PULLS_DIR = resolve(ROOT_DIR, "pulls")

// Ensure pulls directory exists
try {
	mkdirSync(PULLS_DIR, { recursive: true })
} catch {}

// --- CLI auth helpers ---

function getOpenCliConnected(): boolean {
	try {
		const out = execSync("opencli doctor", { encoding: "utf8", timeout: 1500 })
		return out.includes("[OK] Extension")
	} catch {
		return false
	}
}

function getYtDlpStatus(): { installed: boolean; authenticated: boolean; message: string } {
	try {
		const version = execSync("yt-dlp --version", { encoding: "utf8", timeout: 1500 }).trim()
		return { installed: true, authenticated: true, message: `Ready with yt-dlp ${version}` }
	} catch {
		const connected = getOpenCliConnected()
		return {
			installed: connected,
			authenticated: connected,
			message: connected
				? "Ready with OpenCLI Chrome session"
				: "Install yt-dlp or connect the OpenCLI Chrome extension.",
		}
	}
}

function getTwitterStatus(): { installed: boolean; authenticated: boolean; message: string } {
	const connected = getOpenCliConnected()
	return {
		installed: connected,
		authenticated: connected,
		message: connected
			? "Ready with OpenCLI Chrome session"
			: "Connect the OpenCLI Chrome extension for X/Twitter sources.",
	}
}

function getGwsAuthStatus(): { installed: boolean; authenticated: boolean } {
	try {
		const out = execSync("opencli gws auth status", { encoding: "utf8", timeout: 1500 })
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
const SOURCE_ADAPTERS: Record<string, SourceAdapter> = {
	youtube: youtubeAdapter,
	twitter: twitterAdapter,
	gdrive: gdriveAdapter,
}

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
		recordRemovedDocumentsForPull(pullId)
		updatePull(pullId, { status: "complete", pagesOk: event.ok, pagesErr: event.err })
		const pull = getPull(pullId)
		if (pull?.source_id) markSavedSourceRefreshed(pull.source_id, pullId)
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

function sanitizeFilename(title: string): string {
	return (
		title
			.replace(/[<>:"/\\|?*]/g, "-")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 80) || "untitled"
	)
}

function startSavedSourceRefresh(sourceId: string, server: Bun.Server<unknown>) {
	const saved = getSavedSource(sourceId)
	if (!saved) return { response: error("Saved source not found", 404), pullId: null }
	const config = JSON.parse(saved.config_json || "{}") as {
		outDir?: string
		maxPages?: number
		workerCount?: number
		dest?: string
	}
	const target = saved.target || saved.url
	const isSourcePull = !!(saved.source && saved.source !== "website")
	const normalizedUrl = isSourcePull || /^https?:\/\//i.test(target) ? target : `https://${target}`
	const max = Number(config.maxPages || 500)
	const workers = Number(config.workerCount || 0)
	const out = config.outDir || `./pulls/${sanitizeFilename(saved.name)}`
	const pullId = generateId()
	createPull({
		id: pullId,
		url: normalizedUrl,
		source: isSourcePull ? saved.source : "",
		sourceId: saved.id,
		dest: config.dest || "",
		outDir: resolve(out),
		maxPages: max,
		workerCount: workers,
		projectId: saved.project_id || undefined,
	})
	const controller = new AbortController()
	activePulls.set(pullId, controller)
	const effect =
		isSourcePull && SOURCE_ADAPTERS[saved.source]
			? runSourcePullForServer(
					pullId,
					SOURCE_ADAPTERS[saved.source]!,
					{ target: normalizedUrl, max, outDir: resolve(out) },
					server,
					controller,
				)
			: runPull(
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
				)
	Effect.runPromise(effect).catch((err) => {
		if (controller.signal.aborted) return
		const errEvent: PullEvent = { type: "error", message: String(err) }
		server.publish("pull-events", JSON.stringify({ pullId, event: errEvent }))
		handlePullEvent(pullId, errEvent)
	})
	return { response: json({ pullId, source: saved }), pullId }
}

function localCapabilities() {
	const flags = {
		workflows: false,
		aiSearch: false,
		browserRecording: false,
		artifacts: false,
		secrets: false,
		aiGateway: false,
		agents: false,
	}
	const setupRequired = (message: string) => ({
		enabled: false,
		configured: false,
		available: false,
		setupRequired: false,
		message,
	})
	return {
		runtime: "bun",
		featureFlags: { provider: "fallback", enabled: false, flags },
		capabilities: {
			workflows: setupRequired("Cloudflare Workflows are available only in the Cloudflare Worker deployment."),
			aiSearch: setupRequired("Semantic search falls back to local SQLite full-text search here."),
			browserRecording: setupRequired("Browser Run recordings are available only in the Cloudflare Worker deployment."),
			artifacts: setupRequired("Artifacts publishing falls back to local export here."),
			secrets: setupRequired("Secrets Store is available only in the Cloudflare Worker deployment."),
			aiGateway: setupRequired("AI Gateway is available only in the Cloudflare Worker deployment."),
			agents: setupRequired("Agents SDK is available only in the Cloudflare Worker deployment."),
		},
		bindings: {
			workflows: { configured: false, available: false, status: "setup-required", message: "Cloudflare-only." },
			aiSearch: {
				configured: false,
				available: false,
				status: "setup-required",
				message: "Using local search fallback.",
			},
			browserRecording: { configured: false, available: false, status: "setup-required", message: "Cloudflare-only." },
			artifacts: {
				configured: false,
				available: false,
				status: "setup-required",
				message: "Using local export fallback.",
			},
			secretsStore: { configured: false, available: false, status: "setup-required", message: "Cloudflare-only." },
			aiGateway: { configured: false, available: false, status: "setup-required", message: "Cloudflare-only." },
			agents: { configured: false, available: false, status: "setup-required", message: "Cloudflare-only." },
		},
	}
}

function runSourcePullForServer(
	pullId: string,
	adapter: SourceAdapter,
	config: SourceConfig,
	server: Bun.Server<unknown>,
	controller: AbortController,
): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const started = performance.now()
		const items = yield* adapter.discover(config)
		server.publish(
			"pull-events",
			JSON.stringify({ pullId, event: { type: "discover", urls: items.map((item) => item.url) } }),
		)
		server.publish(
			"pull-events",
			JSON.stringify({
				pullId,
				event: { type: "start", total: items.length, workerCount: 1, source: adapter.name.toLowerCase() },
			}),
		)
		let ok = 0
		let err = 0
		for (let index = 0; index < items.length; index++) {
			if (controller.signal.aborted) break
			const item = items[index]!
			try {
				const result = yield* adapter.fetch(item)
				const path = `${sanitizeFilename(item.title)}.md`
				const markdown = result.content
				yield* write({ url: item.url, title: item.title, markdown }, config.outDir)
				addDoc(pullId, { path, url: item.url, title: item.title, content: markdown })
				ok++
				server.publish(
					"pull-events",
					JSON.stringify({
						pullId,
						event: {
							type: "progress",
							ok,
							err,
							status: "ok",
							file: path,
							url: item.url,
							title: item.title,
							content: markdown,
							source: adapter.name.toLowerCase(),
						},
					}),
				)
			} catch {
				err++
				server.publish(
					"pull-events",
					JSON.stringify({
						pullId,
						event: { type: "progress", ok, err, status: "err", source: adapter.name.toLowerCase() },
					}),
				)
			}
		}
		flushDocs(pullId)
		const event = {
			type: "complete",
			ok,
			err,
			elapsed: (performance.now() - started) / 1000,
			source: adapter.name.toLowerCase(),
		}
		server.publish("pull-events", JSON.stringify({ pullId, event }))
		handlePullEvent(pullId, event as PullEvent)
	})
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

		if (path === "/api/capabilities" && req.method === "GET") {
			return json(localCapabilities())
		}

		if (path === "/api/knowledge-buckets" && req.method === "GET") {
			return json({
				buckets: [],
				setupRequired: true,
				message: "Cloudflare AI Search knowledge buckets are available in the Cloudflare deployment.",
			})
		}

		if (path === "/api/sources" && req.method === "GET") {
			const projectId = url.searchParams.get("projectId") || undefined
			const dueOnly = url.searchParams.get("due") === "1"
			return json(dueOnly ? listDueSavedSources() : listSavedSources(projectId))
		}

		if (path === "/api/sources" && req.method === "POST") {
			try {
				const body: any = await req.json()
				const targetUrl = String(body.url || body.target || "").trim()
				if (!targetUrl) return error("url or target is required")
				const name =
					String(body.name || "").trim() ||
					(() => {
						try {
							const parsed = new URL(/^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`)
							return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`.replace(/\/$/, "")
						} catch {
							return targetUrl
						}
					})()
				const saved = createSavedSource({
					name,
					url: targetUrl,
					target: body.target || targetUrl,
					source: body.source || "website",
					projectId: body.projectId || null,
					cadence: body.cadence || "manual",
					status: body.status || "active",
					config: {
						maxPages: Number(body.maxPages || 500),
						workerCount: Number(body.workerCount || 0),
						outDir: body.outDir || "",
						dest: body.dest || "",
						extractionModes: Array.isArray(body.extractionModes) ? body.extractionModes : [],
						watch: body.watch || null,
					},
				})
				return json(saved)
			} catch (e) {
				return error(String(e), 500)
			}
		}

		if (path.startsWith("/api/sources/") && path.endsWith("/refresh") && req.method === "POST") {
			const id = path.split("/")[3]!
			return startSavedSourceRefresh(id, server).response
		}

		if (path.startsWith("/api/sources/") && req.method === "GET") {
			const id = path.split("/")[3]!
			const saved = getSavedSource(id)
			if (!saved) return error("Not found", 404)
			const pulls = listPulls().filter((pull) => pull.source_id === id)
			return json({ ...saved, pulls })
		}

		if (path.startsWith("/api/sources/") && req.method === "PUT") {
			try {
				const id = path.split("/")[3]!
				const body: any = await req.json()
				updateSavedSource(id, {
					name: body.name,
					url: body.url,
					target: body.target,
					source: body.source,
					projectId: body.projectId,
					cadence: body.cadence,
					status: body.status,
					config: body.config,
					nextRefreshAt: body.nextRefreshAt,
				})
				return json({ ok: true, source: getSavedSource(id) })
			} catch (e) {
				return error(String(e), 500)
			}
		}

		if (path.startsWith("/api/sources/") && req.method === "DELETE") {
			const id = path.split("/")[3]!
			deleteSavedSource(id)
			return json({ ok: true })
		}

		if (path === "/api/changes" && req.method === "GET") {
			const pullId = url.searchParams.get("pullId")
			const sourceId = url.searchParams.get("sourceId")
			if (pullId) return json({ summary: getPullChangeSummary(pullId), changes: listDocumentChanges(pullId) })
			const pulls = listPulls(100).filter((pull) => !sourceId || pull.source_id === sourceId)
			const changes = pulls.flatMap((pull) => listDocumentChanges(pull.id))
			return json({ changes })
		}

		if (path === "/api/exports" && req.method === "GET") {
			const pullId = url.searchParams.get("pullId") || undefined
			const projectId = url.searchParams.get("projectId") || undefined
			const sourceId = url.searchParams.get("sourceId") || undefined
			return json(listExportJobs({ pullId, projectId, sourceId }))
		}

		if (path === "/api/exports" && req.method === "POST") {
			const body: any = await req.json().catch(() => ({}))
			const job = createExportJob({
				pullId: body.pullId || null,
				projectId: body.projectId === "local" ? null : body.projectId || null,
				sourceId: body.sourceId || null,
				destination: body.destination || "local-zip",
				format: body.format || body.mode || "markdown",
				metadata: {
					lineage: {
						projectId: body.projectId || null,
						sourceId: body.sourceId || null,
						bucket: body.bucket || "",
						extractionMethod: body.extractionMethod || body.mode || "defuddle",
						lastRefresh: null,
					},
					options: body.options || {},
				},
			})
			return json({ ...job, ok: true })
		}

		if (path === "/api/knowledge-buckets" && req.method === "POST") {
			return error("Cloudflare AI Search knowledge buckets are available in the Cloudflare deployment.", 400)
		}

		if (path.startsWith("/api/knowledge-buckets/")) {
			return error("Cloudflare AI Search knowledge buckets are available in the Cloudflare deployment.", 400)
		}

		if (path === "/api/pull" && req.method === "POST") {
			try {
				const body: any = await req.json()
				const { url: targetUrl, source, sourceId, target, dest, outDir, maxPages, workerCount, projectId } = body
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
					sourceId: sourceId || undefined,
				})
				const controller = new AbortController()
				activePulls.set(pullId, controller)
				const effect =
					isSourcePull && SOURCE_ADAPTERS[source]
						? runSourcePullForServer(
								pullId,
								SOURCE_ADAPTERS[source]!,
								{ target: normalizedUrl, max, outDir: resolve(out) },
								server,
								controller,
							)
						: runPull(
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
							)
				Effect.runPromise(effect).catch((err) => {
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
			!path.includes("/changes") &&
			!path.endsWith("/export") &&
			!path.endsWith("/exports") &&
			!path.endsWith("/project") &&
			req.method === "GET"
		) {
			const id = path.split("/")[3]!
			const pull = getPull(id)
			if (!pull) return error("Not found", 404)
			return json({ ...pull, changes: getPullChangeSummary(id), exports: listExportJobs({ pullId: id }) })
		}

		if (path.startsWith("/api/pulls/") && path.endsWith("/changes") && req.method === "GET") {
			const id = path.split("/")[3]!
			return json({ summary: getPullChangeSummary(id), changes: listDocumentChanges(id) })
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

		if (path.startsWith("/api/pulls/") && path.endsWith("/exports") && req.method === "GET") {
			const id = path.split("/")[3]!
			return json(listExportJobs({ pullId: id }))
		}

		if (path.startsWith("/api/pulls/") && path.endsWith("/exports") && req.method === "POST") {
			const id = path.split("/")[3]!
			const body: any = await req.json().catch(() => ({}))
			const pull = getPull(id)
			if (!pull) return error("Not found", 404)
			const job = createExportJob({
				pullId: id,
				projectId: pull.project_id,
				sourceId: pull.source_id,
				destination: body.destination || "local-zip",
				format: body.format || "markdown",
				metadata: {
					lineage: {
						sourceUrl: pull.url,
						pullDate: pull.finished_at || pull.started_at,
						bucket: body.bucket || "",
						extractionMethod: body.extractionMethod || "defuddle",
						lastRefresh: pull.finished_at || null,
					},
					options: body.options || {},
				},
			})
			return json(job)
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
			const mode = url.searchParams.get("mode") || "keyword"
			let results: SearchResult[]
			if (pullId) {
				results = searchDocsInPull(pullId, q, limit)
			} else if (projectId) {
				results = searchDocsInProject(projectId, q, limit)
			} else {
				results = searchDocs(q, limit)
			}
			if (url.searchParams.has("mode") && mode !== "keyword") {
				return json({
					results,
					mode: "local",
					requestedMode: mode,
					fallback: { from: mode, to: "local", reason: "Local Bun server uses SQLite search fallback." },
				})
			}
			return json(results)
		}

		if (path === "/api/ask" && req.method === "POST") {
			const body: any = await req.json().catch(() => ({}))
			const question = String(body.question || "")
			const pullId = body.pullId ? String(body.pullId) : undefined
			const projectId = body.projectId ? String(body.projectId) : undefined
			const bucketIds = Array.isArray(body.bucketIds) ? body.bucketIds.map(String) : []
			const results = pullId
				? searchDocsInPull(pullId, question, 8)
				: projectId
					? searchDocsInProject(projectId, question, 8)
					: searchDocs(question, 8)
			const answer =
				results.length > 0
					? `Found ${results.length} relevant document${results.length === 1 ? "" : "s"} in the local archive.`
					: "No matching local documents found."
			const session = createAskSession({ question, answer, bucketIds, projectId: projectId || null })
			const citations = results.map((result) => {
				const citation = addAskCitation({
					sessionId: session.id,
					documentId: result.id,
					sourceUrl: result.url,
					title: result.title,
					path: result.path,
					pullId: result.pull_id,
					bucketId: bucketIds[0] || null,
					snippet: result.content.slice(0, 500),
				})
				return {
					id: citation.id,
					title: result.title,
					path: result.path,
					url: result.url,
					pullId: result.pull_id,
					pullDate: getPull(result.pull_id)?.finished_at || getPull(result.pull_id)?.started_at || null,
					bucketId: bucketIds[0] || null,
					extractionMethod: "defuddle",
				}
			})
			return json({
				sessionId: session.id,
				answer,
				mode: "keyword",
				setupRequired: true,
				citations,
				results,
			})
		}

		if (path.startsWith("/api/pulls/") && path.endsWith("/ask") && req.method === "POST") {
			const pullId = path.split("/")[3]!
			const body: any = await req.json().catch(() => ({}))
			const question = String(body.question || "")
			const results = searchDocsInPull(pullId, question, 8)
			const answer =
				results.length > 0
					? `Found ${results.length} relevant document${results.length === 1 ? "" : "s"} in this pull.`
					: "No matching documents found in this pull."
			const session = createAskSession({ question, answer, bucketIds: body.bucketIds || [] })
			const citations = results.map((result) =>
				addAskCitation({
					sessionId: session.id,
					documentId: result.id,
					sourceUrl: result.url,
					title: result.title,
					path: result.path,
					pullId: result.pull_id,
					bucketId: Array.isArray(body.bucketIds) ? body.bucketIds[0] : null,
					snippet: result.content.slice(0, 500),
				}),
			)
			return json({
				sessionId: session.id,
				answer,
				mode: "keyword",
				setupRequired: true,
				citations: citations.map((citation) => ({
					id: citation.id,
					title: citation.title,
					path: citation.path,
					url: citation.source_url,
					pullId: citation.pull_id,
					bucketId: citation.bucket_id,
				})),
				results,
			})
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

		if (path.startsWith("/api/docs/") && path.endsWith("/diagnostics") && req.method === "GET") {
			const docId = parseInt(path.split("/")[3]!, 10)
			if (Number.isNaN(docId)) return error("Invalid doc id", 400)
			return json(listDocumentDiagnostics(docId))
		}

		if (path.startsWith("/api/docs/") && path.endsWith("/diagnostics") && req.method === "POST") {
			const docId = parseInt(path.split("/")[3]!, 10)
			if (Number.isNaN(docId)) return error("Invalid doc id", 400)
			const body: any = await req.json().catch(() => ({}))
			return json(
				recordDocumentDiagnostics({
					documentId: docId,
					versionId: body.versionId ?? null,
					extractionConfidence: Number(body.extractionConfidence ?? 0),
					wordCount: Number(body.wordCount ?? 0),
					titleFound: !!body.titleFound,
					markdownQuality: Number(body.markdownQuality ?? 0),
					renderMode: body.renderMode || "fetch",
					failedSelectors: Array.isArray(body.failedSelectors) ? body.failedSelectors : [],
					screenshotPath: body.screenshotPath ?? null,
					pdfPath: body.pdfPath ?? null,
					notes: body.notes || "",
				}),
			)
		}

		if (path.startsWith("/api/docs/") && path.endsWith("/extracts") && req.method === "GET") {
			const docId = parseInt(path.split("/")[3]!, 10)
			if (Number.isNaN(docId)) return error("Invalid doc id", 400)
			const kind = url.searchParams.get("kind") as any
			return json(listStructuredExtracts(docId, kind || undefined))
		}

		if (path.startsWith("/api/docs/") && path.endsWith("/extracts") && req.method === "POST") {
			const docId = parseInt(path.split("/")[3]!, 10)
			if (Number.isNaN(docId)) return error("Invalid doc id", 400)
			const body: any = await req.json().catch(() => ({}))
			const doc = getDocById(docId)
			if (!doc) return error("Not found", 404)
			const kind = body.kind || "custom"
			const data =
				body.data ??
				(kind === "entities"
					? {
							title: doc.title,
							url: doc.url,
							headings: [...doc.content.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => match[1]),
						}
					: { title: doc.title, url: doc.url, text: doc.content.slice(0, 2000) })
			return json(
				createStructuredExtract({
					documentId: docId,
					versionId: body.versionId ?? null,
					kind,
					schema: body.schema || { generatedBy: "local-fallback" },
					data,
					format: body.format || "json",
				}),
			)
		}

		if (path.startsWith("/api/docs/") && req.method === "GET") {
			const docId = parseInt(path.split("/")[3]!, 10)
			if (Number.isNaN(docId)) return error("Invalid doc id", 400)
			const doc = getDocById(docId)
			if (!doc) return error("Not found", 404)
			return json({
				...doc,
				diagnostics: listDocumentDiagnostics(docId),
				extracts: listStructuredExtracts(docId),
			})
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
			const youtube = getYtDlpStatus()
			const twitter = getTwitterStatus()
			const gws = getGwsAuthStatus()
			const gdrive = {
				installed: gws.installed,
				authenticated: gws.authenticated,
				message: gws.authenticated ? "Ready - Drive OAuth configured" : "Run gws auth login to connect Google Drive",
			}
			return json({
				youtube,
				twitter,
				gdrive,
				agentMemory: {
					installed: false,
					authenticated: false,
					status: "setup-required",
					message: "Cloudflare Agent Memory is available in the Worker deployment.",
				},
				docsForAgents: {
					installed: false,
					authenticated: false,
					status: "setup-required",
					message: "AI Search/Docs for Agents is available in the Worker deployment.",
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
				artifacts: {
					installed: false,
					authenticated: false,
					status: "setup-required",
					message: "Cloudflare Artifacts are available in the Worker deployment; local publish falls back to export.",
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
			const adapter = SOURCE_ADAPTERS[source]
			if (!adapter) return error(`Unknown source: ${source}`, 400)
			const items = await Effect.runPromise(
				adapter.discover({ target, max: Number(body.max || 10), outDir: resolve(PULLS_DIR) }),
			)
			return json({ items: items.map((item: SourceItem) => ({ ...item, meta: item.meta ?? {} })), total: items.length })
		}

		if (path === "/api/destination/push" && req.method === "POST") {
			const body: any = await req.json().catch(() => ({}))
			const { pullId, destination } = body
			if (!pullId || !destination) return error("pullId and destination required")
			if (destination === "artifact" || destination === "artifacts") {
				return json({
					ok: 0,
					err: 0,
					destination: "local-export",
					status: "fallback",
					fallback: { from: "artifact", to: "local-export", reason: "Cloudflare Artifacts require Worker deployment." },
					files: [],
				})
			}
			const gws = getGwsAuthStatus()
			if (!gws.authenticated)
				return error("Google Drive not authenticated. Click the Connect button in the Pull tab to sign in first.", 401)
			return json({ ok: 0, err: 0, files: [], note: "Google Drive push not yet implemented" })
		}

		if (
			(path.startsWith("/api/pulls/") && path.endsWith("/artifact") && req.method === "POST") ||
			(path === "/api/artifact/publish" && req.method === "POST")
		) {
			return json({
				status: "fallback",
				destination: "local-export",
				fallback: { from: "artifact", to: "local-export", reason: "Cloudflare Artifacts require Worker deployment." },
			})
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
