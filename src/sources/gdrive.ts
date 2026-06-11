import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { withRetry } from "./retry"
import type { SourceAdapter, SourceConfig, SourceContent, SourceItem, SourceStatus } from "./types"

const EXEC_TIMEOUT = 30_000

async function execAsync(cmd: string[], opts?: { stdin?: string }): Promise<string> {
	const spawnOpts: any = { stdout: "pipe", stderr: "pipe" }
	if (opts?.stdin) spawnOpts.stdin = Buffer.from(opts.stdin)
	const proc = Bun.spawn(cmd, spawnOpts)
	const timeout = setTimeout(() => proc.kill(), EXEC_TIMEOUT)
	try {
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
		const exitCode = await proc.exited
		if (exitCode !== 0) {
			const reason = proc.killed ? "timed out" : `exited ${exitCode}`
			throw new Error(`gws ${reason}: ${stderr.trimEnd()}`)
		}
		return stdout
	} finally {
		clearTimeout(timeout)
	}
}

function execJson<T>(cmd: string[], opts?: { stdin?: string }): Effect.Effect<T, Error> {
	return Effect.tryPromise({
		try: async () => {
			const out = await execAsync(cmd, opts)
			return JSON.parse(out.trim() || "[]") as T
		},
		catch: (e) => new Error(`Failed to run gws: ${e}`),
	})
}

interface GDriveFile {
	id: string
	name: string
	mimeType: string
	webViewLink?: string
	size?: string
	createdTime?: string
	modifiedTime?: string
	parents?: string[]
}

interface GDriveListResponse {
	files?: GDriveFile[]
	nextPageToken?: string
}

const DOC_MIME = "application/vnd.google-apps.document"
const SHEET_MIME = "application/vnd.google-apps.spreadsheet"
const SLIDES_MIME = "application/vnd.google-apps.presentation"
const FOLDER_MIME = "application/vnd.google-apps.folder"

const EXPORT_MIME_MAP: Record<string, string> = {
	[DOC_MIME]: "text/markdown",
	[SHEET_MIME]: "text/csv",
	[SLIDES_MIME]: "text/plain",
}

const EXTENSION_MAP: Record<string, string> = {
	[DOC_MIME]: ".md",
	[SHEET_MIME]: ".csv",
	[SLIDES_MIME]: ".txt",
}

class GDriveAdapter implements SourceAdapter {
	readonly name = "Google Drive"

	checkStatus(): Effect.Effect<SourceStatus, Error> {
		return Effect.gen(this, function* () {
			const which = Bun.spawnSync(["which", "gws"], { stdout: "pipe", stderr: "pipe" })
			const installed = which.exitCode === 0
			if (!installed) {
				return { installed: false, authenticated: false, message: "gws not installed. Run: npm i -g @ignitabull/gws" }
			}

			// Use async exec for the actual check
			const checkResult = yield* Effect.either(
				execJson<unknown>([
					"gws",
					"drive",
					"files",
					"list",
					"--params",
					JSON.stringify({ pageSize: 1 }),
					"--format",
					"json",
				]),
			)

			if (checkResult._tag === "Right") {
				return { installed: true, authenticated: true, message: "Ready — Drive OAuth configured" }
			}

			const errMsg = String(checkResult.left).toLowerCase()
			if (errMsg.includes("auth") || errMsg.includes("login") || errMsg.includes("401") || errMsg.includes("403")) {
				return { installed: true, authenticated: false, message: "Not authenticated — run: gws auth login" }
			}
			return { installed: true, authenticated: false, message: "Drive API may not be accessible" }
		})
	}

	discover(config: SourceConfig): Effect.Effect<SourceItem[], Error> {
		return Effect.gen(this, function* () {
			const target = config.target.trim()
			const max = config.max

			let query = ""
			if (target === "root" || target === "" || target === "my-drive") {
				query = `'root' in parents and trashed = false`
			} else if (target.startsWith("folder:")) {
				const folderId = target.slice("folder:".length)
				query = `'${folderId}' in parents and trashed = false`
			} else if (target.startsWith("query:")) {
				query = target.slice("query:".length)
			} else if (target.startsWith("file:")) {
				const fileId = target.slice("file:".length)
				const data = yield* withRetry(
					execJson<GDriveFile>([
						"gws",
						"drive",
						"files",
						"get",
						"--params",
						JSON.stringify({ fileId }),
						"--format",
						"json",
					]),
					"gdrive:discover:single",
				)
				const file: GDriveFile = (data as any).data ?? data
				return [fileToItem(file)]
			} else if (/^[a-zA-Z0-9_-]{25,}$/.test(target)) {
				query = `'${target}' in parents and trashed = false`
			} else {
				return yield* Effect.fail(
					new Error(
						"Unrecognized Google Drive target. Use: root, folder:<id>, file:<id>, query:<q>, or a raw folder ID.",
					),
				)
			}

			const items: SourceItem[] = []
			let pageToken: string | undefined
			let pages = 0
			const maxPages = Math.ceil(max / 50)

			do {
				pages++
				const params: Record<string, unknown> = {
					q: query,
					pageSize: Math.min(50, max - items.length),
					fields: "nextPageToken,files(id,name,mimeType,webViewLink,size,createdTime,modifiedTime,parents)",
				}
				if (pageToken) params.pageToken = pageToken

				const response = yield* withRetry(
					execJson<{ data?: GDriveListResponse } & GDriveListResponse>([
						"gws",
						"drive",
						"files",
						"list",
						"--params",
						JSON.stringify(params),
						"--format",
						"json",
					]),
					"gdrive:discover:list",
				)

				const data: GDriveListResponse = (response as any).data ?? response
				const files = data.files ?? []
				for (const f of files) {
					if (f.mimeType === FOLDER_MIME) continue
					items.push(fileToItem(f))
				}
				pageToken = data.nextPageToken
			} while (pageToken && items.length < max && pages < maxPages)

			if (items.length === 0) {
				return yield* Effect.fail(new Error("No files found. Check your query and that gws auth is configured."))
			}

			return items.slice(0, max)
		})
	}

	fetch(item: SourceItem): Effect.Effect<SourceContent, Error> {
		return Effect.gen(this, function* () {
			const fileId = item.id
			const mimeType = String(item.meta?.mimeType ?? "")
			const fileName = item.title

			if (mimeType in EXPORT_MIME_MAP) {
				const exportMime = EXPORT_MIME_MAP[mimeType]!
				const ext = EXTENSION_MAP[mimeType]!
				const outDir = join(resolve(import.meta.dir, ".."), ".tmp-gdrive")
				try {
					mkdirSync(outDir, { recursive: true })
				} catch {}
				const outPath = join(outDir, `webpull-gdrive-${fileId}${ext}`)

				const exportResult = yield* Effect.either(
					withRetry(
						execJson<unknown>([
							"gws",
							"drive",
							"files",
							"export",
							"--params",
							JSON.stringify({ fileId, mimeType: exportMime }),
							"-o",
							outPath,
							"--format",
							"json",
						]),
						"gdrive:fetch:export",
					),
				)

				if (exportResult._tag === "Right") {
					const contentResult = yield* Effect.either(
						Effect.tryPromise({
							try: async () => {
								const file = Bun.file(outPath)
								if (!file.size) return ""
								return await file.text()
							},
							catch: (e) => new Error(`Read failed: ${e}`),
						}),
					)

					try {
						Bun.spawnSync(["rm", "-f", outPath])
					} catch {}

					if (contentResult._tag === "Right" && contentResult.right) {
						const markdown =
							`---\ntitle: "${fileName.replace(/"/g, '\\"')}"\nurl: "${item.url}"\nfile_id: "${fileId}"\nmime_type: "${mimeType}"\n---\n\n` +
							`# ${fileName}\n\n${contentResult.right}`

						return { item, content: markdown, mimeType: exportMime }
					}
				}
			}

			const markdown =
				`---\ntitle: "${fileName.replace(/"/g, '\\"')}"\nurl: "${item.url}"\nfile_id: "${fileId}"\nmime_type: "${mimeType}"\n---\n\n` +
				`# ${fileName}\n\n_Drive file: ${mimeType}_`

			return { item, content: markdown, mimeType: "text/markdown" }
		})
	}
}

function fileToItem(f: GDriveFile): SourceItem {
	return {
		id: f.id,
		title: f.name,
		url: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
		meta: {
			mimeType: f.mimeType,
			size: f.size,
			createdTime: f.createdTime,
			modifiedTime: f.modifiedTime,
			parents: f.parents,
		},
	}
}

export const gdriveAdapter: SourceAdapter = new GDriveAdapter()
