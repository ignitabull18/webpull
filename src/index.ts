#!/usr/bin/env bun
import { cpus } from "node:os"
import { resolve } from "node:path"
import { Effect } from "effect"
import { frontmatter } from "./convert"
import { isSPAShell } from "./detect"
import { discover } from "./discover"
import { compressDir, mergeIntoFile, splitIntoFiles } from "./merge"
import { WorkerPool } from "./pool"
import { closeBrowser } from "./renderer"
import type { SourceAdapter, SourceConfig, SourceItem } from "./sources"
import { gdriveAdapter, twitterAdapter, youtubeAdapter } from "./sources"
import { createUI } from "./ui"
import { write } from "./write"

interface Config {
	source: string
	url: string
	out: string
	max: number
	zip: boolean
	merge: boolean
	split: number
}

const SOURCE_ADAPTERS: Record<string, SourceAdapter> = {
	youtube: youtubeAdapter,
	twitter: twitterAdapter,
	gdrive: gdriveAdapter,
}

const parseArgs = (args: string[]): Config => {
	if (!args.length || args.includes("-h") || args.includes("--help")) {
		console.log(`
  webpull - Pull content into markdown

  Usage:  webpull <url> [options]
          webpull --source <source> <target> [options]

  Sources:
    youtube   Playlist URL/ID, channel @handle, or video URL
    twitter   bookmarks, folder:<id>, all-bookmarks, @username, search:<q>, thread:<id>
    gdrive    root, folder:<id>, file:<id>, or query:<q>

  Options:
    -o, --out <dir>   Output directory (default: ./<hostname> or ./<source>)
    -m, --max <n>     Max pages (default: 500)
    -z, --zip         Create a .zip archive of the output
    --merge           Merge all pages into a single _merged.md file
    --split <n>       Split pages evenly across <n> files
    --server          Start the web UI (default when no URL given)

  Examples:
    webpull --source youtube "https://youtube.com/playlist?list=PL..."
    webpull --source twitter bookmarks -m 50
    webpull --source gdrive folder:abc123 -m 20
    webpull https://docs.example.com -m 100
`)
		process.exit(0)
	}

	let source = ""
	let rawUrl = ""
	let out = ""
	let max = 500
	let zip = false
	let merge = false
	let split = 0

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		const next = args[i + 1]
		if ("--source" === arg && next) {
			source = next!.toLowerCase()
			i++
		} else if (("-o" === arg || "--out" === arg) && next) {
			out = next!
			i++
		} else if (("-m" === arg || "--max" === arg) && next) {
			max = +next!
			i++
		} else if ("-z" === arg || "--zip" === arg) {
			zip = true
		} else if ("--merge" === arg) {
			merge = true
		} else if ("--split" === arg && next) {
			split = +next!
			i++
		} else if ("--server" === arg) {
			// handled earlier
		} else if (arg && !arg.startsWith("-") && !rawUrl) {
			rawUrl = arg
		}
	}

	if (source && !SOURCE_ADAPTERS[source]) {
		console.error(`Unknown source: ${source}. Available: ${Object.keys(SOURCE_ADAPTERS).join(", ")}`)
		process.exit(1)
	}

	if (source && !rawUrl) {
		console.error("Target required for source mode. Use --help for examples.")
		process.exit(1)
	}

	if (!source && rawUrl && !/^https?:\/\//i.test(rawUrl)) {
		rawUrl = `https://${rawUrl}`
	}

	if (!source && rawUrl) {
		try {
			new URL(rawUrl)
		} catch {
			console.error(`Bad URL: ${rawUrl}`)
			process.exit(1)
		}
	}

	if (!out) {
		if (source) {
			out = `./${source}-pull`
		} else if (rawUrl) {
			out = `./${new URL(rawUrl).hostname}`
		}
	}

	return { source, url: rawUrl, out: resolve(out), max, zip, merge, split }
}

// --- Source pull pipeline ---

function runSourcePull(adapter: SourceAdapter, config: Config): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const t0 = performance.now()
		const sourceConfig: SourceConfig = { target: config.url, max: config.max, outDir: config.out }
		let items: SourceItem[] = []
		let ok = 0
		let err = 0

		process.stderr.write(`\n  \x1b[1m⚡ webpull\x1b[0m \x1b[90m· ${adapter.name} source · discovering...\x1b[0m\n\n`)

		// Discover
		try {
			items = yield* adapter.discover(sourceConfig)
		} catch (e: any) {
			process.stderr.write(`  \x1b[31mDiscovery failed: ${e.message}\x1b[0m\n`)
			process.exit(1)
		}

		if (!items.length) {
			process.stderr.write("  No items found.\n")
			process.exit(1)
		}

		process.stderr.write(`  Found ${items.length} items\n\n`)

		// Fetch each item (sequential for polite rate limiting)
		const tDisc = performance.now()
		const total = items.length
		const ui = createUI(`[${adapter.name}] ${config.url}`, config.out, 1)
		const recentFiles: string[] = []
		const workerStates: Array<"idle" | "busy"> = ["idle"]
		let lastRender = 0

		const tick = () => {
			const now = performance.now()
			if (now - lastRender < 80) return
			lastRender = now
			ui.render({ total, ok, err, elapsed: (now - tDisc) / 1000, workerStates, recentFiles })
		}

		for (let i = 0; i < items.length; i++) {
			const item = items[i]!
			workerStates[0] = "busy"
			tick()

			try {
				const result = yield* adapter.fetch(item)

				const page = { url: item.url, title: item.title, markdown: result.content }
				const filepath = `${sanitizeFilename(item.title)}.md`
				recentFiles.push(filepath)
				yield* write(page, config.out)
				ok++
			} catch (e: any) {
				process.stderr.write(`  \x1b[31m✗ ${item.title.slice(0, 60)}: ${e.message}\x1b[0m\n`)
				err++
			}

			workerStates[0] = "idle"
			tick()

			// Small delay between fetches to be polite
			if (i < items.length - 1) {
				yield* Effect.sleep(500)
			}
		}

		ui.render({ total, ok, err, elapsed: (performance.now() - tDisc) / 1000, workerStates, recentFiles })
		ui.finish()

		const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
		process.stderr.write(`\n  \x1b[32m\x1b[1mDone!\x1b[0m ${ok} items in ${elapsed}s\n`)
		if (err) process.stderr.write(`  \x1b[31m${err} failed\x1b[0m\n`)
		process.stderr.write(`  \x1b[90mOutput: ${config.out}\x1b[0m\n\n`)
	})
}

// --- URL pull pipeline (original) ---

function runUrlPull(config: Config): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const t0 = performance.now()
		let workerCount = Math.max(8, cpus().length * 2)
		let pool: WorkerPool | null = null

		process.stderr.write(`\n  \x1b[1m⚡ webpull\x1b[0m \x1b[90m· discovering pages...\x1b[0m\n\n`)

		try {
			const urls = yield* discover(config.url, config.max)
			if (!urls.length) {
				process.stderr.write("  No pages found.\n")
				process.exit(1)
			}

			const sampleHtml = yield* Effect.tryPromise({
				try: () => fetch(config.url, { redirect: "follow" }).then((r) => r.text()),
				catch: () => new Error("Failed to detect SPA"),
			}).pipe(Effect.catchAll(() => Effect.succeed("")))
			const needsBrowser = isSPAShell(sampleHtml)
			if (needsBrowser) {
				workerCount = Math.min(workerCount, 4)
			}

			const activePool = new WorkerPool(workerCount)
			if (needsBrowser) activePool.useBrowser = true
			pool = activePool

			const tDisc = performance.now()
			const total = urls.length
			const ui = createUI(config.url, config.out, workerCount)

			let ok = 0
			let err = 0
			const writes: Promise<void>[] = []
			const recentFiles: string[] = []
			const workerStates = new Array<"idle" | "busy">(workerCount).fill("idle")
			const workerMap = new Map<number, number>()
			let nextSlot = 0
			let lastRender = 0

			const tick = () => {
				const now = performance.now()
				if (now - lastRender < 80) return
				lastRender = now
				ui.render({ total, ok, err, elapsed: (now - tDisc) / 1000, workerStates, recentFiles })
			}

			yield* Effect.tryPromise(() =>
				activePool.pullAll(
					urls,
					(idx) => {
						const slot = nextSlot++ % workerCount
						workerMap.set(idx, slot)
						workerStates[slot] = "busy"
						tick()
					},
					(result, idx) => {
						const slot = workerMap.get(idx) ?? 0
						workerStates[slot] = "idle"
						workerMap.delete(idx)

						if (result.ok) {
							ok++
							const finalUrl = result.url ?? urls[idx]!
							const title = result.title || new URL(finalUrl).pathname
							const page = {
								url: finalUrl,
								title,
								markdown: frontmatter(title, finalUrl) + (result.content ?? ""),
							}

							const parsedUrl = new URL(finalUrl)
							let filepath = parsedUrl.pathname
							if (parsedUrl.hash && parsedUrl.hash.length > 1) {
								filepath = parsedUrl.hash.replace(/^#\/?/, "/")
							}
							if (filepath.endsWith("/")) filepath += "index"
							filepath = filepath.replace(/\.html?$/, "").replace(/^\//, "")
							if (!filepath.endsWith(".md")) filepath += ".md"
							recentFiles.push(filepath)

							const writePromise = Effect.runPromise(write(page, config.out))
								.then(() => undefined)
								.catch(() => {
									ok--
									err++
								})
							writes.push(writePromise)
						} else {
							err++
						}
						tick()
					},
				),
			)
			yield* Effect.tryPromise(() => Promise.all(writes))

			ui.render({ total, ok, err, elapsed: (performance.now() - tDisc) / 1000, workerStates, recentFiles })
			ui.finish()

			if (config.zip && ok > 0) {
				process.stderr.write("  \x1b[90mCompressing...\x1b[0m")
				try {
					const zipPath = yield* compressDir(config.out)
					process.stderr.write(` \x1b[32mdone\x1b[0m (${zipPath})\n`)
				} catch (e) {
					process.stderr.write(` \x1b[31mfailed: ${e}\x1b[0m\n`)
				}
			}

			if (config.merge && ok > 0) {
				process.stderr.write("  \x1b[90mMerging into single file...\x1b[0m")
				try {
					const mergePath = yield* mergeIntoFile(config.out)
					process.stderr.write(` \x1b[32mdone\x1b[0m (${mergePath})\n`)
				} catch (e) {
					process.stderr.write(` \x1b[31mfailed: ${e}\x1b[0m\n`)
				}
			}

			if (config.split > 0 && ok > 0) {
				process.stderr.write(`  \x1b[90mSplitting into ${config.split} files...\x1b[0m`)
				try {
					const splitPaths = yield* splitIntoFiles(config.out, config.split)
					process.stderr.write(" \x1b[32mdone\x1b[0m\n")
					for (const p of splitPaths) process.stderr.write(`  \x1b[90mSplit: ${p}\x1b[0m\n`)
				} catch (e) {
					process.stderr.write(` \x1b[31mfailed: ${e}\x1b[0m\n`)
				}
			}

			const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
			const pps = Math.round(ok / ((performance.now() - tDisc) / 1000))

			process.stderr.write(
				`\n  \x1b[32m\x1b[1mDone!\x1b[0m ${ok} pages in ${elapsed}s \x1b[90m(${pps} pages/sec)\x1b[0m\n`,
			)
			if (err) process.stderr.write(`  \x1b[31m${err} failed\x1b[0m\n`)
			process.stderr.write("\n")
		} finally {
			pool?.terminate()
		}
	})
}

// --- Helpers ---

function sanitizeFilename(title: string): string {
	return (
		title
			.replace(/[<>:"/\\|?*]/g, "-")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 80) || "untitled"
	)
}

// --- Entry ---

const args = process.argv.slice(2)
const isServer = args.length === 0 || args.includes("--server")

if (isServer) {
	await import("./server")
	await new Promise(() => {})
}

const config = parseArgs(args)

if (config.source) {
	const adapter = SOURCE_ADAPTERS[config.source]!
	Effect.runPromise(runSourcePull(adapter, config)).catch((e) => {
		console.error(e)
		process.exit(1)
	})
} else {
	Effect.runPromise(runUrlPull(config))
		.catch((e) => {
			console.error(e)
			process.exit(1)
		})
		.finally(() => closeBrowser())
}
