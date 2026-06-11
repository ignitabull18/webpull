// End-to-end browser test for the webpull UI.
// Requires the server to be running. Set WEBPULL_PORT env var to match.
// Usage: WEBPULL_PORT=3456 bun run test/e2e.ts
import { chromium } from "playwright"

const PORT = process.env.WEBPULL_PORT || "3456"

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(1500)

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

// 1. Website mode renders with 4 source tabs
await page.screenshot({ path: "/tmp/webpull-e2e-website.png", fullPage: false })
const tabCount = await page.locator(".source-tab").count()
check("Website mode — 4 source tabs visible", tabCount === 4, `${tabCount} tabs`)

// 2. YouTube tab
await page.click(".source-tab:nth-child(2)")
await page.waitForTimeout(500)
const ytPlaceholder = await page.locator(".url-bar input").getAttribute("placeholder")
check("YouTube placeholder", !!ytPlaceholder?.includes("Playlist"), ytPlaceholder || "")
await page.screenshot({ path: "/tmp/webpull-e2e-youtube.png", fullPage: false })

// 3. Twitter tab
await page.click(".source-tab:nth-child(3)")
await page.waitForTimeout(500)
const twPlaceholder = await page.locator(".url-bar input").getAttribute("placeholder")
check("Twitter placeholder", !!twPlaceholder?.includes("bookmarks"), twPlaceholder || "")

// 4. Google Drive tab
await page.click(".source-tab:nth-child(4)")
await page.waitForTimeout(500)
const gdPlaceholder = await page.locator(".url-bar input").getAttribute("placeholder")
check("Google Drive placeholder", !!gdPlaceholder?.includes("folder"), gdPlaceholder || "")

// 5. Workers row in Website mode
await page.click(".source-tab:nth-child(1)")
await page.waitForTimeout(500)
const labels = await page.locator(".config-row .field-label").allTextContents()
check(
	"Website mode shows Workers slider",
	labels.some((l) => l === "Workers"),
	labels.join(", "),
)

// 6. Workers hidden in source mode
await page.click(".source-tab:nth-child(2)")
await page.waitForTimeout(500)
const ytConfigRows = await page.locator(".config-row").count()
check("YouTube mode hides Workers (1 config row)", ytConfigRows === 1, `${ytConfigRows} rows`)

// 7. Source preview mentions pulls/ folder
const previewText = await page
	.locator(".url-preview")
	.textContent()
	.catch(() => "")
check("URL preview mentions pulls/ folder", previewText?.includes("pulls/") || false, previewText?.trim() || "")

// 8. Max slider in Website mode
await page.click(".source-tab:nth-child(1)")
await page.waitForTimeout(500)
const wsMax = await page.locator("input[type='range']").first().getAttribute("max")
check("Website max slider = 2000", wsMax === "2000", wsMax || "")

// 9. Max slider in source mode
await page.click(".source-tab:nth-child(2)")
await page.waitForTimeout(500)
const ytMax = await page.locator("input[type='range']").first().getAttribute("max")
check("YouTube max slider = 500", ytMax === "500", ytMax || "")

// 10. Source examples
const examples = await page
	.locator(".source-examples")
	.textContent()
	.catch(() => "")
check("YouTube shows example shortcuts", examples?.includes("Try:") || false, examples?.trim() || "")

await browser.close()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
