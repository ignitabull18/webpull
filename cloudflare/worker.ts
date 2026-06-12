interface PullRow {
	id: string
	url: string
	source: string
	dest: string
	project_id: string | null
	out_dir: string
	max_pages: number
	worker_count: number
	status: string
	pages_ok: number
	pages_err: number
	started_at: string
	finished_at: string | null
}

interface CleanupRow {
	id: string
}

interface CleanupResult {
	pulls: number
	r2Objects: number
	rateLimits: number
}

interface PullJob {
	pullId: string
	url: string
	maxPages: number
}

interface HealthResponse {
	ok: true
	runtime: "cloudflare"
	storage: "d1"
	limits: {
		maxPages: number
		concurrency: number
	}
}

interface DocRow {
	id: number
	pull_id: string
	path: string
	url: string
	title: string
	content: string
}

const MAX_CLOUD_PAGES = 50
const CONCURRENCY = 6
const MAX_RETRIES = 2
const PULL_RATE_LIMIT = 6
const RATE_WINDOW_SECONDS = 60
const OWNER_COOKIE = "webpull_owner"
const DEFAULT_RETENTION_DAYS = 7
const WIDGET_URI = "ui://webpull/cloudflare-app.html"
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"
const IGNORED = /\.(png|jpg|jpeg|gif|svg|webp|ico|pdf|zip|tar|gz|mp4|mp3|woff2?|ttf|eot|css|js|json|xml|rss|atom)$/i
const NAV_SELECTORS = [
	/<nav[\s\S]*?<\/nav>/gi,
	/<aside[\s\S]*?<\/aside>/gi,
	/<[^>]+(?:class|role)=["'][^"']*(?:sidebar|navigation|toc|menu)[^"']*["'][\s\S]*?<\/[^>]+>/gi,
]
const SECURITY_HEADERS = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "strict-origin-when-cross-origin",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
}
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' https: data:",
	"connect-src 'self' ws: wss:",
	"font-src 'self' data:",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ")

const MCP_WIDGET_HTML = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<title>webpull</title>
		<style>
			:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111318; color: #f4f6fb; }
			body { margin: 0; padding: 18px; }
			main { display: grid; gap: 14px; }
			h1 { margin: 0; font-size: 20px; }
			p { margin: 0; color: #aab2c0; line-height: 1.5; }
			button { width: fit-content; border: 1px solid #52658d; border-radius: 8px; background: #233a69; color: white; padding: 9px 12px; font: inherit; cursor: pointer; }
			pre { white-space: pre-wrap; border: 1px solid #2c3443; border-radius: 8px; padding: 12px; background: #0b0d12; color: #dbe4f7; }
		</style>
	</head>
	<body>
		<main>
			<h1>webpull</h1>
			<p>Pull public websites into markdown on Cloudflare, then publish exports to R2.</p>
			<button id="load">Load recent pulls</button>
			<pre id="out">Ready.</pre>
		</main>
		<script>
			const out = document.getElementById("out");
			document.getElementById("load").addEventListener("click", async () => {
				try {
					const result = await window.openai.callTool("webpull_list_pulls", { limit: 10 });
					out.textContent = JSON.stringify(result.structuredContent || result, null, 2);
				} catch (error) {
					out.textContent = String(error && error.message ? error.message : error);
				}
			});
		</script>
	</body>
</html>`

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
	})
}

function mcpJson(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
			"access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id",
		},
	})
}

function error(message: string, status = 400): Response {
	return json({ error: message }, status)
}

function withSecurityHeaders(response: Response): Response {
	const headers = new Headers(response.headers)
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
		if (!headers.has(key)) headers.set(key, value)
	}
	if (headers.get("content-type")?.includes("text/html") && !headers.has("content-security-policy")) {
		headers.set("content-security-policy", CONTENT_SECURITY_POLICY)
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function toolText(text: string) {
	return [{ type: "text", text }]
}

function pullSummary(pull: PullRow) {
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

function docSummary(doc: DocRow) {
	return {
		id: doc.id,
		pullId: doc.pull_id,
		path: doc.path,
		url: doc.url,
		title: doc.title || doc.path,
		preview: doc.content.length <= 700 ? doc.content : `${doc.content.slice(0, 700)}\n\n...truncated`,
	}
}

function mcpTool(name: string, title: string, description: string, inputSchema: Record<string, unknown>) {
	return {
		name,
		title,
		description,
		inputSchema,
		_meta: {
			ui: { resourceUri: WIDGET_URI },
			"ui/resourceUri": WIDGET_URI,
			"openai/outputTemplate": WIDGET_URI,
		},
	}
}

function parseCookies(request: Request): Record<string, string> {
	const header = request.headers.get("cookie") || ""
	const out: Record<string, string> = {}
	for (const part of header.split(";")) {
		const [rawKey, ...rawValue] = part.trim().split("=")
		if (!rawKey || rawValue.length === 0) continue
		out[rawKey] = decodeURIComponent(rawValue.join("="))
	}
	return out
}

function getOwnerKey(request: Request): { key: string; isNew: boolean } {
	const existing = parseCookies(request)[OWNER_COOKIE]
	if (existing && /^[a-f0-9-]{36}$/i.test(existing)) return { key: existing, isNew: false }
	return { key: crypto.randomUUID(), isNew: true }
}

function withOwnerCookie(response: Response, owner: { key: string; isNew: boolean }): Response {
	if (!owner.isNew) return response
	const headers = new Headers(response.headers)
	headers.append(
		"set-cookie",
		`${OWNER_COOKIE}=${encodeURIComponent(owner.key)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`,
	)
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function normalizeUrl(raw: string): string | null {
	const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
	try {
		const url = new URL(withProtocol)
		if (url.protocol !== "http:" && url.protocol !== "https:") return null
		url.hash = ""
		return url.href
	} catch {
		return null
	}
}

function pathForUrl(raw: string): string {
	const url = new URL(raw)
	const segments = url.pathname
		.split("/")
		.map((segment) => {
			try {
				return decodeURIComponent(segment)
			} catch {
				return segment
			}
		})
		.map((segment) =>
			[...segment]
				.map((char) => {
					const code = char.charCodeAt(0)
					return code < 32 || '<>:"\\|?*'.includes(char) ? "-" : char
				})
				.join("")
				.trim(),
		)
		.filter((segment) => segment && segment !== "." && segment !== "..")
	let path = segments.join("/")
	if (!path || url.pathname.endsWith("/")) path = `${path ? `${path}/` : ""}index`
	path = path.replace(/\.html?$/, "")
	if (!path.endsWith(".md")) path += ".md"
	return path
}

function escapeFrontmatter(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function decodeHtml(value: string): string {
	return value
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
}

function normalizeText(value: string): string {
	return decodeHtml(
		value
			.replace(/\r/g, "")
			.replace(/[ \t]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	)
}

function stripTags(value: string): string {
	return normalizeText(value.replace(/<[^>]*>/g, " "))
}

function getMeta(html: string, key: string): string {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const patterns = [
		new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
		new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
		new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i"),
	]
	for (const pattern of patterns) {
		const value = html.match(pattern)?.[1]
		if (value) return normalizeText(value)
	}
	return ""
}

function extractTitle(html: string, url: string): string {
	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
	if (title) return stripTags(title)
	const ogTitle = getMeta(html, "og:title") || getMeta(html, "twitter:title")
	if (ogTitle) return ogTitle
	const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
	if (h1) return stripTags(h1)
	return new URL(url).pathname || new URL(url).hostname
}

function markdownBody(content: string): string {
	return content.replace(/^---[\s\S]*?---\s*/, "").trim()
}

export function isWeakMarkdown(content: string): boolean {
	const body = markdownBody(content)
	return body.length < 80 || body.split(/\s+/).filter(Boolean).length < 12
}

function frontmatter(title: string, url: string, extraction: string): string {
	return `---\ntitle: "${escapeFrontmatter(title)}"\nurl: "${url}"\nextraction: "${extraction}"\n---\n\n`
}

function extractJsonLdBlocks(html: string): string[] {
	const blocks: string[] = []
	for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		const raw = match[1]
		if (!raw) continue
		try {
			const parsed = JSON.parse(raw.trim()) as unknown
			const items = Array.isArray(parsed) ? parsed : [parsed]
			for (const item of items) {
				if (!item || typeof item !== "object") continue
				const obj = item as Record<string, unknown>
				const lines: string[] = []
				if (typeof obj.name === "string") lines.push(`## ${obj.name}`)
				if (typeof obj.description === "string") lines.push(obj.description)
				if (Array.isArray(obj.serviceType)) lines.push(`Services: ${obj.serviceType.join(", ")}`)
				const offers = (obj.offers as Record<string, unknown> | undefined)?.itemListElement
				if (Array.isArray(offers)) {
					const offerNames = offers
						.map((offer) => (offer && typeof offer === "object" ? (offer as Record<string, unknown>).name : ""))
						.filter((name): name is string => typeof name === "string" && name.length > 0)
					if (offerNames.length > 0) lines.push(`Offers: ${offerNames.join(", ")}`)
				}
				if (lines.length > 0) blocks.push(lines.join("\n\n"))
			}
		} catch {}
	}
	return blocks
}

export function metadataMarkdown(html: string, url: string): string {
	const title = extractTitle(html, url)
	const lines: string[] = []
	const description =
		getMeta(html, "description") || getMeta(html, "og:description") || getMeta(html, "twitter:description")
	if (description) lines.push(description)
	const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i)?.[1]
	if (canonical) lines.push(`Canonical: ${canonical}`)
	lines.push(...extractJsonLdBlocks(html))
	return `${frontmatter(title, url, "metadata")}${normalizeText(lines.join("\n\n"))}\n`
}

export function htmlToMarkdown(html: string, url: string): { title: string; content: string; extraction: string } {
	const title = extractTitle(html, url)
	const main =
		html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
		html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
		html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
		html
	const markdown = main
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
		.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
		.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
		.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
		.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
		.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
		.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/li>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
	const content = stripTags(markdown)
		.replace(/\n{3,}/g, "\n\n")
		.trim()
	return {
		title,
		content: `${frontmatter(title, url, "static")}${content}\n`,
		extraction: "static",
	}
}

async function browserMarkdown(env: Env, url: string): Promise<string | null> {
	try {
		const response = await env.BROWSER.quickAction("markdown", {
			url,
			gotoOptions: { waitUntil: "networkidle0", timeout: 20000 },
		})
		if (!response.ok) return null
		const data = (await response.json().catch(() => null)) as { success?: boolean; result?: string } | null
		if (!data?.result || !data.success) return null
		return normalizeText(data.result)
	} catch (err) {
		console.log(JSON.stringify({ level: "warn", event: "browser_markdown_failed", url, error: String(err) }))
		return null
	}
}

async function withRetry<T>(operation: () => Promise<T | null>): Promise<T | null> {
	let last: T | null = null
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		last = await operation()
		if (last !== null) return last
		if (attempt < MAX_RETRIES) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
	}
	return last
}

async function convertPage(env: Env, html: string, url: string): Promise<{ title: string; content: string } | null> {
	const staticResult = htmlToMarkdown(html, url)
	if (!isWeakMarkdown(staticResult.content)) return staticResult

	const rendered = await browserMarkdown(env, url)
	if (rendered && rendered.split(/\s+/).filter(Boolean).length >= 12) {
		const title = staticResult.title
		return { title, content: `${frontmatter(title, url, "browser-run")}${rendered}\n` }
	}

	const metadata = metadataMarkdown(html, url)
	if (!isWeakMarkdown(metadata)) return { title: staticResult.title, content: metadata }

	return null
}

async function fetchText(url: string): Promise<{ text: string; url: string } | null> {
	try {
		const response = await fetch(url, {
			redirect: "follow",
			headers: {
				"user-agent": "webpull-cloudflare/1.0 (+https://github.com/ignitabull/webpull)",
				accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		})
		const type = response.headers.get("content-type") ?? ""
		if (!response.ok || (!type.includes("text/html") && !type.includes("xml") && !type.includes("text/plain")))
			return null
		return { text: await response.text(), url: response.url }
	} catch {
		return null
	}
}

async function fetchTextWithRetry(url: string): Promise<{ text: string; url: string } | null> {
	return withRetry(() => fetchText(url))
}

function parseLocs(xml: string): string[] {
	return [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gi)].map((match) => match[1]!.trim())
}

async function discoverFromSitemap(url: string, depth = 0): Promise<string[]> {
	if (depth > 2) return []
	const result = await fetchTextWithRetry(url)
	if (!result?.text.includes("<")) return []
	const locs = parseLocs(result.text)
	const isIndex =
		result.text.includes("<sitemapindex") || (result.text.includes("<sitemap>") && !result.text.includes("<urlset"))
	if (!isIndex) return locs
	const nested = await Promise.all(locs.slice(0, 20).map((loc) => discoverFromSitemap(loc, depth + 1)))
	return nested.flat()
}

function extractLinks(html: string, base: URL, scope: string): string[] {
	const regions = NAV_SELECTORS.flatMap((selector) => [...html.matchAll(selector)].map((match) => match[0]))
	const source = regions.length > 0 ? regions.join("\n") : html
	const links = new Set<string>([base.href])
	for (const match of source.matchAll(/href=["']([^"']+)["']/gi)) {
		try {
			const href = match[1]!
			if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) continue
			const url = new URL(href, base)
			url.hash = ""
			url.search = ""
			if (url.hostname === base.hostname && url.pathname.startsWith(scope) && !IGNORED.test(url.pathname))
				links.add(url.href)
		} catch {}
	}
	return [...links]
}

function getScopePath(pathname: string): string {
	if (pathname === "/") return "/"
	if (/\.\w+$/.test(pathname)) return pathname.replace(/\/[^/]*$/, "/")
	if (pathname.endsWith("/")) return pathname
	const segments = pathname.split("/").filter(Boolean)
	return segments.length <= 1 ? pathname : `/${segments.slice(0, -1).join("/")}/`
}

async function discoverPages(url: string, max: number): Promise<string[]> {
	const baseFetch = await fetchTextWithRetry(url)
	if (!baseFetch) throw new Error(`Could not fetch ${url}`)
	const actual = new URL(baseFetch.url)
	const scope = getScopePath(actual.pathname)
	const sitemapCandidates = [
		`${actual.origin}/robots.txt`,
		`${actual.origin}/sitemap.xml`,
		`${actual.origin}/sitemap_index.xml`,
		`${actual.origin}${actual.pathname.replace(/\/[^/]*$/, "/")}sitemap.xml`,
	]
	const sitemapUrls = new Set<string>()
	for (const candidate of sitemapCandidates) {
		if (candidate.endsWith("robots.txt")) {
			const robots = await fetchTextWithRetry(candidate)
			for (const line of robots?.text.match(/^Sitemap:\s*(.+)$/gim) ?? []) {
				for (const loc of await discoverFromSitemap(line.replace(/^Sitemap:\s*/i, "").trim())) sitemapUrls.add(loc)
			}
		} else {
			for (const loc of await discoverFromSitemap(candidate)) sitemapUrls.add(loc)
		}
	}
	const filtered = [...sitemapUrls]
		.map((raw) => {
			try {
				const parsed = new URL(raw)
				parsed.hash = ""
				parsed.search = ""
				return parsed.href
			} catch {
				return ""
			}
		})
		.filter((raw) => {
			if (!raw) return false
			const parsed = new URL(raw)
			return parsed.hostname === actual.hostname && parsed.pathname.startsWith(scope) && !IGNORED.test(parsed.pathname)
		})
	if (filtered.length > 0) return [...new Set(filtered)].slice(0, max)
	return extractLinks(baseFetch.text, actual, scope).slice(0, max)
}

async function runCloudPull(env: Env, pullId: string, url: string, maxPages: number): Promise<void> {
	let ok = 0
	let err = 0
	try {
		const urls = await discoverPages(url, maxPages)
		for (let index = 0; index < urls.length; index += CONCURRENCY) {
			if (await isPullCancelled(env, pullId)) return
			const batch = urls.slice(index, index + CONCURRENCY)
			const docs = await Promise.all(
				batch.map(async (docUrl) => {
					const fetched = await fetchTextWithRetry(docUrl)
					if (!fetched) return { url: docUrl, error: "Failed to fetch page after retries" }
					const converted = await withRetry(() => convertPage(env, fetched.text, fetched.url))
					if (!converted) return { url: fetched.url, error: "No extractable markdown content after retries" }
					return {
						doc: {
							pullId,
							path: pathForUrl(fetched.url),
							url: fetched.url,
							title: converted.title,
							content: converted.content,
						},
					}
				}),
			)
			if (await isPullCancelled(env, pullId)) return
			const statements: D1PreparedStatement[] = []
			for (const result of docs) {
				if ("error" in result) {
					err++
					statements.push(
						env.DB.prepare("INSERT INTO page_failures (pull_id, url, reason) VALUES (?, ?, ?)").bind(
							pullId,
							result.url,
							result.error,
						),
					)
					continue
				}
				const { doc } = result
				ok++
				statements.push(
					env.DB.prepare(
						`INSERT INTO documents (pull_id, path, url, title, content)
						 VALUES (?, ?, ?, ?, ?)
						 ON CONFLICT(pull_id, path) DO UPDATE SET
							url = excluded.url,
							title = excluded.title,
							content = excluded.content`,
					).bind(doc.pullId, doc.path, doc.url, doc.title, doc.content),
				)
			}
			if (statements.length > 0) await env.DB.batch(statements)
			await env.DB.prepare("UPDATE pulls SET pages_ok = ?, pages_err = ? WHERE id = ?").bind(ok, err, pullId).run()
		}
		if (await isPullCancelled(env, pullId)) return
		const status = ok > 0 && err === 0 ? "complete" : ok > 0 ? "partial" : "failed"
		await env.DB.prepare(
			"UPDATE pulls SET status = ?, pages_ok = ?, pages_err = ?, finished_at = datetime('now') WHERE id = ?",
		)
			.bind(status, ok, err, pullId)
			.run()
	} catch (caught) {
		if (await isPullCancelled(env, pullId)) return
		const reason = caught instanceof Error ? caught.message : String(caught)
		await env.DB.prepare("INSERT INTO page_failures (pull_id, url, reason) VALUES (?, ?, ?)")
			.bind(pullId, url, reason)
			.run()
		await env.DB.prepare(
			"UPDATE pulls SET status = 'failed', pages_ok = ?, pages_err = ?, finished_at = datetime('now') WHERE id = ?",
		)
			.bind(ok, err + 1, pullId)
			.run()
	}
}

async function isPullCancelled(env: Env, pullId: string): Promise<boolean> {
	const pull = await env.DB.prepare("SELECT status FROM pulls WHERE id = ?").bind(pullId).first<{ status: string }>()
	return pull?.status === "cancelled"
}

async function checkRateLimit(env: Env, request: Request): Promise<Response | null> {
	const ip = request.headers.get("cf-connecting-ip") || "unknown"
	const key = `pull:${ip}`
	const now = Math.floor(Date.now() / 1000)
	const current = await env.DB.prepare("SELECT window_start, count FROM rate_limits WHERE key = ?").bind(key).first<{
		window_start: number
		count: number
	}>()
	if (!current || now - current.window_start >= RATE_WINDOW_SECONDS) {
		await env.DB.prepare("INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)")
			.bind(key, now)
			.run()
		return null
	}
	if (current.count >= PULL_RATE_LIMIT) return error("Too many pull requests. Try again shortly.", 429)
	await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").bind(key).run()
	return null
}

async function getPullDocs(env: Env, pullId: string): Promise<DocRow[]> {
	const docs = await env.DB.prepare(
		"SELECT id, pull_id, path, url, title, content FROM documents WHERE pull_id = ? ORDER BY path",
	)
		.bind(pullId)
		.all<DocRow>()
	return docs.results
}

async function getPullFailures(env: Env, pullId: string) {
	const failures = await env.DB.prepare(
		"SELECT url, reason, created_at FROM page_failures WHERE pull_id = ? ORDER BY id",
	)
		.bind(pullId)
		.all()
	return failures.results
}

async function ownsPull(env: Env, pullId: string, ownerKey: string): Promise<boolean> {
	const owner = await env.DB.prepare("SELECT owner_key FROM pull_owners WHERE pull_id = ?").bind(pullId).first<{
		owner_key: string
	}>()
	return owner?.owner_key === ownerKey
}

async function requirePullOwner(env: Env, pullId: string, ownerKey: string): Promise<Response | null> {
	if (await ownsPull(env, pullId, ownerKey)) return null
	return error("Not found", 404)
}

async function cancelOrDeletePull(env: Env, pullId: string): Promise<Response> {
	const pull = await env.DB.prepare("SELECT status FROM pulls WHERE id = ?").bind(pullId).first<{ status: string }>()
	if (!pull) return error("Not found", 404)
	if (pull.status === "queued" || pull.status === "running") {
		await env.DB.prepare("UPDATE pulls SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?")
			.bind(pullId)
			.run()
		return json({ ok: true, status: "cancelled" })
	}

	await deleteR2Prefix(env, exportKey(pullId, ""))
	await env.DB.batch([
		env.DB.prepare("DELETE FROM page_failures WHERE pull_id = ?").bind(pullId),
		env.DB.prepare("DELETE FROM documents WHERE pull_id = ?").bind(pullId),
		env.DB.prepare("DELETE FROM pull_owners WHERE pull_id = ?").bind(pullId),
		env.DB.prepare("DELETE FROM pulls WHERE id = ?").bind(pullId),
	])
	return json({ ok: true, status: "deleted" })
}

function filenameForPull(pull: PullRow, extension: string): string {
	try {
		return `${new URL(pull.url).hostname}-${pull.id.slice(0, 8)}.${extension}`
	} catch {
		return `webpull-${pull.id.slice(0, 8)}.${extension}`
	}
}

function mergedMarkdown(pull: PullRow, docs: DocRow[]): string {
	const sections = docs.map((doc) => `<!-- ${doc.path} | ${doc.url} -->\n\n${doc.content.trim()}\n`)
	return `# webpull export: ${pull.url}\n\nPulled ${docs.length} page${docs.length === 1 ? "" : "s"}.\n\n${sections.join("\n---\n\n")}`
}

async function exportPull(env: Env, pullId: string, format: string): Promise<Response> {
	const pull = await env.DB.prepare("SELECT * FROM pulls WHERE id = ?").bind(pullId).first<PullRow>()
	if (!pull) return error("Not found", 404)
	const docs = await getPullDocs(env, pullId)
	if (docs.length === 0) return error("No documents", 404)

	if (format === "json") {
		return new Response(JSON.stringify({ pull, docs }, null, 2), {
			headers: {
				"content-type": "application/json",
				"content-disposition": `attachment; filename="${filenameForPull(pull, "json")}"`,
			},
		})
	}

	return new Response(mergedMarkdown(pull, docs), {
		headers: {
			"content-type": "text/markdown; charset=utf-8",
			"content-disposition": `attachment; filename="${filenameForPull(pull, "md")}"`,
		},
	})
}

function exportKey(pullId: string, path: string): string {
	return `pulls/${pullId}/${path.replace(/^\/+/, "")}`
}

function exportUrl(pullId: string, path: string): string {
	const encodedPath = path
		.split("/")
		.filter(Boolean)
		.map((segment) => encodeURIComponent(segment))
		.join("/")
	return `/api/exports/${encodeURIComponent(pullId)}/${encodedPath}`
}

async function pushToR2(env: Env, pullId: string): Promise<Response> {
	const pull = await env.DB.prepare("SELECT * FROM pulls WHERE id = ?").bind(pullId).first<PullRow>()
	if (!pull) return error("Not found", 404)
	const docs = await getPullDocs(env, pullId)
	if (docs.length === 0) return error("No documents", 404)

	const files: { path: string; status: string; url: string }[] = []
	for (const doc of docs) {
		const key = exportKey(pullId, doc.path)
		await env.EXPORTS.put(key, doc.content, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } })
		files.push({ path: doc.path, status: "ok", url: exportUrl(pullId, doc.path) })
	}

	const manifest = JSON.stringify({ pull, docs: docs.map(({ content: _content, ...doc }) => doc) }, null, 2)
	await env.EXPORTS.put(exportKey(pullId, "manifest.json"), manifest, {
		httpMetadata: { contentType: "application/json" },
	})

	return json({ ok: files.length, err: 0, destination: "r2", files })
}

function retentionDays(env: Env): number {
	const configured = Number(env.RETENTION_DAYS || DEFAULT_RETENTION_DAYS)
	return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 365) : DEFAULT_RETENTION_DAYS
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<number> {
	let deleted = 0
	let cursor: string | undefined
	do {
		const listed = await env.EXPORTS.list({ prefix, cursor, limit: 1000 })
		const keys = listed.objects.map((object) => object.key)
		if (keys.length > 0) {
			await env.EXPORTS.delete(keys)
			deleted += keys.length
		}
		cursor = listed.truncated ? listed.cursor : undefined
	} while (cursor)
	return deleted
}

export function sqliteDateTime(value: Date): string {
	return value.toISOString().slice(0, 19).replace("T", " ")
}

async function cleanupExpiredPulls(env: Env, now = new Date()): Promise<CleanupResult> {
	const cutoff = sqliteDateTime(new Date(now.getTime() - retentionDays(env) * 24 * 60 * 60 * 1000))
	const expired = await env.DB.prepare(
		`SELECT id
		 FROM pulls
		 WHERE finished_at IS NOT NULL
			AND finished_at < ?
			AND status IN ('complete', 'partial', 'failed', 'cancelled')`,
	)
		.bind(cutoff)
		.all<CleanupRow>()
	let r2Objects = 0
	for (const row of expired.results) {
		r2Objects += await deleteR2Prefix(env, exportKey(row.id, ""))
		await env.DB.batch([
			env.DB.prepare("DELETE FROM page_failures WHERE pull_id = ?").bind(row.id),
			env.DB.prepare("DELETE FROM documents WHERE pull_id = ?").bind(row.id),
			env.DB.prepare("DELETE FROM pull_owners WHERE pull_id = ?").bind(row.id),
			env.DB.prepare("DELETE FROM pulls WHERE id = ?").bind(row.id),
		])
	}
	const staleRateLimitCutoff = Math.floor(now.getTime() / 1000) - RATE_WINDOW_SECONDS * 2
	const rateLimitCleanup = await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
		.bind(staleRateLimitCutoff)
		.run()
	return { pulls: expired.results.length, r2Objects, rateLimits: rateLimitCleanup.meta.changes ?? 0 }
}

async function handleApi(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url)
	const path = url.pathname
	const owner = getOwnerKey(request)

	if (path === "/api/health")
		return json({
			ok: true,
			runtime: "cloudflare",
			storage: "d1",
			limits: { maxPages: MAX_CLOUD_PAGES, concurrency: CONCURRENCY },
		} satisfies HealthResponse)

	if (path === "/api/pull" && request.method === "POST") {
		const limited = await checkRateLimit(env, request)
		if (limited) return limited
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		if (body.source)
			return error(
				"Cloudflare deployment currently supports public website pulls. Use the local app for source integrations.",
				400,
			)
		const normalized = normalizeUrl(String(body.url ?? ""))
		if (!normalized) return error("Valid url is required")
		const maxPages = Math.max(1, Math.min(Number(body.maxPages || MAX_CLOUD_PAGES), MAX_CLOUD_PAGES))
		const pullId = crypto.randomUUID()
		await env.DB.prepare(
			`INSERT INTO pulls (id, url, out_dir, max_pages, worker_count, status, pages_ok, pages_err, started_at)
			 VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, datetime('now'))`,
		)
			.bind(pullId, normalized, `./${new URL(normalized).hostname}`, maxPages, CONCURRENCY)
			.run()
		await env.DB.prepare("INSERT INTO pull_owners (pull_id, owner_key) VALUES (?, ?)").bind(pullId, owner.key).run()
		await env.PULL_QUEUE.send({ pullId, url: normalized, maxPages } satisfies PullJob)
		return withOwnerCookie(json({ pullId }), owner)
	}

	if (path === "/api/pulls" && request.method === "GET") {
		const rows = await env.DB.prepare(
			`SELECT pulls.*
			 FROM pulls
			 JOIN pull_owners ON pull_owners.pull_id = pulls.id
			 WHERE pull_owners.owner_key = ?
			 ORDER BY pulls.started_at DESC
			 LIMIT 50`,
		)
			.bind(owner.key)
			.all<PullRow>()
		return withOwnerCookie(json(rows.results), owner)
	}

	if (path.startsWith("/api/pulls/") && path.endsWith("/docs") && request.method === "GET") {
		const pullId = path.split("/")[3]!
		const denied = await requirePullOwner(env, pullId, owner.key)
		if (denied) return denied
		const docPath = url.searchParams.get("path")
		if (docPath) {
			const doc = await env.DB.prepare("SELECT path, url, title, content FROM documents WHERE pull_id = ? AND path = ?")
				.bind(pullId, docPath)
				.first()
			if (!doc) return error("Not found", 404)
			return json(doc)
		}
		return json(await getPullDocs(env, pullId))
	}

	if (path.startsWith("/api/pulls/") && path.endsWith("/failures") && request.method === "GET") {
		const pullId = path.split("/")[3]!
		const denied = await requirePullOwner(env, pullId, owner.key)
		if (denied) return denied
		return json(await getPullFailures(env, pullId))
	}

	if (path.startsWith("/api/pulls/") && path.endsWith("/export") && request.method === "GET") {
		const pullId = path.split("/")[3]!
		const denied = await requirePullOwner(env, pullId, owner.key)
		if (denied) return denied
		return exportPull(env, pullId, url.searchParams.get("format") || "markdown")
	}

	if (path.startsWith("/api/pulls/") && request.method === "DELETE") {
		const pullId = path.split("/")[3]!
		const denied = await requirePullOwner(env, pullId, owner.key)
		if (denied) return denied
		return cancelOrDeletePull(env, pullId)
	}

	if (path.startsWith("/api/exports/") && request.method === "GET") {
		const parts = path.split("/")
		const pullId = parts[3]
		const docPath = decodeURIComponent(parts.slice(4).join("/"))
		if (!pullId || !docPath) return error("Invalid export path", 400)
		const denied = await requirePullOwner(env, pullId, owner.key)
		if (denied) return denied
		const object = await env.EXPORTS.get(exportKey(pullId, docPath))
		if (!object) return error("Not found", 404)
		return new Response(object.body, {
			headers: { "content-type": object.httpMetadata?.contentType || "application/octet-stream" },
		})
	}

	if (path.startsWith("/api/pulls/") && request.method === "GET") {
		const pullId = path.split("/")[3]!
		const denied = await requirePullOwner(env, pullId, owner.key)
		if (denied) return denied
		const pull = await env.DB.prepare("SELECT * FROM pulls WHERE id = ?").bind(pullId).first<PullRow>()
		if (!pull) return error("Not found", 404)
		return json(pull)
	}

	if (path === "/api/search" && request.method === "GET") {
		const q = `%${(url.searchParams.get("q") ?? "").trim()}%`
		const pullId = url.searchParams.get("pullId")
		if (pullId) {
			const denied = await requirePullOwner(env, pullId, owner.key)
			if (denied) return denied
		}
		const docs = pullId
			? await env.DB.prepare(
					"SELECT id, pull_id, path, url, title, content FROM documents WHERE pull_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY path LIMIT 50",
				)
					.bind(pullId, q, q)
					.all<DocRow>()
			: await env.DB.prepare(
					`SELECT documents.id, documents.pull_id, documents.path, documents.url, documents.title, documents.content
					 FROM documents
					 JOIN pull_owners ON pull_owners.pull_id = documents.pull_id
					 WHERE pull_owners.owner_key = ? AND (documents.title LIKE ? OR documents.content LIKE ?)
					 ORDER BY documents.created_at DESC
					 LIMIT 50`,
				)
					.bind(owner.key, q, q)
					.all<DocRow>()
		return json(docs.results)
	}

	if (path === "/api/projects" && request.method === "GET") return json([])
	if (path === "/api/source-status" && request.method === "GET") {
		return json({
			youtube: { installed: false, authenticated: false, message: "Use the local Bun app for YouTube pulls." },
			twitter: { installed: false, authenticated: false, message: "Use the local Bun app for Twitter pulls." },
			gdrive: { installed: false, authenticated: false, message: "Use the local Bun app for Google Drive pulls." },
		})
	}
	if (path === "/api/destination-status" && request.method === "GET") {
		return json({
			r2: { installed: true, authenticated: true, message: "Ready to publish markdown files to Cloudflare R2." },
			gdrive: { installed: false, authenticated: false, message: "Use the local Bun app for Google Drive export." },
		})
	}
	if (path === "/api/drive/folders" && request.method === "GET") return json({ folders: [] })
	if (path === "/api/source/preview" && request.method === "POST") return json({ items: [], total: 0 })
	if (path === "/api/destination/push" && request.method === "POST") {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		const pullId = String(body.pullId || "")
		if (!pullId) return error("pullId is required")
		const denied = await requirePullOwner(env, pullId, owner.key)
		if (denied) return denied
		if (body.destination === "r2") return pushToR2(env, pullId)
		return error(
			"Cloudflare deployment supports destination=r2. Use the local Bun app for Google Drive credentials.",
			400,
		)
	}
	if (path === "/ws") return error("Cloudflare deployment uses polling instead of WebSockets.", 426)

	return error("Not found", 404)
}

function mcpTools() {
	return [
		mcpTool("webpull_open_app", "Open webpull app", "Open the deployed webpull Cloudflare app widget.", {
			type: "object",
			properties: { limit: { type: "number", minimum: 1, maximum: 50 } },
		}),
		mcpTool("webpull_list_pulls", "List webpull pulls", "List recent website pulls owned by this MCP session.", {
			type: "object",
			properties: { limit: { type: "number", minimum: 1, maximum: 50 } },
		}),
		mcpTool("webpull_start_pull", "Start webpull pull", "Start pulling a public website into markdown on Cloudflare.", {
			type: "object",
			properties: {
				url: { type: "string", description: "Public website or docs URL to pull." },
				maxPages: { type: "number", minimum: 1, maximum: MAX_CLOUD_PAGES },
			},
			required: ["url"],
		}),
		mcpTool("webpull_show_pull", "Show webpull pull", "Show one pull and its markdown documents.", {
			type: "object",
			properties: {
				pullId: { type: "string" },
				limit: { type: "number", minimum: 1, maximum: 50 },
			},
			required: ["pullId"],
		}),
		mcpTool("search", "Search pulled markdown", "Search markdown documents owned by this MCP session.", {
			type: "object",
			properties: {
				query: { type: "string" },
				pullId: { type: "string" },
				limit: { type: "number", minimum: 1, maximum: 20 },
			},
			required: ["query"],
		}),
		mcpTool("fetch", "Fetch pulled markdown document", "Fetch exact markdown for a document returned by search.", {
			type: "object",
			properties: { id: { type: "number", minimum: 1 } },
			required: ["id"],
		}),
	]
}

function mcpResult(id: unknown, result: unknown): Response {
	return mcpJson({ jsonrpc: "2.0", id, result })
}

function mcpError(id: unknown, message: string, code = -32000): Response {
	return mcpJson({ jsonrpc: "2.0", id, error: { code, message } })
}

async function listOwnedPulls(env: Env, ownerKey: string, limit: number): Promise<PullRow[]> {
	const rows = await env.DB.prepare(
		`SELECT pulls.*
		 FROM pulls
		 JOIN pull_owners ON pull_owners.pull_id = pulls.id
		 WHERE pull_owners.owner_key = ?
		 ORDER BY pulls.started_at DESC
		 LIMIT ?`,
	)
		.bind(ownerKey, Math.max(1, Math.min(limit, 50)))
		.all<PullRow>()
	return rows.results
}

async function callMcpTool(
	request: Request,
	env: Env,
	owner: { key: string; isNew: boolean },
	name: string,
	args: Record<string, unknown>,
): Promise<Response> {
	if (name === "webpull_open_app" || name === "webpull_list_pulls") {
		const pulls = (await listOwnedPulls(env, owner.key, Number(args.limit || 20))).map(pullSummary)
		return withOwnerCookie(
			mcpJson({
				structuredContent: { pulls },
				content: toolText(name === "webpull_open_app" ? "Opened the webpull app." : `Found ${pulls.length} pull(s).`),
			}),
			owner,
		)
	}

	if (name === "webpull_start_pull") {
		const limited = await checkRateLimit(env, request)
		if (limited) return limited
		const normalized = normalizeUrl(String(args.url ?? ""))
		if (!normalized) return mcpJson({ content: toolText("Valid url is required"), isError: true }, 400)
		const maxPages = Math.max(1, Math.min(Number(args.maxPages || MAX_CLOUD_PAGES), MAX_CLOUD_PAGES))
		const pullId = crypto.randomUUID()
		await env.DB.prepare(
			`INSERT INTO pulls (id, url, out_dir, max_pages, worker_count, status, pages_ok, pages_err, started_at)
			 VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, datetime('now'))`,
		)
			.bind(pullId, normalized, `./${new URL(normalized).hostname}`, maxPages, CONCURRENCY)
			.run()
		await env.DB.prepare("INSERT INTO pull_owners (pull_id, owner_key) VALUES (?, ?)").bind(pullId, owner.key).run()
		await env.PULL_QUEUE.send({ pullId, url: normalized, maxPages } satisfies PullJob)
		const pull = await env.DB.prepare("SELECT * FROM pulls WHERE id = ?").bind(pullId).first<PullRow>()
		return withOwnerCookie(
			mcpJson({
				structuredContent: { pull: pull ? pullSummary(pull) : { id: pullId, url: normalized, status: "queued" } },
				content: toolText(`Started pulling ${normalized}. Use webpull_show_pull to check status.`),
			}),
			owner,
		)
	}

	if (name === "webpull_show_pull") {
		const pullId = String(args.pullId || "")
		if (!pullId || !(await ownsPull(env, pullId, owner.key)))
			return mcpJson({ content: toolText("Pull not found"), isError: true }, 404)
		const pull = await env.DB.prepare("SELECT * FROM pulls WHERE id = ?").bind(pullId).first<PullRow>()
		if (!pull) return mcpJson({ content: toolText("Pull not found"), isError: true }, 404)
		const docs = (await getPullDocs(env, pullId)).slice(0, Math.max(1, Math.min(Number(args.limit || 20), 50)))
		return mcpJson({
			structuredContent: { pull: pullSummary(pull), results: docs.map(docSummary), selectedPullId: pull.id },
			content: toolText(`${pull.status} pull for ${pull.url}: ${pull.pages_ok} ok, ${pull.pages_err} errors.`),
		})
	}

	if (name === "search") {
		const query = String(args.query || "").trim()
		if (!query) return mcpJson({ content: toolText("query is required"), isError: true }, 400)
		const limit = Math.max(1, Math.min(Number(args.limit || 10), 20))
		const q = `%${query}%`
		const pullId = args.pullId ? String(args.pullId) : ""
		if (pullId && !(await ownsPull(env, pullId, owner.key)))
			return mcpJson({ content: toolText("Pull not found"), isError: true }, 404)
		const docs = pullId
			? await env.DB.prepare(
					"SELECT id, pull_id, path, url, title, content FROM documents WHERE pull_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY path LIMIT ?",
				)
					.bind(pullId, q, q, limit)
					.all<DocRow>()
			: await env.DB.prepare(
					`SELECT documents.id, documents.pull_id, documents.path, documents.url, documents.title, documents.content
					 FROM documents
					 JOIN pull_owners ON pull_owners.pull_id = documents.pull_id
					 WHERE pull_owners.owner_key = ? AND (documents.title LIKE ? OR documents.content LIKE ?)
					 ORDER BY documents.created_at DESC
					 LIMIT ?`,
				)
					.bind(owner.key, q, q, limit)
					.all<DocRow>()
		const results = docs.results.map(docSummary)
		return mcpJson({
			structuredContent: { results, selectedPullId: pullId || null },
			content: toolText(`Found ${results.length} matching document${results.length === 1 ? "" : "s"}.`),
		})
	}

	if (name === "fetch") {
		const id = Number(args.id)
		const doc = await env.DB.prepare(
			`SELECT documents.id, documents.pull_id, documents.path, documents.url, documents.title, documents.content
			 FROM documents
			 JOIN pull_owners ON pull_owners.pull_id = documents.pull_id
			 WHERE pull_owners.owner_key = ? AND documents.id = ?`,
		)
			.bind(owner.key, id)
			.first<DocRow>()
		if (!doc) return mcpJson({ content: toolText("Document not found"), isError: true }, 404)
		return mcpJson({
			structuredContent: { document: doc },
			content: toolText(`Fetched ${doc.title || doc.path} from ${doc.url}.\n\n${doc.content}`),
			_meta: { fullLength: doc.content.length },
		})
	}

	return mcpJson({ content: toolText(`Unknown tool: ${name}`), isError: true }, 404)
}

function mcpLandingHtml(): string {
	return `<!doctype html>
<html lang="en">
	<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>webpull MCP</title></head>
	<body>
		<main>
			<h1>webpull MCP endpoint</h1>
			<p>This Cloudflare endpoint supports the deployed webpull MCP tools for website pulls and R2-backed markdown archives.</p>
			<p>Use <code>webpull_open_app</code> from ChatGPT or Codex to open the embedded app UI.</p>
		</main>
	</body>
</html>`
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
	if (request.method === "OPTIONS") return mcpJson(null, 204)
	if (request.method === "GET") {
		const accept = request.headers.get("accept") ?? ""
		if (accept.includes("text/html") && !accept.includes("text/event-stream")) {
			return new Response(mcpLandingHtml(), {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"access-control-allow-origin": "*",
				},
			})
		}
	}
	if (request.method !== "POST") return mcpError(null, "Method not allowed", -32600)

	const owner = getOwnerKey(request)
	const rpc = (await request.json().catch(() => null)) as {
		id?: unknown
		method?: string
		params?: Record<string, unknown>
	} | null
	if (!rpc?.method) return mcpError(null, "Invalid request", -32600)
	const id = rpc.id ?? null

	if (rpc.method === "initialize") {
		return mcpResult(id, {
			protocolVersion: "2025-06-18",
			capabilities: { tools: {}, resources: {} },
			serverInfo: { name: "webpull-cloudflare", version: "0.1.3" },
			instructions:
				"Use webpull to pull public websites into markdown on Cloudflare, search owned markdown archives, and fetch exact documents.",
		})
	}
	if (rpc.method === "tools/list") return mcpResult(id, { tools: mcpTools() })
	if (rpc.method === "resources/read") {
		if (rpc.params?.uri !== WIDGET_URI) return mcpError(id, "Resource not found", -32004)
		return mcpResult(id, {
			contents: [
				{
					uri: WIDGET_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: MCP_WIDGET_HTML,
					_meta: { ui: { prefersBorder: true } },
				},
			],
		})
	}
	if (rpc.method === "tools/call") {
		const params = rpc.params ?? {}
		const result = await callMcpTool(
			request,
			env,
			owner,
			String(params.name || ""),
			(params.arguments ?? {}) as Record<string, unknown>,
		)
		const body = await result.json().catch(() => ({}))
		const response = mcpResult(id, body)
		return withOwnerCookie(response, owner)
	}
	if (rpc.method.startsWith("notifications/")) return new Response(null, { status: 202 })
	return mcpError(id, `Unknown method: ${rpc.method}`, -32601)
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === "/mcp") return withSecurityHeaders(await handleMcp(request, env))
		if (url.pathname.startsWith("/api/") || url.pathname === "/ws")
			return withSecurityHeaders(await handleApi(request, env))
		return withSecurityHeaders(await env.ASSETS.fetch(request))
	},
	async queue(batch: MessageBatch<PullJob>, env: Env): Promise<void> {
		for (const message of batch.messages) {
			const { pullId, url, maxPages } = message.body
			try {
				const pull = await env.DB.prepare("SELECT id, status FROM pulls WHERE id = ?").bind(pullId).first<{
					id: string
					status: string
				}>()
				if (!pull || ["complete", "partial", "failed", "cancelled"].includes(pull.status)) {
					message.ack()
					continue
				}
				await env.DB.prepare("UPDATE pulls SET status = 'running' WHERE id = ? AND status = 'queued'")
					.bind(pullId)
					.run()
				await runCloudPull(env, pullId, url, maxPages)
				message.ack()
			} catch (caught) {
				const reason = caught instanceof Error ? caught.message : String(caught)
				console.log(JSON.stringify({ level: "error", event: "pull_queue_failed", pullId, reason }))
				message.retry({ delaySeconds: 30 })
			}
		}
	},
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			cleanupExpiredPulls(env).then((result) => {
				console.log(JSON.stringify({ level: "info", event: "retention_cleanup", ...result }))
			}),
		)
	},
}
