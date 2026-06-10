import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { Effect } from "effect"

interface MarkdownFile {
	path: string
	size: number
}

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

/** Walk a directory and collect all .md files with their sizes. */
function collectMarkdownFiles(dir: string): MarkdownFile[] {
	if (!existsSync(dir)) return []
	const results: MarkdownFile[] = []

	function walk(current: string) {
		const entries = readdirSync(current, { withFileTypes: true })
		for (const entry of entries) {
			const full = join(current, entry.name)
			if (entry.isDirectory()) {
				walk(full)
			} else if (entry.isFile() && extname(entry.name) === ".md") {
				results.push({ path: full, size: statSync(full).size })
			}
		}
	}

	walk(dir)
	return results.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Merge all pulled .md files into a single markdown file.
 * Returns the path to the merged output.
 */
export function mergeIntoFile(dirPath: string, outFile?: string): Effect.Effect<string, Error> {
	return Effect.gen(function* () {
		const normalized = dirPath.replace(/\/$/, "")
		const files = collectMarkdownFiles(normalized)

		if (!files.length) {
			return yield* Effect.fail(new Error(`No markdown files found in: ${normalized}`))
		}

		const target = outFile ?? join(normalized, "_merged.md")

		let content = `# Merged Docs: ${basename(normalized)}\n\n`
		content += `_Generated from ${files.length} pages_\n\n---\n\n`

		for (let i = 0; i < files.length; i++) {
			const raw = yield* Effect.tryPromise({
				try: () => Bun.file(files[i]!.path).text(),
				catch: () => new Error(`Failed to read: ${files[i]!.path}`),
			})
			content += raw
			if (i < files.length - 1) {
				content += "\n\n---\n\n"
			}
		}

		yield* Effect.tryPromise({
			try: () => Bun.write(target, content),
			catch: () => new Error(`Failed to write merged file: ${target}`),
		})

		return target
	})
}

/**
 * Split all pulled .md files evenly across N output files.
 * Returns the list of output file paths.
 */
export function splitIntoFiles(dirPath: string, count: number): Effect.Effect<string[], Error> {
	return Effect.gen(function* () {
		if (count < 1) return yield* Effect.fail(new Error("Split count must be >= 1"))

		const normalized = dirPath.replace(/\/$/, "")
		const files = collectMarkdownFiles(normalized)

		if (!files.length) {
			return yield* Effect.fail(new Error(`No markdown files found in: ${normalized}`))
		}

		// Distribute files to balance total size per chunk
		const chunks: MarkdownFile[][] = Array.from({ length: count }, () => [])
		const chunkSizes = new Array<number>(count).fill(0)

		for (const file of files) {
			let minIdx = 0
			for (let i = 1; i < count; i++) {
				if (chunkSizes[i]! < chunkSizes[minIdx]!) minIdx = i
			}
			chunks[minIdx]?.push(file)
			chunkSizes[minIdx] = (chunkSizes[minIdx] ?? 0) + file.size
		}

		const outPaths: string[] = []
		for (let c = 0; c < count; c++) {
			const outPath = join(normalized, `_split-${String(c + 1).padStart(2, "0")}.md`)
			const chunkContent = yield* mergeIntoFile(normalized, outPath)
			outPaths.push(chunkContent)
		}

		return outPaths
	})
}
