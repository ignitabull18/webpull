import { Effect } from "effect"

const YT_DLP_CMD = ["python3", "-m", "yt_dlp"]

/** Default timeout for yt-dlp spawns (ms). Use 60s since large playlists can take a while. */
const YT_DLP_TIMEOUT = 60_000

interface YtDlpVideo {
	id: string
	title: string
	url: string
	channel?: string
	duration?: number
	view_count?: number
	upload_date?: string
}

export interface YtDlpTranscriptSegment {
	text: string
	start: number
	duration: number
}

/** Run yt-dlp and return stdout as lines */
function ytdlp(args: string[]): Effect.Effect<string, Error> {
	return Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawn([...YT_DLP_CMD, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			})
			const timeout = setTimeout(() => proc.kill(), YT_DLP_TIMEOUT)
			try {
				const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
				const exitCode = await proc.exited
				if (exitCode !== 0) {
					const reason = proc.killed ? "timed out" : `exited ${exitCode}`
					throw new Error(`yt-dlp ${reason}: ${stderr.trimEnd().split("\n").pop()}`)
				}
				return stdout
			} finally {
				clearTimeout(timeout)
			}
		},
		catch: (e) => new Error(`Failed to run yt-dlp: ${e}`),
	})
}

/**
 * Discover videos from a YouTube playlist or channel using yt-dlp.
 * Much faster than Chrome-based approaches since it uses flat API calls.
 */
export function discoverPlaylist(target: string, max: number): Effect.Effect<YtDlpVideo[], Error> {
	return Effect.gen(function* () {
		const args = [
			"--flat-playlist",
			"--print",
			"%(id)s|%(title)s|%(channel)s|%(duration)s|%(view_count)s|%(upload_date)s",
			"--playlist-end",
			String(max),
			"--no-warnings",
			target,
		]

		const raw = yield* ytdlp(args)
		const lines = raw
			.trim()
			.split("\n")
			.filter((l) => l.includes("|"))

		return lines.map((line, i) => {
			const parts = line.split("|")
			return {
				id: parts[0] ?? `unknown-${i}`,
				title: parts[1] ?? "Untitled",
				url: `https://www.youtube.com/watch?v=${parts[0]}`,
				channel: parts[2] ?? undefined,
				duration: parts[3] ? Number(parts[3]) : undefined,
				view_count: parts[4] ? Number(parts[4]) : undefined,
				upload_date: parts[5] ?? undefined,
			}
		})
	})
}

/**
 * Attempt to get a transcript via yt-dlp.
 * Returns the transcript text if available, or null if not.
 */
export function getTranscript(videoUrl: string): Effect.Effect<string | null, Error> {
	return Effect.gen(function* () {
		const result = yield* Effect.either(
			ytdlp([
				"--skip-download",
				"--write-auto-subs",
				"--sub-langs",
				"en",
				"--convert-subs",
				"srt",
				"--print",
				"after_move:filepath",
				"--output",
				".tmp/webpull-ytdlp-%(id)s",
				"--no-warnings",
				videoUrl,
			]),
		)

		if (result._tag === "Left") {
			return null
		}
		// Check for and parse subtitle file
		const out = result.right.trim()
		const subPath = `${out}.en.srt`
		const subContent = yield* Effect.either(
			Effect.tryPromise({
				try: async () => {
					const f = Bun.file(subPath)
					if (await f.exists()) {
						return await f.text()
					}
					return null
				},
				catch: () => null,
			}),
		)

		// Clean up temp files
		Bun.spawnSync(["rm", "-f", subPath, out])

		if (subContent._tag === "Right" && subContent.right) {
			return srtToText(subContent.right)
		}

		// Try getting the description as fallback content
		const descResult = yield* Effect.either(ytdlp(["--print", "%(description)s", "--no-warnings", videoUrl]))

		if (descResult._tag === "Right" && descResult.right.trim()) {
			return `_Video description:_\n\n${descResult.right.trim().slice(0, 2000)}`
		}

		return null
	})
}

/**
 * Attempt to get transcripts for multiple videos in parallel using yt-dlp.
 * Returns a map of video URL -> transcript text.
 */
export function getTranscriptsBatch(videos: YtDlpVideo[], concurrency = 4): Effect.Effect<Map<string, string>, Error> {
	return Effect.gen(function* () {
		const results = new Map<string, string>()

		// Process in batches to control concurrency
		for (let i = 0; i < videos.length; i += concurrency) {
			const batch = videos.slice(i, Math.min(i + concurrency, videos.length))
			const batchResults = yield* Effect.all(
				batch.map((v) => getTranscript(v.url).pipe(Effect.catchAll(() => Effect.succeed(null as string | null)))),
				{ concurrency: "unbounded" },
			)

			for (let j = 0; j < batch.length; j++) {
				const transcript = batchResults[j]
				const video = batch[j]!
				if (transcript) {
					results.set(video.url, transcript)
				}
			}
		}

		return results
	})
}

/** Parse SRT content into plain text */
function srtToText(srt: string): string {
	const lines = srt.split("\n")
	const textLines: string[] = []

	for (const line of lines) {
		const trimmed = line.trim()
		// Skip index numbers, timestamps, and empty lines
		if (!trimmed || /^\d+$/.test(trimmed) || trimmed.includes("-->")) continue
		textLines.push(trimmed)
	}

	return textLines.join(" ")
}

/** Check if yt-dlp is installed and working */
export function checkYtDlp(): Effect.Effect<{ installed: boolean; version: string }, Error> {
	return Effect.gen(function* () {
		const result = yield* Effect.either(ytdlp(["--version"]))
		if (result._tag === "Right") {
			return { installed: true, version: result.right.trim() }
		}
		return { installed: false, version: "" }
	})
}
