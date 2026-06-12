CREATE TABLE IF NOT EXISTS pulls (
	id TEXT PRIMARY KEY,
	url TEXT NOT NULL,
	source TEXT NOT NULL DEFAULT '',
	dest TEXT NOT NULL DEFAULT '',
	project_id TEXT,
	out_dir TEXT NOT NULL DEFAULT '',
	max_pages INTEGER NOT NULL DEFAULT 50,
	worker_count INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'running',
	pages_ok INTEGER NOT NULL DEFAULT 0,
	pages_err INTEGER NOT NULL DEFAULT 0,
	started_at TEXT NOT NULL DEFAULT (datetime('now')),
	finished_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	pull_id TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
	path TEXT NOT NULL,
	url TEXT NOT NULL,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_pull_id ON documents(pull_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_pull_path ON documents(pull_id, path);

CREATE TABLE IF NOT EXISTS page_failures (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	pull_id TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	reason TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_page_failures_pull_id ON page_failures(pull_id);

CREATE TABLE IF NOT EXISTS rate_limits (
	key TEXT PRIMARY KEY,
	window_start INTEGER NOT NULL,
	count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pull_owners (
	pull_id TEXT PRIMARY KEY REFERENCES pulls(id) ON DELETE CASCADE,
	owner_key TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pull_owners_owner_key ON pull_owners(owner_key);

CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	description TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
