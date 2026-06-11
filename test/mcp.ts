// Smoke test for the ChatGPT/Codex MCP app endpoint.
// Requires the server to be running. Set WEBPULL_PORT env var to match.
// Usage: WEBPULL_PORT=3456 bun run test/mcp.ts
const PORT = process.env.WEBPULL_PORT || "3456"
const BASE_URL = `http://127.0.0.1:${PORT}`
const MCP_URL = `${BASE_URL}/mcp`
const WIDGET_URI = "ui://webpull/app-v2.html"

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

async function postMcp(method: string, params: Record<string, unknown>) {
	const res = await fetch(MCP_URL, {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	})
	const text = await res.text()
	if (!res.ok) throw new Error(`${method} failed with ${res.status}: ${text}`)
	return JSON.parse(text)
}

const landing = await fetch(MCP_URL, { headers: { accept: "text/html" } })
const landingHtml = await landing.text()
check(
	"MCP browser landing returns HTML",
	landing.ok && landing.headers.get("content-type")?.includes("text/html") === true,
)
check("MCP landing explains open tool", landingHtml.includes("webpull_open_app"))
check("MCP landing links regular web UI", landingHtml.includes("regular web UI"))

const toolsResponse = await postMcp("tools/list", {})
const tools = toolsResponse.result?.tools ?? []
const openApp = tools.find((tool: any) => tool.name === "webpull_open_app")
check("tools/list exposes webpull_open_app", !!openApp)
check("open app tool attaches widget resource", openApp?._meta?.ui?.resourceUri === WIDGET_URI)
check("open app tool has ChatGPT template alias", openApp?._meta?.["openai/outputTemplate"] === WIDGET_URI)

for (const toolName of ["webpull_list_pulls", "webpull_start_pull", "webpull_show_pull", "search", "fetch"]) {
	check(
		`tools/list exposes ${toolName}`,
		tools.some((tool: any) => tool.name === toolName),
	)
}

const resourceResponse = await postMcp("resources/read", { uri: WIDGET_URI })
const contents = resourceResponse.result?.contents ?? []
const widget = contents.find((content: any) => content.uri === WIDGET_URI)
const widgetHtml = widget?.text ?? ""
check("resources/read returns widget", !!widget)
check("widget has MCP app MIME type", widget?.mimeType === "text/html;profile=mcp-app")
check("widget uses ChatGPT callTool bridge", widgetHtml.includes("window.openai.callTool"))
check("widget listens for ChatGPT global updates", widgetHtml.includes("openai:set_globals"))
check("widget keeps portable MCP fallback", widgetHtml.includes('sendRpc("tools/call"'))

const openResponse = await postMcp("tools/call", { name: "webpull_open_app", arguments: { limit: 5 } })
const pulls = openResponse.result?.structuredContent?.pulls
check(
	"webpull_open_app returns structured pulls",
	Array.isArray(pulls),
	Array.isArray(pulls) ? `${pulls.length} pulls` : "",
)
check(
	"webpull_open_app returns user-facing text",
	openResponse.result?.content?.[0]?.text === "Opened the webpull app.",
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
