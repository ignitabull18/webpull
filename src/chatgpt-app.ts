import { resolve } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Effect } from "effect"
import { z } from "zod"
import {
	createPull,
	getDocById,
	getPull,
	insertDocuments,
	listDocs,
	listPulls,
	searchDocs,
	searchDocsInPull,
	updatePull,
} from "./db"
import { type PullEvent, runPull } from "./pull"

const WIDGET_URI = "ui://webpull/app-v2.html"
const WIDGET_PATH = resolve(import.meta.dir, "chatgpt-widget.html")
const DEFAULT_MAX_PAGES = 100
const MAX_SEARCH_LIMIT = 20
const MAX_CONTENT_CHARS = 12000
const widgetHtml = await Bun.file(WIDGET_PATH).text()
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"
const RESOURCE_URI_META_KEY = "ui/resourceUri"

type ToolText = { type: "text"; text: string }
type AppToolMeta = Record<string, unknown> & {
	ui?: {
		resourceUri?: string
		[key: string]: unknown
	}
}
type AppToolDefinition = Record<string, unknown> & {
	_meta?: AppToolMeta
}
type AppToolHandler = (...args: any[]) => unknown
type AppResourceMetadata = Record<string, unknown>
type AppResourceHandler = (...args: any[]) => unknown

function normalizeAppToolMeta(meta?: AppToolMeta): AppToolMeta | undefined {
	if (!meta) return meta
	const resourceUri = meta.ui?.resourceUri ?? meta[RESOURCE_URI_META_KEY]
	if (!resourceUri || typeof resourceUri !== "string") return meta
	return {
		...meta,
		[RESOURCE_URI_META_KEY]: resourceUri,
		ui: { ...meta.ui, resourceUri },
	}
}

function registerAppTool(server: McpServer, name: string, definition: AppToolDefinition, handler: AppToolHandler) {
	return server.registerTool(
		name,
		{ ...definition, _meta: normalizeAppToolMeta(definition._meta) } as any,
		handler as any,
	)
}

function registerAppResource(
	server: McpServer,
	name: string,
	uri: string,
	metadata: AppResourceMetadata,
	handler: AppResourceHandler,
) {
	return server.registerResource(name, uri, { mimeType: RESOURCE_MIME_TYPE, ...metadata }, handler as any)
}

function toolText(text: string): ToolText[] {
	return [{ type: "text", text }]
}

function normalizeUrl(value: string): string {
	const trimmed = value.trim()
	if (!trimmed) throw new Error("url is required")
	const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
	new URL(normalized)
	return normalized
}

function summarizeContent(content: string, maxChars = MAX_CONTENT_CHARS): string {
	const sanitized = sanitizeText(content)
	if (sanitized.length <= maxChars) return sanitized
	return `${sanitized.slice(0, maxChars)}\n\n...truncated ${sanitized.length - maxChars} characters`
}

function sanitizeText(value: string): string {
	let sanitized = ""
	for (const char of value) {
		const code = char.charCodeAt(0)
		if ((code >= 32 || code === 9 || code === 10 || code === 13) && code !== 127) sanitized += char
	}
	return sanitized
}

function docSummary(doc: { id: number; pull_id: string; path: string; url: string; title: string; content: string }) {
	return {
		id: doc.id,
		pullId: doc.pull_id,
		path: sanitizeText(doc.path),
		url: sanitizeText(doc.url),
		title: sanitizeText(doc.title || doc.path),
		preview: summarizeContent(doc.content, 700),
	}
}

function pullSummary(pull: ReturnType<typeof getPull>) {
	if (!pull) return null
	return {
		id: pull.id,
		url: pull.url,
		status: pull.status,
		pagesOk: pull.pages_ok,
		pagesErr: pull.pages_err,
		outDir: pull.out_dir,
		startedAt: pull.started_at,
		finishedAt: pull.finished_at,
	}
}

function createPullRunner(pullId: string, config: { url: string; out: string; max: number; workerCount?: number }) {
	let pagesOk = 0
	let pagesErr = 0
	const docBuffer: { pullId: string; path: string; url: string; title: string; content: string }[] = []

	const flushDocs = () => {
		if (!docBuffer.length) return
		const batch = docBuffer.splice(0)
		insertDocuments(batch)
	}

	const handleEvent = (event: PullEvent) => {
		if (event.type === "progress") {
			pagesOk = event.ok
			pagesErr = event.err
			updatePull(pullId, { pagesOk, pagesErr })
			if (event.status === "ok" && event.file && event.title !== undefined) {
				docBuffer.push({
					pullId,
					path: event.file,
					url: event.url,
					title: event.title ?? "",
					content: event.content ?? "",
				})
				flushDocs()
			}
		}
		if (event.type === "complete") {
			flushDocs()
			updatePull(pullId, { status: "complete", pagesOk: event.ok, pagesErr: event.err })
		}
		if (event.type === "error") {
			flushDocs()
			updatePull(pullId, { status: "failed", pagesOk, pagesErr })
		}
	}

	Effect.runPromise(runPull({ ...config, pullId }, handleEvent)).catch((err) => {
		handleEvent({ type: "error", message: String(err) })
	})
}

function appHtml(): string {
	return widgetHtml
}

function mcpLandingHtml(): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<title>webpull ChatGPT app endpoint</title>
		<style>
			:root {
				color-scheme: dark;
				font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				background: #0d0d0f;
				color: #f1f3f7;
			}
			body {
				margin: 0;
				min-height: 100vh;
				display: grid;
				place-items: center;
				padding: 24px;
			}
			main {
				width: min(640px, 100%);
				border: 1px solid #2b2f3a;
				border-radius: 10px;
				background: #141519;
				padding: 24px;
				box-shadow: 0 20px 50px rgba(0, 0, 0, 0.28);
			}
			h1 {
				margin: 0 0 10px;
				font-size: 24px;
			}
			p {
				margin: 0 0 14px;
				color: #a2a9b8;
				line-height: 1.55;
			}
			code {
				background: #0f1014;
				border: 1px solid #2b2f3a;
				border-radius: 6px;
				padding: 2px 5px;
			}
			a {
				color: #8fa4ff;
			}
		</style>
	</head>
	<body>
		<main>
			<h1>webpull ChatGPT app endpoint</h1>
			<p>This endpoint is running. ChatGPT and Codex connect here with MCP; a normal browser tab will not show the in-chat widget directly.</p>
			<p>Use <code>webpull_open_app</code> from ChatGPT or Codex to open the embedded app UI.</p>
			<p>The regular web UI is available at <a href="/">http://localhost:3456/</a>.</p>
		</main>
	</body>
</html>`
}

function createMcpServer() {
	const server = new McpServer(
		{ name: "webpull", version: "0.1.3" },
		{
			instructions:
				"Use webpull to pull public documentation sites into markdown, search the local markdown archive, and fetch exact documents. Prefer search before fetch when the user asks about existing pulled docs.",
		},
	)

	registerAppResource(
		server,
		"webpull app",
		WIDGET_URI,
		{
			description: "Interactive webpull markdown archive browser",
			_meta: {
				ui: {
					csp: {
						connectDomains: [],
						resourceDomains: [],
					},
					prefersBorder: true,
				},
				"openai/widgetDescription":
					"Browse webpull history, start public docs pulls, search markdown, and preview fetched documents.",
			},
		},
		async () => ({
			contents: [
				{
					uri: WIDGET_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: appHtml(),
					_meta: {
						ui: {
							csp: {
								connectDomains: [],
								resourceDomains: [],
							},
							prefersBorder: true,
						},
					},
				},
			],
		}),
	)

	registerAppTool(
		server,
		"webpull_open_app",
		{
			title: "Open webpull app",
			description: "Use this when the user wants to open the full interactive webpull app UI in ChatGPT.",
			inputSchema: {
				limit: z.number().int().min(1).max(50).optional(),
			},
			outputSchema: {
				pulls: z.array(
					z.object({
						id: z.string(),
						url: z.string(),
						status: z.string(),
						pagesOk: z.number(),
						pagesErr: z.number(),
						outDir: z.string(),
						startedAt: z.string(),
						finishedAt: z.string().nullable(),
					}),
				),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
			_meta: {
				ui: { resourceUri: WIDGET_URI },
				"openai/outputTemplate": WIDGET_URI,
				"openai/toolInvocation/invoking": "Opening webpull...",
				"openai/toolInvocation/invoked": "webpull is open.",
			},
		},
		async ({ limit }) => {
			const pulls = listPulls(limit ?? 20)
				.map(pullSummary)
				.filter((pull) => pull !== null)
			return {
				structuredContent: { pulls },
				content: toolText("Opened the webpull app."),
			}
		},
	)

	registerAppTool(
		server,
		"webpull_list_pulls",
		{
			title: "List webpull pulls",
			description: "Use this when the user wants to see recent documentation pulls and their statuses.",
			inputSchema: {
				limit: z.number().int().min(1).max(50).optional(),
			},
			outputSchema: {
				pulls: z.array(
					z.object({
						id: z.string(),
						url: z.string(),
						status: z.string(),
						pagesOk: z.number(),
						pagesErr: z.number(),
						outDir: z.string(),
						startedAt: z.string(),
						finishedAt: z.string().nullable(),
					}),
				),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
			_meta: {
				ui: { resourceUri: WIDGET_URI },
				"openai/outputTemplate": WIDGET_URI,
				"openai/toolInvocation/invoking": "Loading pulls...",
				"openai/toolInvocation/invoked": "Pulls loaded.",
			},
		},
		async ({ limit }) => {
			const pulls = listPulls(limit ?? 10)
				.map(pullSummary)
				.filter((pull) => pull !== null)
			return {
				structuredContent: { pulls },
				content: toolText(`Found ${pulls.length} recent pull${pulls.length === 1 ? "" : "s"}.`),
			}
		},
	)

	registerAppTool(
		server,
		"webpull_start_pull",
		{
			title: "Start webpull pull",
			description: "Use this when the user asks to pull a public documentation website into local markdown.",
			inputSchema: {
				url: z.string().describe("Public website or docs URL to pull."),
				maxPages: z.number().int().min(1).max(1000).optional(),
				workerCount: z.number().int().min(1).max(32).optional(),
				outDir: z.string().optional(),
			},
			outputSchema: {
				pull: z.object({
					id: z.string(),
					url: z.string(),
					status: z.string(),
					pagesOk: z.number(),
					pagesErr: z.number(),
					outDir: z.string(),
					startedAt: z.string(),
					finishedAt: z.string().nullable(),
				}),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			_meta: {
				ui: { resourceUri: WIDGET_URI },
				"openai/outputTemplate": WIDGET_URI,
				"openai/toolInvocation/invoking": "Starting pull...",
				"openai/toolInvocation/invoked": "Pull started.",
			},
		},
		async ({ url, maxPages, workerCount, outDir }) => {
			const normalizedUrl = normalizeUrl(url)
			const hostname = new URL(normalizedUrl).hostname
			const pullId = crypto.randomUUID()
			const out = outDir || `./${hostname}`
			const resolvedOut = resolve(out)
			const max = maxPages ?? DEFAULT_MAX_PAGES
			const workers = workerCount ?? 0
			createPull({
				id: pullId,
				url: normalizedUrl,
				outDir: resolvedOut,
				maxPages: max,
				workerCount: workers,
			})
			createPullRunner(pullId, {
				url: normalizedUrl,
				out: resolvedOut,
				max,
				workerCount: workers || undefined,
			})
			const pull = pullSummary(getPull(pullId))!
			return {
				structuredContent: { pull },
				content: toolText(`Started pulling ${normalizedUrl}. Use webpull_show_pull to check status.`),
			}
		},
	)

	registerAppTool(
		server,
		"webpull_show_pull",
		{
			title: "Show webpull pull",
			description: "Use this when the user wants status or documents for one webpull pull.",
			inputSchema: {
				pullId: z.string(),
				limit: z.number().int().min(1).max(50).optional(),
			},
			outputSchema: {
				pull: z.object({
					id: z.string(),
					url: z.string(),
					status: z.string(),
					pagesOk: z.number(),
					pagesErr: z.number(),
					outDir: z.string(),
					startedAt: z.string(),
					finishedAt: z.string().nullable(),
				}),
				results: z.array(
					z.object({
						id: z.number(),
						pullId: z.string(),
						path: z.string(),
						url: z.string(),
						title: z.string(),
						preview: z.string(),
					}),
				),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
			_meta: {
				ui: { resourceUri: WIDGET_URI },
				"openai/outputTemplate": WIDGET_URI,
				"openai/toolInvocation/invoking": "Loading pull...",
				"openai/toolInvocation/invoked": "Pull loaded.",
			},
		},
		async ({ pullId, limit }) => {
			const pull = pullSummary(getPull(pullId))
			if (!pull) throw new Error("Pull not found")
			const docs = listDocs(pullId)
				.slice(0, limit ?? 20)
				.map(docSummary)
			return {
				structuredContent: { pull, results: docs, selectedPullId: pull.id },
				content: toolText(`${pull.status} pull for ${pull.url}: ${pull.pagesOk} ok, ${pull.pagesErr} errors.`),
			}
		},
	)

	registerAppTool(
		server,
		"search",
		{
			title: "Search pulled markdown",
			description: "Use this when the user asks to search across markdown documents already pulled by webpull.",
			inputSchema: {
				query: z.string(),
				pullId: z.string().optional(),
				limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
			},
			outputSchema: {
				results: z.array(
					z.object({
						id: z.number(),
						pullId: z.string(),
						path: z.string(),
						url: z.string(),
						title: z.string(),
						preview: z.string(),
					}),
				),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
			_meta: {
				ui: { resourceUri: WIDGET_URI },
				"openai/outputTemplate": WIDGET_URI,
				"openai/toolInvocation/invoking": "Searching markdown...",
				"openai/toolInvocation/invoked": "Search complete.",
			},
		},
		async ({ query, pullId, limit }) => {
			const max = Math.min(limit ?? 10, MAX_SEARCH_LIMIT)
			const results = (pullId ? searchDocsInPull(pullId, query, max) : searchDocs(query, max)).map(docSummary)
			return {
				structuredContent: { results, selectedPullId: pullId ?? null },
				content: toolText(`Found ${results.length} matching document${results.length === 1 ? "" : "s"}.`),
			}
		},
	)

	registerAppTool(
		server,
		"fetch",
		{
			title: "Fetch pulled markdown document",
			description: "Use this when the user wants the exact markdown content for a document returned by search.",
			inputSchema: {
				id: z.number().int().positive(),
			},
			outputSchema: {
				document: z.object({
					id: z.number(),
					pullId: z.string(),
					path: z.string(),
					url: z.string(),
					title: z.string(),
					content: z.string(),
				}),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
			_meta: {
				ui: { resourceUri: WIDGET_URI },
				"openai/outputTemplate": WIDGET_URI,
				"openai/toolInvocation/invoking": "Fetching document...",
				"openai/toolInvocation/invoked": "Document fetched.",
			},
		},
		async ({ id }) => {
			const doc = getDocById(id)
			if (!doc) throw new Error("Document not found")
			const document = {
				id: doc.id,
				pullId: doc.pull_id,
				path: sanitizeText(doc.path),
				url: sanitizeText(doc.url),
				title: sanitizeText(doc.title || doc.path),
				content: summarizeContent(doc.content),
			}
			return {
				structuredContent: { document },
				content: toolText(`Fetched ${document.title} from ${document.url}.\n\n${document.content}`),
				_meta: { fullLength: doc.content.length },
			}
		},
	)

	return server
}

export async function handleMcpRequest(req: Request): Promise<Response> {
	if (req.method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: {
				"access-control-allow-origin": "*",
				"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
				"access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id",
			},
		})
	}
	if (req.method === "GET") {
		const accept = req.headers.get("accept") ?? ""
		if (accept.includes("text/html") && !accept.includes("text/event-stream")) {
			return new Response(mcpLandingHtml(), {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"access-control-allow-origin": "*",
				},
			})
		}
	}
	const mcpServer = createMcpServer()
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})
	await mcpServer.connect(transport)
	const response = await transport.handleRequest(req)
	const headers = new Headers(response.headers)
	headers.set("access-control-allow-origin", "*")
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}
