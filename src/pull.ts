import { cpus } from "node:os"
import { Effect } from "effect"
import type { Page } from "./convert"
import { frontmatter } from "./convert"
import { isSPAShell } from "./detect"
import { discover } from "./discover"
import type { WorkerResult } from "./pool"
import { WorkerPool } from "./pool"
import { closeBrowser } from "./renderer"
import { write } from "./write"

export interface PullConfig {
	url: string
	out: string
	max: number
	workerCount?: number
	pullId?: string
	signal?: AbortSignal
}

export type PullEvent =
	| { type: "start"; total: number; workerCount: number }
	| {
			type: "progress"
			index: number
			url: string
			status: "ok" | "err"
			file?: string
			title?: string
			content?: string
			ok: number
			err: number
	  }
	| { type: "discover"; urls: string[] }
	| { type: "complete"; ok: number; err: number; elapsed: number }
	| { type: "error"; message: string }

export type ProgressCallback = (event: PullEvent) => void

export function runPull(config: PullConfig, onProgress?: ProgressCallback): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const { url, out, max } = config
		const t0 = performance.now()
		let workerCount = config.workerCount ?? Math.max(8, cpus().length * 2)
		let pool: WorkerPool | null = null

		try {
			if (config.signal?.aborted) return yield* Effect.fail(new Error("Pull cancelled"))
			const urls = yield* discover(url, max)
			if (config.signal?.aborted) return yield* Effect.fail(new Error("Pull cancelled"))
			if (!urls.length) {
				onProgress?.({ type: "error", message: "No pages found." })
				return yield* Effect.fail(new Error("No pages found."))
			}

			onProgress?.({ type: "discover", urls })

			const sampleHtml = yield* Effect.tryPromise({
				try: () => fetch(url, { redirect: "follow" }).then((r) => r.text()),
				catch: () => new Error("Failed to detect SPA"),
			}).pipe(Effect.catchAll(() => Effect.succeed("")))
			const needsBrowser = isSPAShell(sampleHtml)
			if (needsBrowser) {
				workerCount = Math.min(workerCount, 4)
			}

			const activePool = new WorkerPool(workerCount)
			if (needsBrowser) activePool.useBrowser = true
			pool = activePool

			const total = urls.length
			onProgress?.({ type: "start", total, workerCount })

			let ok = 0
			let err = 0
			const writes: Promise<void>[] = []

			yield* Effect.tryPromise(() =>
				activePool.pullAll(
					urls,
					(_idx) => {},
					(result: WorkerResult, idx: number) => {
						if (result.ok) {
							ok++
							const finalUrl = result.url ?? urls[idx]!
							const title = result.title || new URL(finalUrl).pathname
							const content = result.content ?? ""
							const page: Page = {
								url: finalUrl,
								title,
								markdown: frontmatter(title, finalUrl) + content,
							}

							const parsedUrl = new URL(finalUrl)
							let filepath = parsedUrl.pathname
							if (parsedUrl.hash && parsedUrl.hash.length > 1) {
								filepath = parsedUrl.hash.replace(/^#\/?/, "/")
							}
							if (filepath.endsWith("/")) filepath += "index"
							filepath = filepath.replace(/\.html?$/, "").replace(/^\//, "")
							if (!filepath.endsWith(".md")) filepath += ".md"

							const writePromise = Effect.runPromise(write(page, out))
								.then(() => {
									onProgress?.({
										type: "progress",
										index: idx,
										url: finalUrl,
										status: "ok",
										file: filepath,
										title,
										content,
										ok,
										err,
									})
								})
								.catch(() => {
									ok--
									err++
									onProgress?.({
										type: "progress",
										index: idx,
										url: finalUrl,
										status: "err",
										ok,
										err,
									})
								})
							writes.push(writePromise)
						} else {
							err++
							onProgress?.({
								type: "progress",
								index: idx,
								url: urls[idx]!,
								status: "err",
								ok,
								err,
							})
						}
					},
					config.signal,
				),
			)
			yield* Effect.tryPromise(() => Promise.all(writes))

			const elapsed = (performance.now() - t0) / 1000
			onProgress?.({ type: "complete", ok, err, elapsed })
		} finally {
			pool?.terminate()
			yield* Effect.tryPromise({
				try: () => closeBrowser(),
				catch: () => new Error("Failed to close browser"),
			})
		}
	})
}
