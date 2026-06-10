import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import { Effect } from "effect"

/**
 * Compress a directory into a zip archive.
 * Returns the path to the created archive.
 */
export function compressDir(dirPath: string): Effect.Effect<string, Error> {
	return Effect.gen(function* () {
		const normalized = dirPath.replace(/\/$/, "")
		const name = basename(normalized)
		const parent = join(normalized, "..")
		const outFile = `${normalized}.zip`

		if (!existsSync(normalized)) {
			return yield* Effect.fail(new Error(`Directory not found: ${normalized}`))
		}

		// Remove existing archive if present
		if (existsSync(outFile)) {
			yield* Effect.tryPromise({
				try: () => Bun.file(outFile).delete(),
				catch: () => new Error(`Failed to remove existing archive: ${outFile}`),
			})
		}

		const proc = Bun.spawnSync(["zip", "-rq", outFile, name], {
			cwd: parent,
			env: process.env,
		})

		if (proc.exitCode !== 0) {
			const errText = new TextDecoder().decode(proc.stderr)
			return yield* Effect.fail(new Error(`zip failed: ${errText}`))
		}

		return outFile
	})
}
