import type { Effect } from "effect"

/** A single discoverable item from a source (video, tweet, file, etc.) */
export interface SourceItem {
	/** Unique identifier within the source (video ID, tweet ID, file ID) */
	id: string
	/** Display title */
	title: string
	/** URL to the original item */
	url: string
	/** Optional metadata blob (channel, author, dates, etc.) */
	meta?: Record<string, unknown>
}

/** The result of fetching a single item's content */
export interface SourceContent {
	/** The item that was fetched */
	item: SourceItem
	/** The extracted text content (markdown or plain text) */
	content: string
	/** MIME type of the content */
	mimeType?: string
}

/** Configuration passed to a source adapter */
export interface SourceConfig {
	/** The target specifier (playlist URL, bookmark folder ID, Drive folder ID, etc.) */
	target: string
	/** Maximum items to fetch */
	max: number
	/** Output directory */
	outDir: string
}

/** Progress callback during a source pull */
export type SourceProgress = (event: SourcePullEvent) => void

export type SourcePullEvent =
	| { type: "discover"; items: SourceItem[] }
	| { type: "progress"; index: number; item: SourceItem; status: "ok" | "err"; file?: string }
	| { type: "complete"; ok: number; err: number; elapsed: number }
	| { type: "error"; message: string }

/**
 * A source adapter discovers and fetches content from a specific platform.
 * Each adapter wraps the relevant opencli/gws subcommands.
 */
export interface SourceAdapter {
	/** Human-readable name for logging and UI */
	readonly name: string

	/** Discover items from the target (e.g. playlist videos, bookmark tweets, Drive files) */
	discover(config: SourceConfig): Effect.Effect<SourceItem[], Error>

	/** Fetch the content for a single item */
	fetch(item: SourceItem): Effect.Effect<SourceContent, Error>
}
