const baseUrl = process.env.WEBPULL_CLOUDFLARE_URL || "https://webpull.lingering-rain-68b6.workers.dev"

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

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			...(init?.headers || {}),
			...(cookie ? { cookie } : {}),
		},
	})
	const setCookie = response.headers.get("set-cookie")
	if (setCookie) cookie = setCookie.split(";")[0] || cookie
	return { ok: response.ok, status: response.status, body: (await response.json().catch(() => ({}))) as T }
}

async function waitForPull(pullId: string) {
	let body: any = null
	for (let i = 0; i < 30; i++) {
		const response = await api<any>(`/api/pulls/${pullId}`)
		body = response.body
		if (["complete", "partial", "failed", "cancelled"].includes(body.status)) break
		await new Promise((resolve) => setTimeout(resolve, 2000))
	}
	return body
}

const status = await api<Record<string, { installed: boolean; authenticated: boolean }>>("/api/source-status")
check("source status loads", status.ok)
for (const key of ["youtube", "twitter", "gdrive"]) {
	check(`${key} source is enabled`, status.body[key]?.installed === true && status.body[key]?.authenticated === true)
}

const youtubePreview = await api<{ items?: { id: string; title: string; url: string }[] }>("/api/source/preview", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ source: "youtube", target: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", max: 1 }),
})
check(
	"YouTube preview works",
	youtubePreview.ok && !!youtubePreview.body.items?.[0]?.id,
	youtubePreview.body.items?.[0]?.title,
)

const youtubePull = await api<{ pullId?: string }>("/api/pull", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ source: "youtube", target: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", maxPages: 1 }),
})
check("YouTube source pull starts", youtubePull.ok && !!youtubePull.body.pullId, youtubePull.body.pullId)
if (youtubePull.body.pullId) {
	const pull = await waitForPull(youtubePull.body.pullId)
	check("YouTube source pull finishes with docs", pull.status === "complete" && pull.pages_ok > 0, JSON.stringify(pull))
	const docs = await api<any[]>(`/api/pulls/${youtubePull.body.pullId}/docs`)
	check("YouTube source doc is markdown", docs.ok && /video_id|has_transcript/i.test(docs.body[0]?.content || ""))
}

const tweetPreview = await api<{ items?: { id: string; title: string; url: string }[] }>("/api/source/preview", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ source: "twitter", target: "https://x.com/XDevelopers/status/1474035275256102916", max: 1 }),
})
check(
	"Twitter public tweet preview works",
	tweetPreview.ok && !!tweetPreview.body.items?.[0]?.id,
	tweetPreview.body.items?.[0]?.title,
)

const tweetPull = await api<{ pullId?: string }>("/api/pull", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		source: "twitter",
		target: "https://x.com/XDevelopers/status/1474035275256102916",
		maxPages: 1,
	}),
})
check("Twitter source pull starts", tweetPull.ok && !!tweetPull.body.pullId, tweetPull.body.pullId)
if (tweetPull.body.pullId) {
	const pull = await waitForPull(tweetPull.body.pullId)
	check("Twitter source pull finishes with docs", pull.status === "complete" && pull.pages_ok > 0, JSON.stringify(pull))
	const docs = await api<any[]>(`/api/pulls/${tweetPull.body.pullId}/docs`)
	check("Twitter source doc is markdown", docs.ok && /tweet_id|Tweet/i.test(docs.body[0]?.content || ""))
}

const driveTarget = "https://drive.google.com/file/d/1-nVq-Y43Iz23hqKt90Bco4l48dDaWQC8/view?usp=drivesdk"
const drivePreview = await api<{ items?: { id: string; title: string; url: string }[] }>("/api/source/preview", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ source: "gdrive", target: driveTarget, max: 1 }),
})
check("Google Drive public file preview works", drivePreview.ok && !!drivePreview.body.items?.[0]?.id)

const drivePull = await api<{ pullId?: string }>("/api/pull", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ source: "gdrive", target: driveTarget, maxPages: 1 }),
})
check("Google Drive source pull starts", drivePull.ok && !!drivePull.body.pullId, drivePull.body.pullId)
if (drivePull.body.pullId) {
	const pull = await waitForPull(drivePull.body.pullId)
	check(
		"Google Drive source pull finishes with docs",
		pull.status === "complete" && pull.pages_ok > 0,
		JSON.stringify(pull),
	)
	const docs = await api<any[]>(`/api/pulls/${drivePull.body.pullId}/docs`)
	check(
		"Google Drive source doc is markdown",
		docs.ok && /file_id|Google Drive file/i.test(docs.body[0]?.content || ""),
	)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
