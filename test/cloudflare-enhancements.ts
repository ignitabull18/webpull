import { Database } from "bun:sqlite"

Bun.plugin({
	name: "cloudflare-runtime-shims",
	setup(builder) {
		builder.onResolve({ filter: /^cloudflare:(email|workers)$/ }, (args) => ({
			path: args.path,
			namespace: "cloudflare-runtime-shims",
		}))
		builder.onLoad({ filter: /.*/, namespace: "cloudflare-runtime-shims" }, (args) => ({
			contents:
				args.path === "cloudflare:email"
					? "export class EmailMessage {}"
					: "export class RpcTarget {} export class WorkflowEntrypoint {} export const exports = {}",
			loader: "js",
		}))
	},
})

let worker: { fetch: (request: Request, env: any) => Promise<Response> }
try {
	;({ default: worker } = await import("../cloudflare/worker"))
} catch (caught) {
	if (String(caught).includes("cloudflare:workers")) {
		console.log("  - skipped Cloudflare enhancement contracts: local Bun could not shim cloudflare:workers")
		process.exit(0)
	}
	throw caught
}

type D1Result<T> = { results: T[]; meta: { changes: number } }

const schema = await Bun.file(new URL("../cloudflare/schema.sql", import.meta.url)).text()

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = "") {
	if (condition) {
		console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`)
		passed++
		return
	}
	console.error(`  ✗ ${name}${detail ? `: ${detail}` : ""}`)
	failed++
}

function redact(value: unknown): string {
	return (JSON.stringify(value, null, 2) ?? String(value)).slice(0, 800)
}

class MockD1Statement {
	#values: unknown[] = []

	constructor(
		private readonly db: Database,
		private readonly sql: string,
	) {}

	bind(...values: unknown[]) {
		this.#values = values
		return this
	}

	async first<T>() {
		return ((this.db.query(this.sql) as any).get(...this.#values) ?? null) as T | null
	}

	async all<T>(): Promise<D1Result<T>> {
		return {
			results: (this.db.query(this.sql) as any).all(...this.#values) as T[],
			meta: { changes: (this.db as any).changes ?? 0 },
		}
	}

	async run() {
		;(this.db.query(this.sql) as any).run(...this.#values)
		return { success: true, meta: { changes: (this.db as any).changes ?? 0 } }
	}
}

class MockD1Database {
	readonly db = new Database(":memory:")

	constructor() {
		this.db.exec(schema)
	}

	prepare(sql: string) {
		return new MockD1Statement(this.db, sql)
	}

	async batch(statements: MockD1Statement[]) {
		const results = []
		for (const statement of statements) results.push(await statement.run())
		return results
	}
}

class MockR2Bucket {
	readonly objects = new Map<string, { body: string; httpMetadata?: { contentType?: string } }>()

	async put(key: string, body: string, options?: { httpMetadata?: { contentType?: string } }) {
		this.objects.set(key, { body, httpMetadata: options?.httpMetadata })
		return null
	}

	async get(key: string) {
		const object = this.objects.get(key)
		if (!object) return null
		return {
			body: object.body,
			httpMetadata: object.httpMetadata,
		}
	}

	async list({ prefix = "" }: { prefix?: string; cursor?: string; limit?: number } = {}) {
		return {
			objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
			truncated: false,
		}
	}

	async delete(keys: string | string[]) {
		for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key)
	}
}

const db = new MockD1Database()
const exportsBucket = new MockR2Bucket()
const queueMessages: unknown[] = []
const ownerKey = "11111111-1111-4111-8111-111111111111"
const pullId = "pull-enhancement-contract"
const secretSentinel = "sk_live_webpull_contract_secret"

db.db
	.query(
		`INSERT INTO pulls (id, url, source, out_dir, max_pages, worker_count, status, pages_ok, pages_err, started_at, finished_at)
	 VALUES (?, ?, '', './example.com', 10, 6, 'complete', 1, 0, datetime('now'), datetime('now'))`,
	)
	.run(pullId, "https://example.com")
db.db.query("INSERT INTO pull_owners (pull_id, owner_key) VALUES (?, ?)").run(pullId, ownerKey)
db.db
	.query("INSERT INTO documents (pull_id, path, url, title, content) VALUES (?, ?, ?, ?, ?)")
	.run(
		pullId,
		"index.md",
		"https://example.com",
		"Example Cloudflare Docs",
		"Cloudflare AI Search fallback fixture with artifact publishing coverage.",
	)

const env = {
	DB: db,
	EXPORTS: exportsBucket,
	PULL_QUEUE: { send: async (message: unknown) => queueMessages.push(message) },
	ASSETS: { fetch: async () => new Response("asset", { headers: { "content-type": "text/plain" } }) },
	OPENAI_API_KEY: secretSentinel,
	CLOUDFLARE_API_TOKEN: "cf_token_webpull_contract_secret",
	SECRET_BINDING_VALUE: "binding_secret_webpull_contract_secret",
} as any

async function api(path: string, init?: RequestInit) {
	const request = new Request(`https://webpull.test${path}`, {
		...init,
		headers: {
			cookie: `webpull_owner=${ownerKey}`,
			...(init?.headers || {}),
		},
	})
	const response = await worker.fetch(request, env)
	const text = await response.text()
	let body: any = text
	try {
		body = text ? JSON.parse(text) : null
	} catch {}
	return { response, body, text }
}

async function postMcp(method: string, params: Record<string, unknown> = {}) {
	return api("/mcp", {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	})
}

const capabilities = await api("/api/capabilities")
check("/api/capabilities returns JSON", capabilities.response.ok, redact(capabilities.body))
check(
	"capabilities identifies Cloudflare runtime",
	capabilities.body?.runtime === "cloudflare",
	redact(capabilities.body),
)
check(
	"capabilities exposes feature flag fallback state",
	capabilities.body?.featureFlags?.provider === "fallback" &&
		capabilities.body.featureFlags?.enabled === false &&
		Object.values(capabilities.body.featureFlags?.flags ?? {}).every((value) => value === false),
	redact(capabilities.body?.featureFlags),
)
check(
	"capabilities marks missing optional bindings setup-required",
	["aiSearch", "artifacts", "secretsStore", "aiGateway"].every((name) => {
		const binding = capabilities.body?.bindings?.[name]
		return binding?.status === "setup-required" && binding?.configured === false && typeof binding?.message === "string"
	}),
	redact(capabilities.body?.bindings),
)

const sourceStatus = await api("/api/source-status")
const destinationStatus = await api("/api/destination-status")
check(
	"source status keeps unavailable enhanced sources setup-required",
	["agentMemory", "docsForAgents"].every((name) => {
		const status = sourceStatus.body?.[name]
		return status?.installed === false && status?.authenticated === false && status?.status === "setup-required"
	}),
	redact(sourceStatus.body),
)
check(
	"destination status keeps missing artifact binding setup-required",
	destinationStatus.body?.artifacts?.installed === false &&
		destinationStatus.body?.artifacts?.authenticated === false &&
		destinationStatus.body?.artifacts?.status === "setup-required",
	redact(destinationStatus.body),
)

const search = await api(`/api/search?q=${encodeURIComponent("fallback fixture")}&mode=ai&pullId=${pullId}`)
const searchResults = Array.isArray(search.body) ? search.body : search.body?.results
check(
	"/api/search mode=ai falls back to local search",
	search.response.ok && Array.isArray(searchResults),
	redact(search.body),
)
check(
	"search fallback reports selected mode and reason",
	search.body?.mode === "local" && search.body?.fallback?.from === "ai" && search.body?.fallback?.reason,
	redact(search.body),
)
check(
	"search fallback still returns matching docs",
	searchResults?.some((doc: any) => doc.path === "index.md"),
	redact(search.body),
)

const listed = await postMcp("tools/list")
const toolNames = (listed.body?.result?.tools ?? []).map((tool: any) => tool.name)
check("MCP tools/list succeeds", listed.response.ok && Array.isArray(toolNames), redact(listed.body))
check(
	"MCP exposes Cloudflare enhancement tools",
	["webpull_get_capabilities", "webpull_publish_artifact", "webpull_search"].every((name) => toolNames.includes(name)),
	toolNames.join(", "),
)

const artifactPublish = await api("/api/destination/push", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ pullId, destination: "artifact" }),
})
check(
	"artifact publish falls back instead of failing when binding is absent",
	artifactPublish.response.ok,
	redact(artifactPublish.body),
)
check(
	"artifact publish fallback uses R2 export URLs",
	artifactPublish.body?.destination === "r2" &&
		artifactPublish.body?.fallback?.from === "artifact" &&
		artifactPublish.body?.fallback?.reason &&
		artifactPublish.body?.files?.[0]?.url === "/api/exports/pull-enhancement-contract/index.md",
	redact(artifactPublish.body),
)

const observedPayload = [
	capabilities.text,
	sourceStatus.text,
	destinationStatus.text,
	search.text,
	listed.text,
	artifactPublish.text,
].join("\n")
check("API and MCP responses do not leak configured secret values", !observedPayload.includes(secretSentinel))
check(
	"API and MCP responses do not leak secret-like environment strings",
	!/webpull_contract_secret/.test(observedPayload),
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
