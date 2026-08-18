export function escapeFrontmatter(value: string): string {
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

export function normalizeText(value: string): string {
	return decodeHtml(
		value
			.replace(/\r/g, "")
			.replace(/[ \t]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	)
}

export function stripTags(value: string): string {
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

export function extractTitle(html: string, url: string): string {
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

export function frontmatter(title: string, url: string, extraction: string): string {
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

export function sqliteDateTime(value: Date): string {
	return value.toISOString().slice(0, 19).replace("T", " ")
}
