import { Effect } from "effect"
import { withRetry } from "./retry"
import type { SourceAdapter, SourceConfig, SourceContent, SourceItem, SourceStatus } from "./types"

const EXEC_TIMEOUT = 30_000

async function execAsync(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
	const timeout = setTimeout(() => proc.kill(), EXEC_TIMEOUT)
	try {
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
		const exitCode = await proc.exited
		if (exitCode !== 0) {
			const reason = proc.killed ? "timed out" : `exited ${exitCode}`
			throw new Error(`opencli ${reason}: ${stderr.trimEnd()}`)
		}
		return stdout
	} finally {
		clearTimeout(timeout)
	}
}

function execJson<T>(cmd: string[]): Effect.Effect<T, Error> {
	return Effect.tryPromise({
		try: async () => {
			const out = await execAsync(cmd)
			return JSON.parse(out.trim() || "[]") as T
		},
		catch: (e) => new Error(`Failed to run opencli: ${e}`),
	})
}

interface Tweet {
	id: string
	author: string
	name?: string
	bio?: string
	text: string
	likes?: number
	retweets?: number
	replies?: number
	views?: number
	bookmarks?: number
	created_at?: string
	url: string
	has_media?: boolean
	media_urls?: string[]
	card?: unknown
	quoted_tweet?: unknown
	is_retweet?: boolean
}

interface BookmarkFolder {
	id: string
	name: string
	items?: number
	created_at?: string
}

class TwitterAdapter implements SourceAdapter {
	readonly name = "Twitter"

	checkStatus(): Effect.Effect<SourceStatus, Error> {
		return Effect.gen(this, function* () {
			const which = Bun.spawnSync(["which", "opencli"], { stdout: "pipe", stderr: "pipe" })
			const installed = which.exitCode === 0
			if (!installed) {
				return { installed: false, authenticated: false, message: "opencli not installed. Run: npm i -g opencli" }
			}

			// Async auth check
			const checkResult = yield* Effect.either(
				execJson<unknown>([
					"opencli",
					"twitter",
					"bookmark-folders",
					"--limit",
					"1",
					"--window",
					"background",
					"-f",
					"json",
				]),
			)

			if (checkResult._tag === "Right") {
				return { installed: true, authenticated: true, message: "Ready — X session active in Chrome" }
			}

			const errMsg = String(checkResult.left).toLowerCase()
			if (errMsg.includes("auth") || errMsg.includes("login") || errMsg.includes("not logged")) {
				return { installed: true, authenticated: false, message: "Not authenticated — log into X in Chrome first" }
			}
			return { installed: true, authenticated: false, message: "Chrome session may not be available" }
		})
	}

	discover(config: SourceConfig): Effect.Effect<SourceItem[], Error> {
		return Effect.gen(this, function* () {
			const target = config.target.trim()
			const base = ["opencli", "twitter"]
			const windowOpts = ["--window", "background"]

			if (target === "bookmarks" || target === "bookmark-folders") {
				const folders = yield* withRetry(
					execJson<BookmarkFolder[]>([...base, "bookmark-folders", ...windowOpts, "-f", "json"]),
					"twitter:discover:folders",
				)

				if (folders.length === 0) {
					return yield* Effect.fail(new Error("No bookmark folders found."))
				}

				return folders.map((f) => ({
					id: `folder:${f.id}`,
					title: `${f.name} (${f.items ?? "?"} items)`,
					url: `https://x.com/i/bookmarks/${f.id}`,
					meta: {
						folderId: f.id,
						itemCount: f.items,
						createdAt: f.created_at,
						kind: "bookmark-folder",
					},
				}))
			}

			let tweets: Tweet[]

			if (target.startsWith("folder:")) {
				const folderId = target.slice("folder:".length)
				tweets = yield* withRetry(
					execJson<Tweet[]>([
						...base,
						"bookmark-folder",
						folderId,
						"--limit",
						String(config.max),
						...windowOpts,
						"-f",
						"json",
					]),
					"twitter:discover:folder",
				)
			} else if (target === "all-bookmarks" || target === "saved") {
				tweets = yield* withRetry(
					execJson<Tweet[]>([...base, "bookmarks", "--limit", String(config.max), ...windowOpts, "-f", "json"]),
					"twitter:discover:bookmarks",
				)
			} else if (target.startsWith("@") || target.startsWith("tweets:")) {
				const username = target.startsWith("tweets:") ? target.slice("tweets:".length) : target
				tweets = yield* withRetry(
					execJson<Tweet[]>([
						...base,
						"tweets",
						username.replace(/^@/, ""),
						"--limit",
						String(config.max),
						...windowOpts,
						"-f",
						"json",
					]),
					"twitter:discover:tweets",
				)
			} else if (target.startsWith("list:")) {
				const listId = target.slice("list:".length)
				tweets = yield* withRetry(
					execJson<Tweet[]>([
						...base,
						"list-tweets",
						listId,
						"--limit",
						String(config.max),
						...windowOpts,
						"-f",
						"json",
					]),
					"twitter:discover:list",
				)
			} else if (target.startsWith("search:")) {
				const query = target.slice("search:".length)
				tweets = yield* withRetry(
					execJson<Tweet[]>([...base, "search", query, "--limit", String(config.max), ...windowOpts, "-f", "json"]),
					"twitter:discover:search",
				)
			} else if (target.startsWith("thread:")) {
				const tweetId = target.slice("thread:".length)
				tweets = yield* withRetry(
					execJson<Tweet[]>([...base, "thread", tweetId, "--limit", String(config.max), ...windowOpts, "-f", "json"]),
					"twitter:discover:thread",
				)
			} else {
				return yield* Effect.fail(
					new Error(
						"Unrecognized Twitter target. Use: bookmarks, folder:<id>, all-bookmarks, @username, tweets:username, list:<id>, search:<query>, thread:<id>",
					),
				)
			}

			return tweetsToItems(tweets)
		})
	}

	fetch(item: SourceItem): Effect.Effect<SourceContent, Error> {
		return Effect.sync(() => {
			const meta = item.meta ?? {}
			const author = String(meta.author ?? "unknown")
			const createdAt = String(meta.created_at ?? "")
			const likes = meta.likes ?? ""
			const retweets = meta.retweets ?? ""
			const views = meta.views ?? ""
			const text = String(meta.text ?? item.title)

			const frontmatterFields = [
				`title: "Tweet by ${author.replace(/"/g, '\\"')}"`,
				`url: "${item.url}"`,
				`tweet_id: "${item.id}"`,
				`author: "${author}"`,
			]
			if (createdAt) frontmatterFields.push(`created_at: "${createdAt}"`)

			const markdown =
				`---\n${frontmatterFields.join("\n")}\n---\n\n` +
				`**@${author}**\n\n${text}\n\n` +
				`${likes ? `♥ ${likes}  ` : ""}${retweets ? `↺ ${retweets}  ` : ""}${views ? `👁 ${views}  ` : ""}\n`

			return { item, content: markdown, mimeType: "text/markdown" }
		})
	}
}

function tweetsToItems(tweets: Tweet[]): SourceItem[] {
	return tweets.map((t) => ({
		id: t.id,
		title: t.text.slice(0, 100).replace(/\n/g, " "),
		url: t.url,
		meta: {
			author: t.author,
			name: t.name,
			text: t.text,
			likes: t.likes,
			retweets: t.retweets,
			replies: t.replies,
			views: t.views,
			bookmarks: t.bookmarks,
			created_at: t.created_at,
			has_media: t.has_media,
			media_urls: t.media_urls,
			is_retweet: t.is_retweet,
		},
	}))
}

export const twitterAdapter: SourceAdapter = new TwitterAdapter()
