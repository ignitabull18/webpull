CREATE TABLE IF NOT EXISTS pulls (
	id TEXT PRIMARY KEY,
	url TEXT NOT NULL,
	source TEXT NOT NULL DEFAULT '',
	source_id TEXT,
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
	content_hash TEXT NOT NULL DEFAULT '',
	change_status TEXT NOT NULL DEFAULT 'new',
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

CREATE TABLE IF NOT EXISTS workflow_runs (
	pull_id TEXT PRIMARY KEY REFERENCES pulls(id) ON DELETE CASCADE,
	executor TEXT NOT NULL DEFAULT 'queue',
	workflow_id TEXT,
	status TEXT NOT NULL DEFAULT 'queued',
	started_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	finished_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_steps (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	pull_id TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	status TEXT NOT NULL,
	detail TEXT NOT NULL DEFAULT '',
	started_at TEXT NOT NULL DEFAULT (datetime('now')),
	finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_pull_id ON workflow_steps(pull_id, id);

CREATE TABLE IF NOT EXISTS browser_run_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	pull_id TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	mode TEXT NOT NULL,
	status TEXT NOT NULL,
	session_id TEXT,
	live_view_url TEXT,
	recording_url TEXT,
	detail TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_browser_run_events_pull_id ON browser_run_events(pull_id, id);

CREATE TABLE IF NOT EXISTS ai_search_indexes (
	id TEXT PRIMARY KEY,
	pull_id TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
	namespace TEXT NOT NULL DEFAULT 'default',
	status TEXT NOT NULL DEFAULT 'pending',
	documents_indexed INTEGER NOT NULL DEFAULT 0,
	last_error TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_search_jobs (
	id TEXT PRIMARY KEY,
	pull_id TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
	mode TEXT NOT NULL DEFAULT 'hybrid',
	status TEXT NOT NULL DEFAULT 'queued',
	detail TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	finished_at TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_buckets (
	id TEXT PRIMARY KEY,
	owner_key TEXT NOT NULL,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_buckets_owner ON knowledge_buckets(owner_key, updated_at);

CREATE TABLE IF NOT EXISTS artifact_exports (
	id TEXT PRIMARY KEY,
	pull_id TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'queued',
	repo_url TEXT NOT NULL DEFAULT '',
	manifest_key TEXT NOT NULL DEFAULT '',
	last_error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifact_exports_pull_id ON artifact_exports(pull_id, created_at);

CREATE TABLE IF NOT EXISTS secret_bindings (
	name TEXT PRIMARY KEY,
	configured INTEGER NOT NULL DEFAULT 0,
	last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
	detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ai_gateway_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	feature TEXT NOT NULL,
	status TEXT NOT NULL,
	gateway_id TEXT NOT NULL DEFAULT '',
	request_id TEXT NOT NULL DEFAULT '',
	detail TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_sessions (
	id TEXT PRIMARY KEY,
	owner_key TEXT NOT NULL,
	pull_id TEXT REFERENCES pulls(id) ON DELETE SET NULL,
	title TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'active',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner ON agent_sessions(owner_key, updated_at);

CREATE TABLE IF NOT EXISTS agent_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	content TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, id);

CREATE TABLE IF NOT EXISTS saved_sources (
	id TEXT PRIMARY KEY,
	owner_key TEXT NOT NULL,
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
);

CREATE INDEX IF NOT EXISTS idx_saved_sources_owner ON saved_sources(owner_key, updated_at);
CREATE INDEX IF NOT EXISTS idx_saved_sources_due ON saved_sources(status, next_refresh_at);

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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_versions_pull_path ON document_versions(pull_id, path);
CREATE INDEX IF NOT EXISTS idx_document_versions_source_url ON document_versions(source_id, url, created_at);

CREATE TABLE IF NOT EXISTS export_jobs (
	id TEXT PRIMARY KEY,
	owner_key TEXT NOT NULL,
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
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_owner ON export_jobs(owner_key, created_at);
