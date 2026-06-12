import { chromium } from "playwright"

const baseUrl = process.env.WEBPULL_CLOUDFLARE_URL || "https://webpull.lingering-rain-68b6.workers.dev"
const targetUrl = process.env.WEBPULL_TEST_URL || "https://ignitabull.com"

function check(name: string, ok: boolean, detail = "") {
	if (!ok) {
		console.error(`✗ ${name}${detail ? `: ${detail}` : ""}`)
		process.exitCode = 1
		return
	}
	console.log(`✓ ${name}${detail ? ` (${detail})` : ""}`)
}

async function browserJson<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
	return page.evaluate(
		async ({ path, init }) => {
			const response = await fetch(path, init)
			return {
				ok: response.ok,
				status: response.status,
				body: (await response.json().catch(() => ({}))) as T,
			}
		},
		{ path, init },
	)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } })
const noisyErrors: string[] = []

page.on("console", (msg) => {
	if (msg.type() === "error") noisyErrors.push(msg.text())
})
page.on("pageerror", (err) => noisyErrors.push(err.message))

try {
	const documentResponse = await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 45_000 })
	check(
		"HTML has security headers",
		documentResponse?.headers()["x-content-type-options"] === "nosniff" &&
			!!documentResponse.headers()["content-security-policy"] &&
			documentResponse.headers()["referrer-policy"] === "strict-origin-when-cross-origin",
		JSON.stringify({
			xContentTypeOptions: documentResponse?.headers()["x-content-type-options"],
			contentSecurityPolicy: documentResponse?.headers()["content-security-policy"],
			referrerPolicy: documentResponse?.headers()["referrer-policy"],
		}),
	)
	check("home page renders", /Pull documentation/i.test(await page.locator("body").innerText()))

	const healthResponse = await page.request.get(`${baseUrl}/api/health`)
	check(
		"API has security headers",
		healthResponse.headers()["x-content-type-options"] === "nosniff" &&
			healthResponse.headers()["referrer-policy"] === "strict-origin-when-cross-origin",
	)
	const health = (await healthResponse.json()) as { limits?: { maxPages?: number } }
	const maxPagesLimit = health.limits?.maxPages ?? 0
	check("Cloudflare health exposes max page limit", maxPagesLimit > 0, `maxPages=${maxPagesLimit}`)

	const sourceTabs = await page.locator(".source-tab").evaluateAll((tabs) =>
		tabs.map((tab) => ({
			text: tab.textContent?.trim() || "",
			disabled: (tab as HTMLButtonElement).disabled,
		})),
	)
	check(
		"Cloudflare-only unavailable sources are disabled",
		sourceTabs.filter((tab) => /YouTube|Twitter|Google Drive/.test(tab.text)).every((tab) => tab.disabled),
		JSON.stringify(sourceTabs),
	)

	await page.waitForFunction(
		(expected) => document.querySelector<HTMLInputElement>('input[type="range"]')?.max === String(expected),
		maxPagesLimit,
	)
	check(
		"website max slider matches Cloudflare limit",
		(await page.locator('input[type="range"]').first().getAttribute("max")) === String(maxPagesLimit),
		`max=${maxPagesLimit}`,
	)

	const oversized = await browserJson<{ pullId?: string }>("/api/pull", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ url: targetUrl, maxPages: maxPagesLimit + 500 }),
	})
	const oversizedBody = oversized.body
	check("over-limit pull starts", oversized.ok && !!oversizedBody.pullId, oversizedBody.pullId || "")
	if (oversizedBody.pullId) {
		const pullResponse = await browserJson<{ max_pages?: number }>(`/api/pulls/${oversizedBody.pullId}`)
		const pull = pullResponse.body
		check("server clamps over-limit maxPages", pull.max_pages === maxPagesLimit, `max_pages=${pull.max_pages}`)

		const cancelResponse = await browserJson<{ status?: string }>(`/api/pulls/${oversizedBody.pullId}`, {
			method: "DELETE",
		})
		const cancelBody = cancelResponse.body
		check(
			"owner can cancel or delete pull",
			cancelResponse.ok && (cancelBody.status === "cancelled" || cancelBody.status === "deleted"),
			cancelBody.status || "",
		)
		if (cancelBody.status === "cancelled") {
			const cancelledResponse = await browserJson<{ status?: string }>(`/api/pulls/${oversizedBody.pullId}`)
			const cancelled = cancelledResponse.body
			check("cancelled pull stays cancelled", cancelled.status === "cancelled", `status=${cancelled.status}`)
		}
	}

	await page.locator('input[placeholder="Paste a docs URL…"]').fill(targetUrl)
	await page
		.locator("button")
		.filter({ hasText: /^Pull$/ })
		.last()
		.click()
	await page.waitForURL(/\/pull\//, { timeout: 20_000 })

	const pullId = page.url().split("/").filter(Boolean).pop()
	check("pull id is present", !!pullId, pullId || "")

	let status = ""
	let pagesOk = 0
	let pagesErr = 0
	for (let i = 0; i < 40 && pullId; i++) {
		const response = await browserJson<{ status: string; pages_ok: number; pages_err: number }>(`/api/pulls/${pullId}`)
		const pull = response.body
		status = pull.status
		pagesOk = pull.pages_ok
		pagesErr = pull.pages_err
		if (["complete", "partial", "failed", "cancelled"].includes(status)) break
		await page.waitForTimeout(3000)
	}

	check("pull completes", status === "complete", `status=${status}`)
	check("pull has documents", pagesOk > 0, `pages_ok=${pagesOk}`)
	check("pull has no failed pages", pagesErr === 0, `pages_err=${pagesErr}`)

	const pushResponse = await browserJson<{
		ok?: number
		files?: { path: string; url: string; status: string }[]
	}>("/api/destination/push", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ pullId, destination: "r2" }),
	})
	const push = pushResponse.body
	const firstExport = push.files?.[0]
	check("R2 publish succeeds", pushResponse.ok && (push.ok ?? 0) > 0 && !!firstExport, `ok=${push.ok}`)
	if (firstExport) {
		check(
			"R2 export URL is encoded",
			firstExport.url ===
				`/api/exports/${encodeURIComponent(pullId || "")}/${firstExport.path
					.split("/")
					.map((segment) => encodeURIComponent(segment))
					.join("/")}`,
			firstExport.url,
		)
		const readback = await page.request.get(`${baseUrl}${firstExport.url}`)
		const readbackText = await readback.text()
		check(
			"R2 readback succeeds",
			readback.ok() && /Ignitabull|Amazon Ads|extraction: "browser-run"/i.test(readbackText),
			`status=${readback.status()}`,
		)
	}

	await page.goto(`${baseUrl}/results/${pullId}`, { waitUntil: "networkidle", timeout: 45_000 })
	await page.waitForTimeout(1500)
	const resultsText = await page.locator("body").innerText()
	check("results render", /Ignitabull|ignitabull\.com|audit\.md/i.test(resultsText))
	check("browser console is quiet", noisyErrors.length === 0, noisyErrors.join(" | "))
} finally {
	await browser.close()
}

if (process.exitCode) process.exit(process.exitCode)
