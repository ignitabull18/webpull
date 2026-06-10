import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DB_DIR = process.env.WEBPULL_DB_DIR || join(homedir(), ".webpull")
const DB_PATH = join(DB_DIR, "webpull.db")

let db: Database | null = null

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
	d.exec(`
		CREATE TABLE IF NOT EXISTS documents (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			pull_id TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
			path TEXT NOT NULL,
			url TEXT NOT NULL,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	d.exec(`
		CREATE INDEX IF NOT EXISTS idx_documents_pull_id ON documents(pull_id)
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
	outDir: string
	maxPages: number
	workerCount: number
}): void {
	const d = getDb()
	d.run(
		`INSERT INTO pulls (id, url, out_dir, max_pages, worker_count, status, pages_ok, pages_err, started_at)
		 VALUES (?, ?, ?, ?, ?, 'running', 0, 0, datetime('now'))`,
		[pull.id, pull.url, pull.outDir, pull.maxPages, pull.workerCount],
	)
}

export function updatePull(id: string, updates: { status?: string; pagesOk?: number; pagesErr?: number }): void {
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

	if (sets.length === 0) return
	vals.push(id)
	d.run(`UPDATE pulls SET ${sets.join(", ")} WHERE id = ?`, vals as any)
}

export function getPull(id: string): PullRow | null {
	const d = getDb()
	return d.query("SELECT * FROM pulls WHERE id = ?").get(id) as PullRow | null
}

export function listPulls(limit = 20): PullRow[] {
	const d = getDb()
	return d.query("SELECT * FROM pulls ORDER BY started_at DESC LIMIT ?").all(limit) as PullRow[]
}

export function deletePull(id: string): void {
	const d = getDb()
	d.run("DELETE FROM pulls WHERE id = ?", [id])
}

// --- Document CRUD ---

export interface DocRow {
	id: number
	pull_id: string
	path: string
	url: string
	title: string
	content: string
}

export function insertDocument(doc: {
	pullId: string
	path: string
	url: string
	title: string
	content: string
}): void {
	const d = getDb()
	d.run("INSERT INTO documents (pull_id, path, url, title, content) VALUES (?, ?, ?, ?, ?)", [
		doc.pullId,
		doc.path,
		doc.url,
		doc.title,
		doc.content,
	])
}

export function insertDocuments(
	docs: { pullId: string; path: string; url: string; title: string; content: string }[],
): void {
	const d = getDb()
	const insert = d.prepare("INSERT INTO documents (pull_id, path, url, title, content) VALUES (?, ?, ?, ?, ?)")
	d.transaction(() => {
		for (const doc of docs) {
			insert.run(doc.pullId, doc.path, doc.url, doc.title, doc.content)
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

// --- Search ---

export interface SearchResult extends DocRow {
	rank: number
	pull_url: string
}

export function searchDocs(query: string, limit = 50): SearchResult[] {
	const d = getDb()
	// Escape FTS5 special characters in the query
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
