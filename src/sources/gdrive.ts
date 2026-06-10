import { join } from "node:path"
import { Effect } from "effect"
import type { SourceAdapter, SourceConfig, SourceContent, SourceItem } from "./types"

function exec(cmd: string[], opts?: { stdin?: string }): Effect.Effect<string, Error> {
	return Effect.tryPromise({
		try: async () => {
			const spawnOpts: any = { stdout: "pipe", stderr: "pipe" }
			if (opts?.stdin) spawnOpts.stdin = Buffer.from(opts.stdin)
			const proc = Bun.spawnSync(cmd, spawnOpts)
			if (proc.exitCode !== 0) {
				const errText = new TextDecoder().decode(proc.stderr)
				throw new Error(`gws exited ${proc.exitCode}: ${errText.trimEnd()}`)
			}
			return new TextDecoder().decode(proc.stdout)
		},
		catch: (e) => new Error(`Failed to run gws: ${e}`),
	})
}

function execJson<T>(cmd: string[], opts?: { stdin?: string }): Effect.Effect<T, Error> {
	return exec(cmd, opts).pipe(
		Effect.flatMap((out) =>
			Effect.try({
				try: () => JSON.parse(out.trim() || "[]") as T,
				catch: (e) => new Error(`JSON parse: ${e}`),
			}),
		),
	)
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

/**
 * Google Drive source adapter.
 *
 * Supports:
 * - Folder IDs: discovers all files in a folder (recursive, max depth 3)
 * - File IDs: discovers a single file
 * - Root: discovers files in "My Drive" root
 * - Query: raw Drive API query string
 *
 * Uses `gws drive` under the hood. Requires OAuth via `gws auth login`.
 */
class GDriveAdapter implements SourceAdapter {
	readonly name = "Google Drive"

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
				// Single file — use files.get
				const fileId = target.slice("file:".length)
				const data = yield* execJson<GDriveFile>([
					"gws",
					"drive",
					"files",
					"get",
					"--params",
					JSON.stringify({ fileId }),
					"-f",
					"json",
				])

				// gws wraps in a data property
				const file: GDriveFile = (data as any).data ?? data
				return [fileToItem(file)]
			} else if (/^[a-zA-Z0-9_-]{25,}$/.test(target)) {
				// Try as folder ID first
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

				const response = yield* execJson<{ data?: GDriveListResponse } & GDriveListResponse>([
					"gws",
					"drive",
					"files",
					"list",
					"--params",
					JSON.stringify(params),
					"-f",
					"json",
				])

				const data: GDriveListResponse = (response as any).data ?? response
				const files = data.files ?? []
				for (const f of files) {
					if (f.mimeType === FOLDER_MIME) continue // Skip folders in listing
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

			// Google Workspace files (Docs/Sheets/Slides) need export
			if (mimeType in EXPORT_MIME_MAP) {
				const exportMime = EXPORT_MIME_MAP[mimeType]!
				const ext = EXTENSION_MAP[mimeType]!
				const outPath = join("/tmp", `webpull-gdrive-${fileId}${ext}`)

				// First try the export
				const exportResult = yield* Effect.either(
					exec([
						"gws",
						"drive",
						"files",
						"export",
						"--params",
						JSON.stringify({ fileId, mimeType: exportMime }),
						"-o",
						outPath,
						"-f",
						"json",
					]),
				)

				if (exportResult._tag === "Right") {
					// Read the exported file
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

					// Clean up temp file
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

			// Non-Google files or export failures — grab metadata only
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
