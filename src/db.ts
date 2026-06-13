import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DB_DIR = process.env.WEBPULL_DB_DIR || join(homedir(), ".webpull")
const DB_PATH = join(DB_DIR, "webpull.db")

let db: Database | null = null

export type RefreshCadence = "manual" | "hourly" | "daily" | "weekly" | "monthly"
export type SourceStatus = "active" | "paused" | "archived"
export type DocumentChangeStatus = "new" | "unchanged" | "changed" | "removed"
export type StructuredExtractKind = "table" | "api" | "reference" | "entities" | "pricing" | "changelog" | "custom"
export type ExportJobStatus = "queued" | "running" | "complete" | "failed"

function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex")
}

function wordCount(content: string): number {
	return content
		.replace(/^---[\s\S]*?---/, "")
		.split(/\s+/)
		.filter(Boolean).length
}

function diagnosticSnapshot(title: string, content: string) {
	const words = wordCount(content)
	const titleFound = title.trim().length > 0
	const markdownQuality = Math.max(0.05, Math.min(0.99, (titleFound ? 0.25 : 0) + Math.min(0.6, words / 900)))
	const failedSelectors: string[] = []
	if (!titleFound) failedSelectors.push("title")
	if (words < 40) failedSelectors.push("main-content")
	return {
		extractionConfidence: Number(markdownQuality.toFixed(2)),
		wordCount: words,
		titleFound,
		markdownQuality: Number(markdownQuality.toFixed(2)),
		renderMode: "fetch",
		failedSelectors,
		notes: words < 40 ? "Low word count; review extraction quality." : "",
	}
}

function getDb(): Database {
	if (db) return db
	if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
	db = new Database(DB_PATH)
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("PRAGMA foreign_keys = ON")
	initSchema(db)
	return db
}

function initSchema(d: Database) {
	d.exec(`
		CREATE TABLE IF NOT EXISTS pulls (
			id TEXT PRIMARY KEY,
			url TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT '',
			source_id TEXT,
			dest TEXT NOT NULL DEFAULT '',
			project_id TEXT,
			out_dir TEXT NOT NULL,
			max_pages INTEGER NOT NULL DEFAULT 500,
			worker_count INTEGER NOT NULL DEFAULT 16,
			status TEXT NOT NULL DEFAULT 'running',
			pages_ok INTEGER NOT NULL DEFAULT 0,
			pages_err INTEGER NOT NULL DEFAULT 0,
			started_at TEXT NOT NULL,
			finished_at TEXT
		)
	`)
	// Add source column for existing databases that lack it
	try {
		d.exec("ALTER TABLE pulls ADD COLUMN source TEXT NOT NULL DEFAULT ''")
	} catch {
		// Column already exists — ignore
	}
	try {
		d.exec("ALTER TABLE pulls ADD COLUMN source_id TEXT REFERENCES saved_sources(id) ON DELETE SET NULL")
	} catch {
		// Column already exists — ignore
	}
	// Add dest column for existing databases that lack it
	try {
		d.exec("ALTER TABLE pulls ADD COLUMN dest TEXT NOT NULL DEFAULT ''")
	} catch {
		// Column already exists — ignore
	}
	// Add project_id column for existing databases that lack it
	try {
		d.exec("ALTER TABLE pulls ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL")
	} catch {
		// Column already exists — ignore
	}
	d.exec(`
		CREATE TABLE IF NOT EXISTS documents (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			pull_id TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
			path TEXT NOT NULL,
			url TEXT NOT NULL,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			content_hash TEXT NOT NULL DEFAULT '',
			change_status TEXT NOT NULL DEFAULT 'new',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	try {
		d.exec("ALTER TABLE documents ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''")
	} catch {
		// Column already exists — ignore
	}
	try {
		d.exec("ALTER TABLE documents ADD COLUMN change_status TEXT NOT NULL DEFAULT 'new'")
	} catch {
		// Column already exists — ignore
	}
	d.exec(`
		UPDATE documents
		SET content_hash = lower(hex(randomblob(16)))
		WHERE content_hash = ''
	`)
	d.exec(`
		CREATE INDEX IF NOT EXISTS idx_documents_pull_id ON documents(pull_id)
	`)
	d.exec(`
		DELETE FROM documents
		WHERE id NOT IN (
			SELECT MAX(id)
			FROM documents
			GROUP BY pull_id, path
		)
	`)
	d.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_pull_path ON documents(pull_id, path)
	`)
	d.exec(`
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			description TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	d.exec(`
		CREATE TABLE IF NOT EXISTS saved_sources (
			id TEXT PRIMARY KEY,
			project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
			name TEXT NOT NULL,
			url TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'website',
			target TEXT NOT NULL DEFAULT '',
			cadence TEXT NOT NULL DEFAULT 'manual',
			status TEXT NOT NULL DEFAULT 'active',
			config_json TEXT NOT NULL DEFAULT '{}',
			last_pull_id TEXT REFERENCES pulls(id) ON DELETE SET NULL,
			last_refreshed_at TEXT,
			next_refresh_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	d.exec(`
		CREATE INDEX IF NOT EXISTS idx_saved_sources_project_id ON saved_sources(project_id)
	`)
	d.exec(`
		CREATE INDEX IF NOT EXISTS idx_saved_sources_due ON saved_sources(status, next_refresh_at)
	`)
	d.exec(`
		CREATE TABLE IF NOT EXISTS document_versions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
			pull_id TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
			source_id TEXT REFERENCES saved_sources(id) ON DELETE SET NULL,
			path TEXT NOT NULL,
			url TEXT NOT NULL,
			title TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			content TEXT NOT NULL,
			change_status TEXT NOT NULL DEFAULT 'new',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	d.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_document_versions_pull_path ON document_versions(pull_id, path)
	`)
	d.exec(`
		CREATE INDEX IF NOT EXISTS idx_document_versions_source_url ON document_versions(source_id, url, created_at)
	`)
	d.exec(`
		CREATE TABLE IF NOT EXISTS document_diagnostics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
			version_id INTEGER REFERENCES document_versions(id) ON DELETE CASCADE,
			extraction_confidence REAL NOT NULL DEFAULT 0,
			word_count INTEGER NOT NULL DEFAULT 0,
			title_found INTEGER NOT NULL DEFAULT 0,
			markdown_quality REAL NOT NULL DEFAULT 0,
			render_mode TEXT NOT NULL DEFAULT 'fetch',
			failed_selectors_json TEXT NOT NULL DEFAULT '[]',
			screenshot_path TEXT,
			pdf_path TEXT,
			notes TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	d.exec(`
		CREATE INDEX IF NOT EXISTS idx_document_diagnostics_document_id ON document_diagnostics(document_id)
	`)
	d.exec(`
		CREATE TABLE IF NOT EXISTS structured_extracts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
			version_id INTEGER REFERENCES document_versions(id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			schema_json TEXT NOT NULL DEFAULT '{}',
			data_json TEXT NOT NULL DEFAULT '{}',
			format TEXT NOT NULL DEFAULT 'json',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	d.exec(`
		CREATE INDEX IF NOT EXISTS idx_structured_extracts_document_id ON structured_extracts(document_id)
	`)
	d.exec(`
		CREATE TABLE IF NOT EXISTS ask_sessions (
			id TEXT PRIMARY KEY,
			question TEXT NOT NULL,
			answer TEXT NOT NULL DEFAULT '',
			bucket_ids_json TEXT NOT NULL DEFAULT '[]',
			project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	d.exec(`
		CREATE TABLE IF NOT EXISTS ask_citations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES ask_sessions(id) ON DELETE CASCADE,
			document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
			version_id INTEGER REFERENCES document_versions(id) ON DELETE SET NULL,
			source_url TEXT NOT NULL,
			title TEXT NOT NULL,
			path TEXT NOT NULL,
			pull_id TEXT,
			bucket_id TEXT,
			snippet TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	d.exec(`
		CREATE INDEX IF NOT EXISTS idx_ask_citations_session_id ON ask_citations(session_id)
	`)
	d.exec(`
		CREATE TABLE IF NOT EXISTS export_jobs (
			id TEXT PRIMARY KEY,
			pull_id TEXT REFERENCES pulls(id) ON DELETE SET NULL,
			project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
			source_id TEXT REFERENCES saved_sources(id) ON DELETE SET NULL,
			destination TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'queued',
			format TEXT NOT NULL DEFAULT 'markdown',
			metadata_json TEXT NOT NULL DEFAULT '{}',
			output_url TEXT,
			error TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			finished_at TEXT
		)
	`)
	d.exec(`
		CREATE INDEX IF NOT EXISTS idx_export_jobs_pull_id ON export_jobs(pull_id)
	`)
	d.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
			title, content, content=documents, content_rowid=id
		)
	`)
	// Triggers to keep FTS in sync
	d.exec(`
		CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON documents BEGIN
			INSERT INTO documents_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
		END
	`)
	d.exec(`
		CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON documents BEGIN
			INSERT INTO documents_fts(documents_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
		END
	`)
	d.exec(`
		CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON documents BEGIN
			INSERT INTO documents_fts(documents_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
			INSERT INTO documents_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
		END
	`)
}

// --- Pull CRUD ---

export interface PullRow {
	id: string
	url: string
	source: string
	source_id: string | null
	dest: string
	project_id: string | null
	out_dir: string
	max_pages: number
	worker_count: number
	status: string
	pages_ok: number
	pages_err: number
	started_at: string
	finished_at: string | null
}

export function createPull(pull: {
	id: string
	url: string
	source?: string
	sourceId?: string
	dest?: string
	outDir: string
	maxPages: number
	workerCount: number
	projectId?: string
}): void {
	const d = getDb()
	d.run(
		`INSERT INTO pulls (id, url, source, source_id, dest, project_id, out_dir, max_pages, worker_count, status, pages_ok, pages_err, started_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, 0, datetime('now'))`,
		[
			pull.id,
			pull.url,
			pull.source || "",
			pull.sourceId || null,
			pull.dest || "",
			pull.projectId || null,
			pull.outDir,
			pull.maxPages,
			pull.workerCount,
		],
	)
}

export function updatePull(
	id: string,
	updates: { status?: string; pagesOk?: number; pagesErr?: number; dest?: string },
): void {
	const d = getDb()
	const sets: string[] = []
	const vals: (string | number)[] = []

	if (updates.status !== undefined) {
		sets.push("status = ?")
		vals.push(updates.status)
		if (updates.status === "complete" || updates.status === "failed") {
			sets.push("finished_at = datetime('now')")
		}
	}
	if (updates.pagesOk !== undefined) {
		sets.push("pages_ok = ?")
		vals.push(updates.pagesOk)
	}
	if (updates.pagesErr !== undefined) {
		sets.push("pages_err = ?")
		vals.push(updates.pagesErr)
	}
	if (updates.dest !== undefined) {
		sets.push("dest = ?")
		vals.push(updates.dest)
	}

	if (sets.length === 0) return
	vals.push(id)
	d.run(`UPDATE pulls SET ${sets.join(", ")} WHERE id = ?`, vals as any)
}

export function setPullProject(pullId: string, projectId: string | null): void {
	const d = getDb()
	d.run("UPDATE pulls SET project_id = ? WHERE id = ?", [projectId, pullId])
}

export function getPull(id: string): PullRow | null {
	const d = getDb()
	return d.query("SELECT * FROM pulls WHERE id = ?").get(id) as PullRow | null
}

export function listPulls(limit = 20): PullRow[] {
	const d = getDb()
	return d.query("SELECT * FROM pulls ORDER BY started_at DESC LIMIT ?").all(limit) as PullRow[]
}

export function listPullsByProject(projectId: string): PullRow[] {
	const d = getDb()
	return d.query("SELECT * FROM pulls WHERE project_id = ? ORDER BY started_at DESC").all(projectId) as PullRow[]
}

export function deletePull(id: string): void {
	const d = getDb()
	d.run("DELETE FROM pulls WHERE id = ?", [id])
}

// --- Saved sources / recurring refreshes ---

export interface SavedSourceRow {
	id: string
	project_id: string | null
	name: string
	url: string
	source: string
	target: string
	cadence: RefreshCadence
	status: SourceStatus
	config_json: string
	last_pull_id: string | null
	last_refreshed_at: string | null
	next_refresh_at: string | null
	created_at: string
	updated_at: string
}

function nextRefreshAt(cadence: RefreshCadence, from = new Date()): string | null {
	const next = new Date(from)
	if (cadence === "manual") return null
	if (cadence === "hourly") next.setHours(next.getHours() + 1)
	if (cadence === "daily") next.setDate(next.getDate() + 1)
	if (cadence === "weekly") next.setDate(next.getDate() + 7)
	if (cadence === "monthly") next.setMonth(next.getMonth() + 1)
	return next.toISOString()
}

export function createSavedSource(source: {
	name: string
	url: string
	source?: string
	target?: string
	projectId?: string | null
	cadence?: RefreshCadence
	status?: SourceStatus
	config?: Record<string, unknown>
}): SavedSourceRow {
	const d = getDb()
	const id = crypto.randomUUID()
	const cadence = source.cadence ?? "manual"
	const status = source.status ?? "active"
	const configJson = JSON.stringify(source.config ?? {})
	const nextRefresh = status === "active" ? nextRefreshAt(cadence) : null
	d.run(
		`INSERT INTO saved_sources (
			id, project_id, name, url, source, target, cadence, status, config_json, next_refresh_at
		)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			source.projectId ?? null,
			source.name,
			source.url,
			source.source ?? "website",
			source.target ?? source.url,
			cadence,
			status,
			configJson,
			nextRefresh,
		],
	)
	return getSavedSource(id)!
}

export function getSavedSource(id: string): SavedSourceRow | null {
	const d = getDb()
	return d.query("SELECT * FROM saved_sources WHERE id = ?").get(id) as SavedSourceRow | null
}

export function listSavedSources(projectId?: string): SavedSourceRow[] {
	const d = getDb()
	if (projectId) {
		return d
			.query("SELECT * FROM saved_sources WHERE project_id = ? ORDER BY updated_at DESC")
			.all(projectId) as SavedSourceRow[]
	}
	return d.query("SELECT * FROM saved_sources ORDER BY updated_at DESC").all() as SavedSourceRow[]
}

export function updateSavedSource(
	id: string,
	updates: {
		name?: string
		url?: string
		source?: string
		target?: string
		projectId?: string | null
		cadence?: RefreshCadence
		status?: SourceStatus
		config?: Record<string, unknown>
		nextRefreshAt?: string | null
	},
): void {
	const d = getDb()
	const current = getSavedSource(id)
	const sets: string[] = []
	const vals: (string | null)[] = []
	if (updates.name !== undefined) {
		sets.push("name = ?")
		vals.push(updates.name)
	}
	if (updates.url !== undefined) {
		sets.push("url = ?")
		vals.push(updates.url)
	}
	if (updates.source !== undefined) {
		sets.push("source = ?")
		vals.push(updates.source)
	}
	if (updates.target !== undefined) {
		sets.push("target = ?")
		vals.push(updates.target)
	}
	if (updates.projectId !== undefined) {
		sets.push("project_id = ?")
		vals.push(updates.projectId)
	}
	if (updates.cadence !== undefined) {
		sets.push("cadence = ?")
		vals.push(updates.cadence)
	}
	if (updates.status !== undefined) {
		sets.push("status = ?")
		vals.push(updates.status)
	}
	if (updates.config !== undefined) {
		sets.push("config_json = ?")
		vals.push(JSON.stringify(updates.config))
	}
	if (updates.nextRefreshAt !== undefined) {
		sets.push("next_refresh_at = ?")
		vals.push(updates.nextRefreshAt)
	} else if (updates.cadence !== undefined || updates.status !== undefined) {
		const cadence = updates.cadence ?? current?.cadence ?? "manual"
		const status = updates.status ?? current?.status ?? "active"
		sets.push("next_refresh_at = ?")
		vals.push(status === "active" ? nextRefreshAt(cadence) : null)
	}
	if (sets.length === 0) return
	sets.push("updated_at = datetime('now')")
	vals.push(id)
	d.run(`UPDATE saved_sources SET ${sets.join(", ")} WHERE id = ?`, vals as any)
}

export function deleteSavedSource(id: string): void {
	const d = getDb()
	d.run("UPDATE pulls SET source_id = NULL WHERE source_id = ?", [id])
	d.run("DELETE FROM saved_sources WHERE id = ?", [id])
}

export function listDueSavedSources(now = new Date()): SavedSourceRow[] {
	const d = getDb()
	return d
		.query(
			`SELECT *
			 FROM saved_sources
			 WHERE status = 'active'
				AND cadence != 'manual'
				AND next_refresh_at IS NOT NULL
				AND next_refresh_at <= ?
			 ORDER BY next_refresh_at ASC`,
		)
		.all(now.toISOString()) as SavedSourceRow[]
}

export function markSavedSourceRefreshed(sourceId: string, pullId: string, refreshedAt = new Date()): void {
	const d = getDb()
	const source = getSavedSource(sourceId)
	if (!source) return
	d.run(
		`UPDATE saved_sources
		 SET last_pull_id = ?,
			last_refreshed_at = ?,
			next_refresh_at = ?,
			updated_at = datetime('now')
		 WHERE id = ?`,
		[pullId, refreshedAt.toISOString(), nextRefreshAt(source.cadence, refreshedAt), sourceId],
	)
}

// --- Document CRUD ---

export interface DocRow {
	id: number
	pull_id: string
	path: string
	url: string
	title: string
	content: string
	content_hash?: string
	change_status?: DocumentChangeStatus
}

function getPullSourceId(pullId: string): string | null {
	const d = getDb()
	const row = d.query("SELECT source_id FROM pulls WHERE id = ?").get(pullId) as { source_id: string | null } | null
	return row?.source_id ?? null
}

function classifyDocumentChange(input: { pullId: string; sourceId: string | null; url: string; contentHash: string }) {
	if (!input.sourceId) return "new" satisfies DocumentChangeStatus
	const d = getDb()
	const previous = d
		.query(
			`SELECT content_hash
			 FROM document_versions
			 WHERE source_id = ? AND url = ? AND pull_id != ? AND change_status != 'removed'
			 ORDER BY created_at DESC, id DESC
			 LIMIT 1`,
		)
		.get(input.sourceId, input.url, input.pullId) as { content_hash: string } | null
	if (!previous) return "new" satisfies DocumentChangeStatus
	return previous.content_hash === input.contentHash
		? ("unchanged" satisfies DocumentChangeStatus)
		: ("changed" satisfies DocumentChangeStatus)
}

function upsertDocumentVersion(doc: {
	documentId: number
	pullId: string
	sourceId: string | null
	path: string
	url: string
	title: string
	content: string
	contentHash: string
	changeStatus: DocumentChangeStatus
}): number {
	const d = getDb()
	d.run(
		`INSERT INTO document_versions (
			document_id, pull_id, source_id, path, url, title, content_hash, content, change_status
		)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(pull_id, path) DO UPDATE SET
			document_id = excluded.document_id,
			source_id = excluded.source_id,
			url = excluded.url,
			title = excluded.title,
			content_hash = excluded.content_hash,
			content = excluded.content,
			change_status = excluded.change_status`,
		[
			doc.documentId,
			doc.pullId,
			doc.sourceId,
			doc.path,
			doc.url,
			doc.title,
			doc.contentHash,
			doc.content,
			doc.changeStatus,
		],
	)
	const row = d.query("SELECT id FROM document_versions WHERE pull_id = ? AND path = ?").get(doc.pullId, doc.path) as {
		id: number
	}
	return row.id
}

export function insertDocument(doc: {
	pullId: string
	path: string
	url: string
	title: string
	content: string
}): void {
	const d = getDb()
	const hash = contentHash(doc.content)
	const sourceId = getPullSourceId(doc.pullId)
	const changeStatus = classifyDocumentChange({
		pullId: doc.pullId,
		sourceId,
		url: doc.url,
		contentHash: hash,
	})
	d.run(
		`INSERT INTO documents (pull_id, path, url, title, content, content_hash, change_status)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(pull_id, path) DO UPDATE SET
			url = excluded.url,
			title = excluded.title,
			content = excluded.content,
			content_hash = excluded.content_hash,
			change_status = excluded.change_status`,
		[doc.pullId, doc.path, doc.url, doc.title, doc.content, hash, changeStatus],
	)
	const saved = getDoc(doc.pullId, doc.path)
	if (saved) {
		const versionId = upsertDocumentVersion({
			documentId: saved.id,
			pullId: doc.pullId,
			sourceId,
			path: doc.path,
			url: doc.url,
			title: doc.title,
			content: doc.content,
			contentHash: hash,
			changeStatus,
		})
		recordDocumentDiagnostics({ documentId: saved.id, versionId, ...diagnosticSnapshot(doc.title, doc.content) })
	}
}

export function insertDocuments(
	docs: { pullId: string; path: string; url: string; title: string; content: string }[],
): void {
	const d = getDb()
	const insert = d.prepare(
		`INSERT INTO documents (pull_id, path, url, title, content, content_hash, change_status)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(pull_id, path) DO UPDATE SET
			url = excluded.url,
			title = excluded.title,
			content = excluded.content,
			content_hash = excluded.content_hash,
			change_status = excluded.change_status`,
	)
	d.transaction(() => {
		for (const doc of docs) {
			const hash = contentHash(doc.content)
			const sourceId = getPullSourceId(doc.pullId)
			const changeStatus = classifyDocumentChange({
				pullId: doc.pullId,
				sourceId,
				url: doc.url,
				contentHash: hash,
			})
			insert.run(doc.pullId, doc.path, doc.url, doc.title, doc.content, hash, changeStatus)
			const saved = getDoc(doc.pullId, doc.path)
			if (saved) {
				const versionId = upsertDocumentVersion({
					documentId: saved.id,
					pullId: doc.pullId,
					sourceId,
					path: doc.path,
					url: doc.url,
					title: doc.title,
					content: doc.content,
					contentHash: hash,
					changeStatus,
				})
				recordDocumentDiagnostics({ documentId: saved.id, versionId, ...diagnosticSnapshot(doc.title, doc.content) })
			}
		}
	})()
}

export function listDocs(pullId: string): DocRow[] {
	const d = getDb()
	return d
		.query("SELECT id, pull_id, path, url, title, content FROM documents WHERE pull_id = ? ORDER BY path")
		.all(pullId) as DocRow[]
}

export function getDoc(pullId: string, docPath: string): DocRow | null {
	const d = getDb()
	return d
		.query("SELECT id, pull_id, path, url, title, content FROM documents WHERE pull_id = ? AND path = ?")
		.get(pullId, docPath) as DocRow | null
}

export function getDocById(id: number): DocRow | null {
	const d = getDb()
	return d.query("SELECT id, pull_id, path, url, title, content FROM documents WHERE id = ?").get(id) as DocRow | null
}

// --- Search ---

export interface SearchResult extends DocRow {
	rank: number
	pull_url: string
}

export function searchDocs(query: string, limit = 50): SearchResult[] {
	const d = getDb()
	const safe = query.replace(/['"*()]/g, "").trim()
	if (!safe) return []
	return d
		.query(
			`SELECT d.id, d.pull_id, d.path, d.url, d.title, d.content, p.url as pull_url, rank
			 FROM documents_fts f
			 JOIN documents d ON d.id = f.rowid
			 JOIN pulls p ON p.id = d.pull_id
			 WHERE documents_fts MATCH ?
			 ORDER BY rank
			 LIMIT ?`,
		)
		.all(safe, limit) as SearchResult[]
}

export function searchDocsInPull(pullId: string, query: string, limit = 50): SearchResult[] {
	const d = getDb()
	const safe = query.replace(/['"*()]/g, "").trim()
	if (!safe) return []
	return d
		.query(
			`SELECT d.id, d.pull_id, d.path, d.url, d.title, d.content, p.url as pull_url, rank
			 FROM documents_fts f
			 JOIN documents d ON d.id = f.rowid
			 JOIN pulls p ON p.id = d.pull_id
			 WHERE d.pull_id = ? AND documents_fts MATCH ?
			 ORDER BY rank
			 LIMIT ?`,
		)
		.all(pullId, safe, limit) as SearchResult[]
}

export function searchDocsInProject(projectId: string, query: string, limit = 50): SearchResult[] {
	const d = getDb()
	const safe = query.replace(/['"*()]/g, "").trim()
	if (!safe) return []
	return d
		.query(
			`SELECT d.id, d.pull_id, d.path, d.url, d.title, d.content, p.url as pull_url, rank
			 FROM documents_fts f
			 JOIN documents d ON d.id = f.rowid
			 JOIN pulls p ON p.id = d.pull_id
			 WHERE p.project_id = ? AND documents_fts MATCH ?
			 ORDER BY rank
			 LIMIT ?`,
		)
		.all(projectId, safe, limit) as SearchResult[]
}
// --- Project CRUD ---

export interface ProjectRow {
	id: string
	name: string
	description: string
	created_at: string
	updated_at: string
}

export function createProject(name: string, description = ""): ProjectRow {
	const d = getDb()
	const id = crypto.randomUUID()
	d.run("INSERT INTO projects (id, name, description) VALUES (?, ?, ?)", [id, name, description])
	return { id, name, description, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
}

export function listProjects(): ProjectRow[] {
	const d = getDb()
	return d.query("SELECT * FROM projects ORDER BY updated_at DESC").all() as ProjectRow[]
}

export function getProject(id: string): ProjectRow | null {
	const d = getDb()
	return d.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null
}

export function updateProject(id: string, updates: { name?: string; description?: string }): void {
	const d = getDb()
	const sets: string[] = []
	const vals: (string | number)[] = []
	if (updates.name !== undefined) {
		sets.push("name = ?")
		vals.push(updates.name)
	}
	if (updates.description !== undefined) {
		sets.push("description = ?")
		vals.push(updates.description)
	}
	if (sets.length === 0) return
	sets.push("updated_at = datetime('now')")
	vals.push(id)
	d.run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, vals as any)
}

export function deleteProject(id: string): void {
	const d = getDb()
	d.run("UPDATE pulls SET project_id = NULL WHERE project_id = ?", [id])
	d.run("DELETE FROM projects WHERE id = ?", [id])
}

export function getProjectDocCount(projectId: string): number {
	const d = getDb()
	const row = d
		.query("SELECT COUNT(*) as cnt FROM documents d JOIN pulls p ON p.id = d.pull_id WHERE p.project_id = ?")
		.get(projectId) as { cnt: number } | null
	return row?.cnt ?? 0
}

export function listDocsByProject(projectId: string): DocRow[] {
	const d = getDb()
	return d
		.query(
			`SELECT d.id, d.pull_id, d.path, d.url, d.title, d.content
			 FROM documents d
			 JOIN pulls p ON p.id = d.pull_id
			 WHERE p.project_id = ?
			 ORDER BY d.path`,
		)
		.all(projectId) as DocRow[]
}

// --- Document versions / change tracking ---

export interface DocumentVersionRow {
	id: number
	document_id: number | null
	pull_id: string
	source_id: string | null
	path: string
	url: string
	title: string
	content_hash: string
	content: string
	change_status: DocumentChangeStatus
	created_at: string
}

export function listDocumentVersions(sourceId: string, url?: string): DocumentVersionRow[] {
	const d = getDb()
	if (url) {
		return d
			.query(
				`SELECT *
				 FROM document_versions
				 WHERE source_id = ? AND url = ?
				 ORDER BY created_at DESC, id DESC`,
			)
			.all(sourceId, url) as DocumentVersionRow[]
	}
	return d
		.query(
			`SELECT *
			 FROM document_versions
			 WHERE source_id = ?
			 ORDER BY created_at DESC, id DESC`,
		)
		.all(sourceId) as DocumentVersionRow[]
}

export function listDocumentChanges(pullId: string): DocumentVersionRow[] {
	const d = getDb()
	return d
		.query(
			`SELECT *
			 FROM document_versions
			 WHERE pull_id = ?
			 ORDER BY
				CASE change_status
					WHEN 'changed' THEN 0
					WHEN 'new' THEN 1
					WHEN 'removed' THEN 2
					ELSE 3
				END,
				path`,
		)
		.all(pullId) as DocumentVersionRow[]
}

export function getPullChangeSummary(pullId: string): Record<DocumentChangeStatus, number> {
	const d = getDb()
	const rows = d
		.query(
			`SELECT change_status, COUNT(*) as count
			 FROM document_versions
			 WHERE pull_id = ?
			 GROUP BY change_status`,
		)
		.all(pullId) as { change_status: DocumentChangeStatus; count: number }[]
	const summary: Record<DocumentChangeStatus, number> = { new: 0, unchanged: 0, changed: 0, removed: 0 }
	for (const row of rows) summary[row.change_status] = row.count
	return summary
}

export function recordRemovedDocumentsForPull(pullId: string): number {
	const d = getDb()
	const pull = getPull(pullId)
	if (!pull?.source_id) return 0
	const currentUrls = new Set(
		(
			d.query("SELECT url FROM document_versions WHERE pull_id = ? AND change_status != 'removed'").all(pullId) as {
				url: string
			}[]
		).map((row) => row.url),
	)
	const previous = d
		.query(
			`SELECT *
			 FROM document_versions
			 WHERE id IN (
				SELECT MAX(id)
				FROM document_versions
				WHERE source_id = ?
					AND pull_id != ?
					AND change_status != 'removed'
				GROUP BY url
				)
			 ORDER BY url`,
		)
		.all(pull.source_id, pullId) as DocumentVersionRow[]
	let removed = 0
	const insert = d.prepare(
		`INSERT INTO document_versions (
			document_id, pull_id, source_id, path, url, title, content_hash, content, change_status
		)
		 VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'removed')
		 ON CONFLICT(pull_id, path) DO NOTHING`,
	)
	d.transaction(() => {
		for (const version of previous) {
			if (currentUrls.has(version.url)) continue
			insert.run(
				pullId,
				pull.source_id,
				version.path,
				version.url,
				version.title,
				version.content_hash,
				version.content,
			)
			removed++
		}
	})()
	return removed
}

// --- Quality diagnostics ---

export interface DocumentDiagnosticRow {
	id: number
	document_id: number
	version_id: number | null
	extraction_confidence: number
	word_count: number
	title_found: number
	markdown_quality: number
	render_mode: string
	failed_selectors_json: string
	screenshot_path: string | null
	pdf_path: string | null
	notes: string
	created_at: string
}

export function recordDocumentDiagnostics(input: {
	documentId: number
	versionId?: number | null
	extractionConfidence?: number
	wordCount?: number
	titleFound?: boolean
	markdownQuality?: number
	renderMode?: string
	failedSelectors?: string[]
	screenshotPath?: string | null
	pdfPath?: string | null
	notes?: string
}): DocumentDiagnosticRow {
	const d = getDb()
	d.run(
		`INSERT INTO document_diagnostics (
			document_id, version_id, extraction_confidence, word_count, title_found, markdown_quality,
			render_mode, failed_selectors_json, screenshot_path, pdf_path, notes
		)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			input.documentId,
			input.versionId ?? null,
			input.extractionConfidence ?? 0,
			input.wordCount ?? 0,
			input.titleFound ? 1 : 0,
			input.markdownQuality ?? 0,
			input.renderMode ?? "fetch",
			JSON.stringify(input.failedSelectors ?? []),
			input.screenshotPath ?? null,
			input.pdfPath ?? null,
			input.notes ?? "",
		],
	)
	return d.query("SELECT * FROM document_diagnostics WHERE id = last_insert_rowid()").get() as DocumentDiagnosticRow
}

export function listDocumentDiagnostics(documentId: number): DocumentDiagnosticRow[] {
	const d = getDb()
	return d
		.query("SELECT * FROM document_diagnostics WHERE document_id = ? ORDER BY created_at DESC, id DESC")
		.all(documentId) as DocumentDiagnosticRow[]
}

// --- Structured extraction ---

export interface StructuredExtractRow {
	id: number
	document_id: number
	version_id: number | null
	kind: StructuredExtractKind
	schema_json: string
	data_json: string
	format: string
	created_at: string
}

export function createStructuredExtract(input: {
	documentId: number
	versionId?: number | null
	kind: StructuredExtractKind
	schema?: Record<string, unknown>
	data: unknown
	format?: string
}): StructuredExtractRow {
	const d = getDb()
	d.run(
		`INSERT INTO structured_extracts (document_id, version_id, kind, schema_json, data_json, format)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			input.documentId,
			input.versionId ?? null,
			input.kind,
			JSON.stringify(input.schema ?? {}),
			JSON.stringify(input.data),
			input.format ?? "json",
		],
	)
	return d.query("SELECT * FROM structured_extracts WHERE id = last_insert_rowid()").get() as StructuredExtractRow
}

export function listStructuredExtracts(documentId: number, kind?: StructuredExtractKind): StructuredExtractRow[] {
	const d = getDb()
	if (kind) {
		return d
			.query("SELECT * FROM structured_extracts WHERE document_id = ? AND kind = ? ORDER BY created_at DESC, id DESC")
			.all(documentId, kind) as StructuredExtractRow[]
	}
	return d
		.query("SELECT * FROM structured_extracts WHERE document_id = ? ORDER BY created_at DESC, id DESC")
		.all(documentId) as StructuredExtractRow[]
}

// --- Ask citations / lineage ---

export interface AskSessionRow {
	id: string
	question: string
	answer: string
	bucket_ids_json: string
	project_id: string | null
	created_at: string
}

export interface AskCitationRow {
	id: number
	session_id: string
	document_id: number | null
	version_id: number | null
	source_url: string
	title: string
	path: string
	pull_id: string | null
	bucket_id: string | null
	snippet: string
	created_at: string
}

export function createAskSession(input: {
	question: string
	answer?: string
	bucketIds?: string[]
	projectId?: string | null
}): AskSessionRow {
	const d = getDb()
	const id = crypto.randomUUID()
	d.run(
		`INSERT INTO ask_sessions (id, question, answer, bucket_ids_json, project_id)
		 VALUES (?, ?, ?, ?, ?)`,
		[id, input.question, input.answer ?? "", JSON.stringify(input.bucketIds ?? []), input.projectId ?? null],
	)
	return d.query("SELECT * FROM ask_sessions WHERE id = ?").get(id) as AskSessionRow
}

export function addAskCitation(input: {
	sessionId: string
	documentId?: number | null
	versionId?: number | null
	sourceUrl: string
	title: string
	path: string
	pullId?: string | null
	bucketId?: string | null
	snippet?: string
}): AskCitationRow {
	const d = getDb()
	d.run(
		`INSERT INTO ask_citations (
			session_id, document_id, version_id, source_url, title, path, pull_id, bucket_id, snippet
		)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			input.sessionId,
			input.documentId ?? null,
			input.versionId ?? null,
			input.sourceUrl,
			input.title,
			input.path,
			input.pullId ?? null,
			input.bucketId ?? null,
			input.snippet ?? "",
		],
	)
	return d.query("SELECT * FROM ask_citations WHERE id = last_insert_rowid()").get() as AskCitationRow
}

export function listAskCitations(sessionId: string): AskCitationRow[] {
	const d = getDb()
	return d.query("SELECT * FROM ask_citations WHERE session_id = ? ORDER BY id ASC").all(sessionId) as AskCitationRow[]
}

// --- Export jobs ---

export interface ExportJobRow {
	id: string
	pull_id: string | null
	project_id: string | null
	source_id: string | null
	destination: string
	status: ExportJobStatus
	format: string
	metadata_json: string
	output_url: string | null
	error: string | null
	created_at: string
	updated_at: string
	finished_at: string | null
}

export function createExportJob(input: {
	pullId?: string | null
	projectId?: string | null
	sourceId?: string | null
	destination: string
	format?: string
	metadata?: Record<string, unknown>
}): ExportJobRow {
	const d = getDb()
	const id = crypto.randomUUID()
	d.run(
		`INSERT INTO export_jobs (id, pull_id, project_id, source_id, destination, format, metadata_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			input.pullId ?? null,
			input.projectId ?? null,
			input.sourceId ?? null,
			input.destination,
			input.format ?? "markdown",
			JSON.stringify(input.metadata ?? {}),
		],
	)
	return getExportJob(id)!
}

export function getExportJob(id: string): ExportJobRow | null {
	const d = getDb()
	return d.query("SELECT * FROM export_jobs WHERE id = ?").get(id) as ExportJobRow | null
}

export function updateExportJob(
	id: string,
	updates: {
		status?: ExportJobStatus
		outputUrl?: string | null
		error?: string | null
		metadata?: Record<string, unknown>
	},
): void {
	const d = getDb()
	const sets: string[] = []
	const vals: (string | null)[] = []
	if (updates.status !== undefined) {
		sets.push("status = ?")
		vals.push(updates.status)
		if (updates.status === "complete" || updates.status === "failed") sets.push("finished_at = datetime('now')")
	}
	if (updates.outputUrl !== undefined) {
		sets.push("output_url = ?")
		vals.push(updates.outputUrl)
	}
	if (updates.error !== undefined) {
		sets.push("error = ?")
		vals.push(updates.error)
	}
	if (updates.metadata !== undefined) {
		sets.push("metadata_json = ?")
		vals.push(JSON.stringify(updates.metadata))
	}
	if (sets.length === 0) return
	sets.push("updated_at = datetime('now')")
	vals.push(id)
	d.run(`UPDATE export_jobs SET ${sets.join(", ")} WHERE id = ?`, vals as any)
}

export function listExportJobs(
	filters: { pullId?: string; projectId?: string; sourceId?: string } = {},
): ExportJobRow[] {
	const d = getDb()
	if (filters.pullId) {
		return d
			.query("SELECT * FROM export_jobs WHERE pull_id = ? ORDER BY created_at DESC")
			.all(filters.pullId) as ExportJobRow[]
	}
	if (filters.projectId) {
		return d
			.query("SELECT * FROM export_jobs WHERE project_id = ? ORDER BY created_at DESC")
			.all(filters.projectId) as ExportJobRow[]
	}
	if (filters.sourceId) {
		return d
			.query("SELECT * FROM export_jobs WHERE source_id = ? ORDER BY created_at DESC")
			.all(filters.sourceId) as ExportJobRow[]
	}
	return d.query("SELECT * FROM export_jobs ORDER BY created_at DESC").all() as ExportJobRow[]
}
