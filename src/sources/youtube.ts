import { Effect } from "effect"
import type { SourceAdapter, SourceConfig, SourceContent, SourceItem } from "./types"

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
 * YouTube source adapter.
 *
 * Supports:
 * - Playlist URLs: discovers all videos, fetches transcripts for each
 * - Channel handles/IDs: discovers recent videos, fetches transcripts
 * - Single video URLs: fetches transcript directly
 *
 * Uses `opencli youtube` under the hood.
 */
class YoutubeAdapter implements SourceAdapter {
	readonly name = "YouTube"

	discover(config: SourceConfig): Effect.Effect<SourceItem[], Error> {
		return Effect.gen(this, function* () {
			const target = config.target.trim()

			// Playlist URL or ID
			if (target.includes("playlist?list=") || /^PL[\w-]{10,}$/.test(target)) {
				const playlistId = target.includes("list=") ? new URL(target).searchParams.get("list")! : target

				const videos = yield* execJson<YoutubeVideo[]>([
					"opencli",
					"youtube",
					"playlist",
					playlistId,
					"--limit",
					String(config.max),
					"--window",
					"background",
					"-f",
					"json",
				])

				return videos.slice(0, config.max).map((v, i) => ({
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
					String(config.max),
					"--window",
					"background",
					"-f",
					"json",
				])

				return videos.slice(0, config.max).map((v, i) => ({
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

				// video command returns a key-value object, not an array
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

			// Try getting the transcript first
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

			let content = ""
			let hasTranscript = false

			if (transcriptResult._tag === "Right") {
				const t = transcriptResult.right
				if (Array.isArray(t) && t.length > 0) {
					// Segments array
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

			// If no transcript, fall back to video metadata
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

			// Convert to markdown with frontmatter
			const markdown =
				`---\ntitle: "${item.title.replace(/"/g, '\\"')}"\nurl: "${item.url}"\nvideo_id: "${videoId}"\nhas_transcript: ${hasTranscript}\n---\n\n` +
				`# ${item.title}\n\n${content}`

			return {
				item,
				content: markdown,
				mimeType: "text/markdown",
			}
		})
	}
}

function extractVideoId(url: string): string | null {
	// youtu.be/VIDEO_ID
	const shortMatch = url.match(/youtu\.be\/([\w-]{11})/)
	if (shortMatch) return shortMatch[1]!

	// youtube.com/watch?v=VIDEO_ID
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

	// Bare video ID (11 chars)
	const bareMatch = url.match(/^[\w-]{11}$/)
	if (bareMatch) return bareMatch[0]!

	return null
}

export const youtubeAdapter: SourceAdapter = new YoutubeAdapter()
