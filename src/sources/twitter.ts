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

/**
 * Twitter/X source adapter.
 *
 * Supports:
 * - Bookmarks: all bookmarks or a specific folder
 * - User tweets: recent tweets from a user
 * - Threads: full conversation thread
 * - Search: keyword/operator search
 * - Lists: tweet list timeline
 *
 * Uses `opencli twitter` under the hood. Requires Chrome with an active X session.
 */
class TwitterAdapter implements SourceAdapter {
	readonly name = "Twitter"

	discover(config: SourceConfig): Effect.Effect<SourceItem[], Error> {
		return Effect.gen(this, function* () {
			const target = config.target.trim()
			const opencliBase = ["opencli", "twitter"]
			const windowOpts = ["--window", "background"]

			// --- Bookmark folders ---
			if (target === "bookmarks" || target === "bookmark-folders") {
				const folders = yield* execJson<BookmarkFolder[]>([
					...opencliBase,
					"bookmark-folders",
					...windowOpts,
					"-f",
					"json",
				])

				if (folders.length === 0) {
					return yield* Effect.fail(new Error("No bookmark folders found. Are you logged into X in Chrome?"))
				}

				// Treat each folder as a discoverable "item" — the user picks one
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

			// --- Specific bookmark folder ---
			if (target.startsWith("folder:")) {
				const folderId = target.slice("folder:".length)
				const tweets = yield* execJson<Tweet[]>([
					...opencliBase,
					"bookmark-folder",
					folderId,
					"--limit",
					String(config.max),
					...windowOpts,
					"-f",
					"json",
				])
				return tweetsToItems(tweets)
			}

			// --- All bookmarks ---
			if (target === "all-bookmarks" || target === "saved") {
				const tweets = yield* execJson<Tweet[]>([
					...opencliBase,
					"bookmarks",
					"--limit",
					String(config.max),
					...windowOpts,
					"-f",
					"json",
				])
				return tweetsToItems(tweets)
			}

			// --- User tweets ---
			if (target.startsWith("@") || target.startsWith("tweets:")) {
				const username = target.startsWith("tweets:") ? target.slice("tweets:".length) : target
				const tweets = yield* execJson<Tweet[]>([
					...opencliBase,
					"tweets",
					username.replace(/^@/, ""),
					"--limit",
					String(config.max),
					...windowOpts,
					"-f",
					"json",
				])
				return tweetsToItems(tweets)
			}

			// --- List timeline ---
			if (target.startsWith("list:")) {
				const listId = target.slice("list:".length)
				const tweets = yield* execJson<Tweet[]>([
					...opencliBase,
					"list-tweets",
					listId,
					"--limit",
					String(config.max),
					...windowOpts,
					"-f",
					"json",
				])
				return tweetsToItems(tweets)
			}

			// --- Keyword search ---
			if (target.startsWith("search:")) {
				const query = target.slice("search:".length)
				const tweets = yield* execJson<Tweet[]>([
					...opencliBase,
					"search",
					query,
					"--limit",
					String(config.max),
					...windowOpts,
					"-f",
					"json",
				])
				return tweetsToItems(tweets)
			}

			// --- Thread ---
			if (target.startsWith("thread:")) {
				const tweetId = target.slice("thread:".length)
				const tweets = yield* execJson<Tweet[]>([
					...opencliBase,
					"thread",
					tweetId,
					"--limit",
					String(config.max),
					...windowOpts,
					"-f",
					"json",
				])
				return tweetsToItems(tweets)
			}

			return yield* Effect.fail(
				new Error(
					"Unrecognized Twitter target. Use: bookmarks, folder:<id>, all-bookmarks, @username, tweets:username, list:<id>, search:<query>, thread:<id>",
				),
			)
		})
	}

	fetch(item: SourceItem): Effect.Effect<SourceContent, Error> {
		return Effect.sync(() => {
			// Twitter items carry their full text in the discover phase,
			// so fetch just formats them as markdown
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
