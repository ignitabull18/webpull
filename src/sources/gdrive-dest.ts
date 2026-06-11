import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { withRetry } from "./retry"
import type { DestinationAdapter, DestinationConfig, DestinationFile, DestinationResult, SourceStatus } from "./types"

const EXEC_TIMEOUT = 30_000

async function execAsync(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
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

function execJson<T>(cmd: string[]): Effect.Effect<T, Error> {
	return Effect.tryPromise({
		try: async () => {
			const out = await execAsync(cmd)
			return JSON.parse(out.trim() || "{}") as T
		},
		catch: (e) => new Error(`Failed to run gws: ${e}`),
	})
}

class GDriveDestinationAdapter implements DestinationAdapter {
	readonly name = "Google Drive"

	checkStatus(): Effect.Effect<SourceStatus, Error> {
		return Effect.gen(this, function* () {
			const which = Bun.spawnSync(["which", "gws"], { stdout: "pipe", stderr: "pipe" })
			const installed = which.exitCode === 0
			if (!installed) {
				return { installed: false, authenticated: false, message: "gws not installed. Run: npm i -g @ignitabull/gws" }
			}

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

	write(config: DestinationConfig, files: DestinationFile[]): Effect.Effect<DestinationResult, Error> {
		return Effect.gen(this, function* () {
			const target = config.target.trim()
			let folderId = "root"

			if (target === "root" || target === "my-drive" || target === "") {
				folderId = "root"
			} else if (target.startsWith("folder:")) {
				folderId = target.slice("folder:".length)
			} else if (/^[a-zA-Z0-9_-]{25,}$/.test(target)) {
				folderId = target
			} else {
				return yield* Effect.fail(
					new Error(`Invalid Drive destination: ${target}. Use: root, folder:<id>, or a raw folder ID.`),
				)
			}

			const results: DestinationResult = { ok: 0, err: 0, files: [] }

			for (const file of files) {
				const fileResult = yield* Effect.either(
					Effect.gen(this, function* () {
						const mimeType = file.mimeType || (file.path.endsWith(".md") ? "text/markdown" : "text/plain")
						const safeName = file.path.replace(/\//g, "_")
						const tmpDir = join(resolve(import.meta.dir, ".."), ".tmp-push")
						try {
							mkdirSync(tmpDir, { recursive: true })
						} catch {}
						const tmpPath = join(tmpDir, safeName)

						yield* Effect.tryPromise({
							try: () => Bun.write(tmpPath, file.content),
							catch: (e) => new Error(`Write temp failed: ${e}`),
						})

						const params = JSON.stringify({
							name: safeName,
							parents: [folderId],
							mimeType,
						})

						const cmd: string[] = [
							"gws",
							"drive",
							"files",
							"create",
							"--params",
							params,
							"--upload",
							tmpPath,
							"--format",
							"json",
						]
						if (mimeType) {
							cmd.push("--upload-content-type", mimeType)
						}

						return yield* withRetry(execJson<{ id?: string }>(cmd), "gdrive:dest:write")
					}),
				)

				if (fileResult._tag === "Right" && (fileResult.right as any).id) {
					results.ok++
					results.files.push({ path: file.path, status: "ok" })
				} else {
					const errMsg = fileResult._tag === "Left" ? String(fileResult.left) : "Upload returned no file ID"
					results.err++
					results.files.push({ path: file.path, status: "err", error: errMsg })
				}
			}

			return results
		})
	}
}

export const gdriveDestination: DestinationAdapter = new GDriveDestinationAdapter()
