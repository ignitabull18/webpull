const baseUrl = process.env.WEBPULL_CLOUDFLARE_URL || "https://webpull.lingering-rain-68b6.workers.dev"
const mcpUrl = `${baseUrl}/mcp`
const widgetUri = "ui://webpull/cloudflare-app.html"

let passed = 0
let failed = 0
let cookie = ""

function check(name: string, ok: boolean, detail = "") {
	if (ok) {
		console.log(`✓ ${name}${detail ? ` (${detail})` : ""}`)
		passed++
		return
	}
	console.error(`✗ ${name}${detail ? `: ${detail}` : ""}`)
	failed++
}

async function postMcp(method: string, params: Record<string, unknown> = {}) {
	const response = await fetch(mcpUrl, {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	})
	const setCookie = response.headers.get("set-cookie")
	if (setCookie) cookie = setCookie.split(";")[0] || cookie
	const body = (await response.json().catch(() => ({}))) as any
	return { response, body }
}

const landing = await fetch(mcpUrl, { headers: { accept: "text/html" } })
const landingText = await landing.text()
check("MCP landing is not the React shell", landing.ok && landingText.includes("webpull MCP endpoint"))
check("MCP landing explains open tool", landingText.includes("webpull_open_app"))

const initialized = await postMcp("initialize", {})
check(
	"MCP initialize succeeds",
	initialized.response.ok && initialized.body.result?.serverInfo?.name === "webpull-cloudflare",
)

const listed = await postMcp("tools/list", {})
const tools = listed.body.result?.tools ?? []
check("MCP tools/list succeeds", listed.response.ok && Array.isArray(tools), `${tools.length} tools`)
check(
	"MCP exposes Cloudflare open app tool",
	tools.some((tool: any) => tool.name === "webpull_open_app" && tool._meta?.ui?.resourceUri === widgetUri),
)
check(
	"MCP exposes core archive tools",
	["webpull_list_pulls", "webpull_start_pull", "webpull_show_pull", "search", "fetch"].every((name) =>
		tools.some((tool: any) => tool.name === name),
	),
)

const resource = await postMcp("resources/read", { uri: widgetUri })
const content = resource.body.result?.contents?.[0]
check("MCP resources/read returns widget", resource.response.ok && content?.uri === widgetUri)
check("MCP widget has app MIME type", content?.mimeType === "text/html;profile=mcp-app")
check("MCP widget calls tools", String(content?.text || "").includes("window.openai.callTool"))

const opened = await postMcp("tools/call", { name: "webpull_open_app", arguments: { limit: 5 } })
check(
	"MCP open app tool call succeeds",
	opened.response.ok && Array.isArray(opened.body.result?.structuredContent?.pulls),
)
check("MCP open app sets owner cookie", cookie.startsWith("webpull_owner="), cookie)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
