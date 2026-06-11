import { Effect } from "effect"
import type { SourceAdapter, SourceConfig, SourceContent, SourceItem, SourceStatus } from "./types"
import { checkYtDlp, discoverPlaylist, getTranscript, getTranscriptsBatch } from "./ytdlp"

function exec(cmd: string[]): Effect.Effect<string, Error> {
	return Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" })
			if (proc.exitCode !== 0) {
				const errText = new TextDecoder().decode(proc.stderr)
				throw new Error(`opencli exited ${proc.exitCode}: ${errText.trimEnd()}`)
			}
			return new TextDecoder().decode(proc.stdout)
		},
		catch: (e) => new Error(`Failed to run opencli: ${e}`),
	})
}

function execJson<T>(cmd: string[]): Effect.Effect<T, Error> {
	return exec(cmd).pipe(
		Effect.flatMap((out) =>
			Effect.try({
				try: () => JSON.parse(out.trim() || "[]") as T,
				catch: (e) => new Error(`JSON parse: ${e}`),
			}),
		),
	)
}

interface YoutubeVideo {
	rank?: number
	title: string
	video_id?: string
	url: string
	duration?: string
	views?: string
	published?: string
	channel?: string
}

interface YoutubeTranscriptSegment {
	text: string
	start?: number
	dur?: number
}

type YoutubeTranscriptOutput = { segments: YoutubeTranscriptSegment[] } | { text: string } | YoutubeTranscriptSegment[]

/**
 * YouTube source adapter with dual-engine transcript strategy.
 *
 * Discovery:
 * - yt-dlp for playlists and channels (fast, API-based, 1-2s for 50 videos)
 * - opencli fallback when yt-dlp isn't available
 *
 * Transcripts:
 * - yt-dlp first (fast, parallel batch, <1s per video)
 * - opencli fallback (Chrome-based, reliable but sequential)
 * - Video description as last resort
 */
class YoutubeAdapter implements SourceAdapter {
	readonly name = "YouTube"
	private ytDlpAvailable: boolean | null = null

	checkStatus(): Effect.Effect<SourceStatus, Error> {
		return Effect.gen(this, function* () {
			// Check yt-dlp
			const ytdlpStatus = yield* Effect.either(checkYtDlp().pipe(Effect.timeout(15_000)))
			const ytdlpOk = ytdlpStatus._tag === "Right" && ytdlpStatus.right.installed
			this.ytDlpAvailable = ytdlpOk

			// Check opencli
			const which = Bun.spawnSync(["which", "opencli"], { stdout: "pipe", stderr: "pipe" })
			const opencliInstalled = which.exitCode === 0

			const parts: string[] = []

			if (ytdlpOk) {
				const ver = ytdlpStatus._tag === "Right" ? ytdlpStatus.right.version : ""
				parts.push(`yt-dlp ${ver}`)
			} else if (opencliInstalled) {
				parts.push("opencli (Chrome)")
			}

			if (!ytdlpOk && !opencliInstalled) {
				return {
					installed: false,
					authenticated: false,
					message: "Neither yt-dlp nor opencli installed. Run: pip3 install yt-dlp",
				}
			}

			// Check if at least one path works
			if (ytdlpOk) {
				// yt-dlp is our fast path — ready to go
				return { installed: true, authenticated: true, message: `Ready — ${parts.join(" + ")}` }
			}

			// Fallback to opencli auth check
			const checkResult = yield* Effect.either(
				Effect.tryPromise({
					try: async () => {
						const proc = Bun.spawn(
							["opencli", "youtube", "channel", "@", "--limit", "1", "--window", "background", "-f", "json"],
							{ stdout: "pipe", stderr: "pipe" },
						)
						const timeout = setTimeout(() => proc.kill(), 15_000)
						try {
							const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
							const code = await proc.exited
							if (code !== 0) throw new Error(err)
							return out
						} finally {
							clearTimeout(timeout)
						}
					},
					catch: (e) => new Error(String(e)),
				}),
			)
			if (checkResult._tag === "Right") {
				return { installed: true, authenticated: true, message: "Ready — Chrome session active" }
			}
			const errMsg = String(checkResult.left).toLowerCase()
			if (errMsg.includes("auth") || errMsg.includes("login") || errMsg.includes("not logged")) {
				return {
					installed: true,
					authenticated: false,
					message: "Not authenticated — log into YouTube in Chrome first",
				}
			}
			return { installed: true, authenticated: false, message: "Chrome session may not be available" }
		})
	}

	discover(config: SourceConfig): Effect.Effect<SourceItem[], Error> {
		return Effect.gen(this, function* () {
			const target = config.target.trim()

			// Try yt-dlp first for playlists and channels (much faster)
			if (this.ytDlpAvailable !== false) {
				const ytdlpResult = yield* Effect.either(this.discoverViaYtDlp(target, config.max))
				if (ytdlpResult._tag === "Right" && ytdlpResult.right.length > 0) {
					return ytdlpResult.right
				}
				// Mark as unavailable if yt-dlp consistently fails
				this.ytDlpAvailable = false
			}

			// Fallback to opencli
			return yield* this.discoverViaOpenCli(target, config.max)
		})
	}

	private discoverViaYtDlp(target: string, max: number): Effect.Effect<SourceItem[], Error> {
		return Effect.gen(this, function* () {
			const videos = yield* discoverPlaylist(target, max)

			return videos.map((v) => ({
				id: v.id,
				title: v.title,
				url: v.url,
				meta: {
					channel: v.channel,
					duration: v.duration,
					views: v.view_count,
					published: v.upload_date,
				},
			}))
		})
	}

	private discoverViaOpenCli(target: string, max: number): Effect.Effect<SourceItem[], Error> {
		return Effect.gen(this, function* () {
			// Playlist URL or ID
			if (target.includes("playlist?list=") || /^PL[\w-]{10,}$/.test(target)) {
				const playlistId = target.includes("list=") ? new URL(target).searchParams.get("list")! : target

				const videos = yield* execJson<YoutubeVideo[]>([
					"opencli",
					"youtube",
					"playlist",
					playlistId,
					"--limit",
					String(max),
					"--window",
					"background",
					"-f",
					"json",
				])

				return videos.slice(0, max).map((v, i) => ({
					id: extractVideoId(v.url) || `video-${i}`,
					title: v.title,
					url: v.url,
					meta: {
						channel: v.channel,
						duration: v.duration,
						views: v.views,
						published: v.published,
						rank: v.rank ?? i + 1,
					},
				}))
			}

			// Channel handle or ID
			if (target.startsWith("@") || /^UC[\w-]{20,}$/.test(target)) {
				const videos = yield* execJson<YoutubeVideo[]>([
					"opencli",
					"youtube",
					"channel",
					target,
					"--limit",
					String(max),
					"--window",
					"background",
					"-f",
					"json",
				])

				return videos.slice(0, max).map((v, i) => ({
					id: extractVideoId(v.url) || `video-${i}`,
					title: v.title,
					url: v.url,
					meta: {
						channel: v.channel,
						duration: v.duration,
						views: v.views,
						published: v.published,
						rank: v.rank ?? i + 1,
					},
				}))
			}

			// Single video URL
			const videoId = extractVideoId(target)
			if (videoId) {
				const videos = yield* execJson<YoutubeVideo[]>([
					"opencli",
					"youtube",
					"video",
					target,
					"--window",
					"background",
					"-f",
					"json",
				])

				const v = Array.isArray(videos) ? videos[0] : (videos as unknown as YoutubeVideo)
				if (!v?.url) {
					return yield* Effect.fail(new Error("Could not get video metadata"))
				}
				return [
					{
						id: videoId,
						title: v.title || target,
						url: v.url || target,
						meta: { channel: v.channel },
					},
				]
			}

			return yield* Effect.fail(
				new Error("Unrecognized YouTube target. Use a playlist URL/ID, channel handle (@name), or video URL."),
			)
		})
	}

	fetch(item: SourceItem): Effect.Effect<SourceContent, Error> {
		return Effect.gen(this, function* () {
			const videoId = item.id
			let content = ""
			let hasTranscript = false

			// Strategy 1: Try yt-dlp first (fast, doesn't need Chrome)
			if (this.ytDlpAvailable !== false) {
				const ytdlpResult = yield* Effect.either(getTranscript(item.url))
				if (ytdlpResult._tag === "Right" && ytdlpResult.right) {
					content = ytdlpResult.right
					hasTranscript = true
				}
			}

			// Strategy 2: Fall back to opencli Chrome-based transcript
			if (!hasTranscript) {
				const transcriptResult = yield* Effect.either(
					execJson<YoutubeTranscriptOutput>([
						"opencli",
						"youtube",
						"transcript",
						item.url,
						"--mode",
						"grouped",
						"--window",
						"background",
						"-f",
						"json",
					]),
				)

				if (transcriptResult._tag === "Right") {
					const t = transcriptResult.right
					if (Array.isArray(t) && t.length > 0) {
						content = t.map((s: YoutubeTranscriptSegment) => s.text).join(" ")
						hasTranscript = true
					} else if (typeof (t as any).text === "string") {
						content = (t as any).text
						hasTranscript = true
					} else if ((t as any).segments && Array.isArray((t as any).segments)) {
						content = (t as any).segments.map((s: YoutubeTranscriptSegment) => s.text).join(" ")
						hasTranscript = true
					}
				}
			}

			// Strategy 3: If still no transcript, use video metadata/description
			if (!hasTranscript) {
				const videoResult = yield* Effect.either(
					execJson<YoutubeVideo[]>(["opencli", "youtube", "video", item.url, "--window", "background", "-f", "json"]),
				)
				if (videoResult._tag === "Right") {
					const v = Array.isArray(videoResult.right) ? videoResult.right[0] : videoResult.right
					if (v) {
						content = `# ${v.title || item.title}\n\nChannel: ${v.channel || "N/A"}\nViews: ${v.views || "N/A"}\nDuration: ${v.duration || "N/A"}\n\n_No transcript available for this video._`
					}
				}
				if (!content) {
					content = `# ${item.title}\n\n_No content available._`
				}
			}

			const markdown =
				`---\ntitle: "${item.title.replace(/"/g, '\\"')}"\nurl: "${item.url}"\nvideo_id: "${videoId}"\nhas_transcript: ${hasTranscript}\n---\n\n` +
				`# ${item.title}\n\n${content}`

			return { item, content: markdown, mimeType: "text/markdown" }
		})
	}

	/**
	 * Batch-fetch transcripts for multiple items using yt-dlp in parallel.
	 * Falls back to sequential opencli for any that fail.
	 */
	fetchBatch(items: SourceItem[]): Effect.Effect<SourceContent[], Error> {
		return Effect.gen(this, function* () {
			if (this.ytDlpAvailable === false || items.length < 2) {
				// Sequential
				const results: SourceContent[] = []
				for (const item of items) {
					const content = yield* this.fetch(item)
					results.push(content)
				}
				return results
			}

			const ytVideos = items.map((item) => ({
				id: item.id,
				title: item.title,
				url: item.url,
			}))

			const transcriptMap = yield* Effect.either(getTranscriptsBatch(ytVideos, 4))

			const results: SourceContent[] = []
			let _batchOk = 0
			let batchFailed = 0

			if (transcriptMap._tag === "Right") {
				for (const item of items) {
					const transcript = transcriptMap.right.get(item.url)
					if (transcript) {
						const markdown =
							`---\ntitle: "${item.title.replace(/"/g, '\\"')}"\nurl: "${item.url}"\nvideo_id: "${item.id}"\nhas_transcript: true\n---\n\n` +
							`# ${item.title}\n\n${transcript}`
						results.push({ item, content: markdown, mimeType: "text/markdown" })
						_batchOk++
					} else {
						batchFailed++
					}
				}
			} else {
				batchFailed = items.length
			}

			// Fall back to individual fetch for failed ones
			if (batchFailed > 0) {
				const failedItems = items.filter((item) => !results.some((r) => r.item.id === item.id))
				for (const item of failedItems) {
					const content = yield* this.fetch(item)
					results.push(content)
				}
			}

			return results
		})
	}
}

function extractVideoId(url: string): string | null {
	const shortMatch = url.match(/youtu\.be\/([\w-]{11})/)
	if (shortMatch) return shortMatch[1]!

	const parsed = (() => {
		try {
			return new URL(url)
		} catch {
			return null
		}
	})()
	if (parsed) {
		const v = parsed.searchParams.get("v")
		if (v) return v
	}

	const bareMatch = url.match(/^[\w-]{11}$/)
	if (bareMatch) return bareMatch[0]!

	return null
}

export const youtubeAdapter: SourceAdapter = new YoutubeAdapter()
