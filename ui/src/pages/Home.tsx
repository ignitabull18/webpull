import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"

// --- Types ---

interface PullSummary {
	id: string
	url: string
	source: string
	out_dir: string
	max_pages: number
	worker_count: number
	status: string
	pages_ok: number
	pages_err: number
	started_at: string
	finished_at: string | null
}

interface SourceStatus {
	installed: boolean
	authenticated: boolean
	message: string
}

interface PreviewItem {
	id: string
	title: string
	url: string
	meta?: Record<string, unknown>
}

interface HealthInfo {
	runtime?: string
	limits?: {
		maxPages?: number
	}
}

type SourceKind = "" | "youtube" | "twitter" | "gdrive"

interface SourceDef {
	key: SourceKind
	label: string
	icon: string
	placeholder: string
	examples: { label: string; value: string }[]
}

const SOURCES: SourceDef[] = [
	{
		key: "",
		label: "Website",
		icon: "🌐",
		placeholder: "Paste a docs URL…",
		examples: [],
	},
	{
		key: "youtube",
		label: "YouTube",
		icon: "▶",
		placeholder: "Playlist URL, channel @handle, or video URL…",
		examples: [
			{ label: "Playlist URL", value: "https://youtube.com/playlist?list=PL…" },
			{ label: "Channel @handle", value: "@veritasium" },
		],
	},
	{
		key: "twitter",
		label: "Twitter",
		icon: "𝕏",
		placeholder: "all-bookmarks, folder:<id>, @username, search:<q>…",
		examples: [
			{ label: "All bookmarks", value: "all-bookmarks" },
			{ label: "Bookmark folder", value: "folder:<id>" },
			{ label: "User tweets", value: "@username" },
			{ label: "Search", value: "search:AI agents" },
		],
	},
	{
		key: "gdrive",
		label: "Google Drive",
		icon: "📁",
		placeholder: "root, folder:<id>, file:<id>, or query:<q>…",
		examples: [
			{ label: "My Drive root", value: "root" },
			{ label: "Folder by ID", value: "folder:abc123" },
			{ label: "Single file", value: "file:xyz789" },
		],
	},
]

const DEST_OPTIONS = [
	{ key: "", label: "Local only", icon: "💻" },
	{ key: "gdrive", label: "→ Google Drive", icon: "📁" },
]

const STATUS_ICON: Record<string, string> = {
	complete: "✓",
	running: "○",
	queued: "○",
	cancelled: "×",
	failed: "✕",
}

// --- Helpers ---

function formatMime(mime: string): string {
	const map: Record<string, string> = {
		"application/vnd.google-apps.document": "Doc",
		"application/vnd.google-apps.spreadsheet": "Sheet",
		"application/vnd.google-apps.presentation": "Slides",
		"application/vnd.google-apps.folder": "Folder",
		"application/pdf": "PDF",
		"text/markdown": "MD",
		"text/plain": "TXT",
		"text/csv": "CSV",
	}
	return map[mime] || mime.split("/")[1] || mime
}

// --- Component ---

export default function Home() {
	const navigate = useNavigate()
	const [source, setSource] = useState<SourceKind>("")
	const [target, setTarget] = useState("")
	const [outDir, setOutDir] = useState("")
	const [maxPages, setMaxPages] = useState(500)
	const [workerCount, setWorkerCount] = useState(0)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState("")
	const [recentPulls, setRecentPulls] = useState<PullSummary[]>([])
	const [runtimeMaxPages, setRuntimeMaxPages] = useState(2000)

	// Auth/connectivity status per source
	const [sourceStatuses, setSourceStatuses] = useState<Record<string, SourceStatus>>({})
	const [statusFetching, setStatusFetching] = useState(false)

	// Preview
	const [previewing, setPreviewing] = useState(false)
	const [previewItems, setPreviewItems] = useState<PreviewItem[] | null>(null)
	const [previewError, setPreviewError] = useState("")
	const [previewTotal, setPreviewTotal] = useState(0)

	// Destination
	const [destination, setDestination] = useState("")
	const [destFolder, setDestFolder] = useState("")
	const [driveFolders, setDriveFolders] = useState<{ id: string; name: string }[]>([])
	const [, setFolderSearch] = useState("")
	const [foldersLoading, setFoldersLoading] = useState(false)
	const [connectingGDrive, setConnectingGDrive] = useState(false)
	const [gdriveConnected, setGdriveConnected] = useState(false)

	// Project
	const [projectId, setProjectId] = useState("")
	const [projects, setProjects] = useState<{ id: string; name: string }[]>([])

	const fetchRecent = useCallback(async () => {
		try {
			const res = await fetch("/api/pulls")
			if (res.ok) setRecentPulls((await res.json()) as PullSummary[])
		} catch {}
	}, [])

	const fetchSourceStatuses = useCallback(async () => {
		setStatusFetching(true)
		try {
			const res = await fetch("/api/source-status")
			if (res.ok) setSourceStatuses((await res.json()) as Record<string, SourceStatus>)
		} catch {}
		setStatusFetching(false)
	}, [])

	const fetchDestStatus = useCallback(async () => {
		try {
			const res = await fetch("/api/destination-status")
			if (res.ok) {
				const destStatuses = (await res.json()) as Record<string, SourceStatus>
				setSourceStatuses((prev) => {
					const next = { ...prev }
					for (const [key, val] of Object.entries(destStatuses)) {
						next[`dest:${key}`] = val
					}
					return next
				})
			}
		} catch {}
	}, [])

	const fetchProjects = useCallback(async () => {
		try {
			const res = await fetch("/api/projects")
			if (res.ok) setProjects((await res.json()) as { id: string; name: string }[])
		} catch {}
	}, [])

	const fetchDriveFolders = useCallback(
		async (search = "") => {
			if (destination !== "gdrive") return
			setFoldersLoading(true)
			try {
				const res = await fetch(`/api/drive/folders?q=${encodeURIComponent(search)}`)
				if (res.ok) {
					const data = (await res.json()) as { folders: { id: string; name: string }[] }
					setDriveFolders(data.folders)
				}
			} catch {}
			setFoldersLoading(false)
		},
		[destination],
	)

	useEffect(() => {
		fetchRecent()
		fetchSourceStatuses()
		fetchDestStatus()
		fetch("/api/health", { cache: "no-store" })
			.then(async (res): Promise<HealthInfo | null> => (res.ok ? ((await res.json()) as HealthInfo) : null))
			.then((health) => {
				const limit = health?.limits?.maxPages
				if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) setRuntimeMaxPages(limit)
			})
			.catch(() => {})
	}, [fetchRecent, fetchSourceStatuses, fetchDestStatus])

	useEffect(() => {
		fetchProjects()
	}, [fetchProjects])

	useEffect(() => {
		if (destination === "gdrive") {
			fetchDriveFolders()
			// Check auth status
			fetch("/api/destination-status")
				.then((r) => r.json())
				.then((d) => {
					const statuses = d as Record<string, SourceStatus | undefined>
					if (statuses.gdrive?.authenticated) setGdriveConnected(true)
				})
				.catch(() => {})
		}
	}, [destination, fetchDriveFolders])

	const handleConnectDrive = async () => {
		setConnectingGDrive(true)
		try {
			const res = await fetch("/api/auth/gdrive", { method: "POST" })
			const data = (await res.json().catch(() => ({}))) as { ok?: boolean }
			if (res.ok && data.ok) {
				setGdriveConnected(true)
				fetchDriveFolders()
			}
		} catch {
		} finally {
			setConnectingGDrive(false)
		}
	}

	const currentSource = SOURCES.find((s) => s.key === source) || SOURCES[0]!
	const currentSourceStatus = source ? sourceStatuses[source] : null
	const currentDestStatus = destination ? sourceStatuses[`dest:${destination}`] : null
	const maxItemsLimit = source ? 500 : runtimeMaxPages
	const sourceUnavailable =
		!!source && !!currentSourceStatus && (!currentSourceStatus.installed || !currentSourceStatus.authenticated)
	const destinationUnavailable =
		!!destination && !!currentDestStatus && (!currentDestStatus.installed || !currentDestStatus.authenticated)
	const canStart = !!target.trim() && !sourceUnavailable && !destinationUnavailable

	useEffect(() => {
		if (maxPages > maxItemsLimit) setMaxPages(maxItemsLimit)
	}, [maxPages, maxItemsLimit])

	const getHostname = () => {
		try {
			let u = target.trim()
			if (!u) return ""
			if (!/^https?:\/\//i.test(u)) u = `https://${u}`
			return new URL(u).hostname
		} catch {
			return ""
		}
	}

	const normalizedTarget = (() => {
		if (source) return target.trim()
		try {
			let u = target.trim()
			if (!/^https?:\/\//i.test(u)) u = `https://${u}`
			return u
		} catch {
			return target.trim()
		}
	})()

	const handleStart = async () => {
		if (!target.trim()) return
		if (sourceUnavailable) {
			setError(currentSourceStatus?.message || `${currentSource.label} is not available here.`)
			return
		}
		if (destinationUnavailable) {
			setError(currentDestStatus?.message || "That destination is not available here.")
			return
		}
		setLoading(true)
		setError("")
		try {
			const body: Record<string, unknown> = source
				? {
						source,
						target: normalizedTarget,
						maxPages: Math.min(maxPages, maxItemsLimit),
						projectId: projectId || undefined,
					}
				: {
						url: normalizedTarget,
						outDir: outDir || undefined,
						maxPages: Math.min(maxPages, maxItemsLimit),
						workerCount: workerCount || undefined,
						projectId: projectId || undefined,
					}
			const res = await fetch("/api/pull", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})
			const data = (await res.json()) as any
			if (res.ok) {
				const pullId = data.pullId
				if (destination && source) {
					try {
						sessionStorage.setItem(`webpull-dest-${pullId}`, JSON.stringify({ destination, source, destFolder }))
					} catch {}
				}
				navigate(`/pull/${pullId}`)
			} else {
				setError(data.error || "Failed to start pull")
			}
		} catch (e) {
			setError(String(e))
		} finally {
			setLoading(false)
		}
	}

	const handlePreview = async () => {
		if (!target.trim() || !source || sourceUnavailable) return
		setPreviewing(true)
		setPreviewError("")
		setPreviewItems(null)
		try {
			const res = await fetch("/api/source/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source, target: normalizedTarget, max: maxPages }),
			})
			const data = (await res.json()) as any
			if (res.ok) {
				setPreviewItems(data.items as PreviewItem[])
				setPreviewTotal(data.total as number)
			} else {
				setPreviewError(data.error || "Preview failed")
			}
		} catch (e) {
			setPreviewError(String(e))
		} finally {
			setPreviewing(false)
		}
	}

	const handleSourceChange = (newSource: SourceKind) => {
		const status = newSource ? sourceStatuses[newSource] : null
		if (status && (!status.installed || !status.authenticated)) {
			setError(status.message || "That source is not available here.")
			return
		}
		setSource(newSource)
		setTarget("")
		setError("")
		setPreviewItems(null)
		setPreviewError("")
		setMaxPages(newSource ? 100 : 500)
		setWorkerCount(0)
	}

	useEffect(() => {
		if (sourceUnavailable) {
			setSource("")
			setTarget("")
			setPreviewItems(null)
			setPreviewError("")
			setError(currentSourceStatus?.message || "That source is not available here.")
		}
	}, [sourceUnavailable, currentSourceStatus])

	useEffect(() => {
		if (destinationUnavailable) {
			setDestination("")
			setDestFolder("")
			setError(currentDestStatus?.message || "That destination is not available here.")
		}
	}, [destinationUnavailable, currentDestStatus])

	const hostname = getHostname()

	const getStatusBadge = (key: string) => {
		const status = sourceStatuses[key]
		if (statusFetching && !status)
			return { cls: "status-badge status-pending", label: "Checking…", title: "Checking connectivity" }
		if (!status) return null
		if (!status.installed) return { cls: "status-badge status-failed", label: "Not installed", title: status.message }
		if (!status.authenticated) return { cls: "status-badge status-failed", label: "Needs auth", title: status.message }
		return { cls: "status-badge status-complete", label: "Ready", title: status.message }
	}

	const getDestBadge = (destKey: string) => {
		if (!destKey) return null
		const status = sourceStatuses[`dest:${destKey}`]
		if (statusFetching && !status)
			return { cls: "status-badge status-pending", label: "Checking…", title: "Checking connectivity" }
		if (!status) return null
		if (!status.installed) return { cls: "status-badge status-failed", label: "Not installed", title: status.message }
		if (!status.authenticated) return { cls: "status-badge status-failed", label: "Needs auth", title: status.message }
		return { cls: "status-badge status-complete", label: "Ready", title: status.message }
	}

	return (
		<div className="home-page">
			<h1>Pull documentation</h1>
			<p className="subtitle">
				Download public docs, YouTube transcripts, Twitter bookmarks, and Google Drive files as local markdown.
			</p>

			<div className="source-selector">
				{SOURCES.map((s) => {
					const badge = s.key ? getStatusBadge(s.key) : null
					const disabled =
						!!s.key &&
						!!sourceStatuses[s.key] &&
						(!sourceStatuses[s.key]!.installed || !sourceStatuses[s.key]!.authenticated)
					return (
						<button
							type="button"
							key={s.key}
							className={`source-tab ${source === s.key ? "active" : ""}`}
							onClick={() => handleSourceChange(s.key)}
							title={badge?.title}
							disabled={disabled}
						>
							<span className="source-tab-icon">{s.icon}</span>
							{s.label}
							{badge && s.key && <span className={`source-tab-status ${badge.cls}`}>{badge.label}</span>}
						</button>
					)
				})}
			</div>

			{source && (
				<div className="dest-selector">
					<span className="dest-label">Save to:</span>
					<div className="dest-options">
						{DEST_OPTIONS.map((d) => {
							const badge = d.key ? getDestBadge(d.key) : null
							const status = d.key ? sourceStatuses[`dest:${d.key}`] : null
							const disabled = !!d.key && !!status && (!status.installed || !status.authenticated)
							return (
								<button
									type="button"
									key={d.key}
									className={`dest-option ${destination === d.key ? "active" : ""}`}
									onClick={() => setDestination(d.key)}
									title={badge?.title}
									disabled={disabled}
								>
									<span className="source-tab-icon">{d.icon}</span>
									{d.label}
									{badge && d.key && <span className={`source-tab-status ${badge.cls}`}>{badge.label}</span>}
								</button>
							)
						})}
					</div>
				</div>
			)}

			{source && destination === "gdrive" && (
				<div className="dest-folder-section">
					{!gdriveConnected ? (
						<div className="dest-folder-row" style={{ marginBottom: "12px" }}>
							<button
								type="button"
								className="btn btn-secondary"
								onClick={handleConnectDrive}
								disabled={connectingGDrive}
							>
								{connectingGDrive ? <span className="spinner" /> : "Connect Google Drive"}
							</button>
							<span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
								Opens a browser to sign in. Come back here after.
							</span>
						</div>
					) : (
						<div className="dest-folder-row" style={{ marginBottom: "12px" }}>
							<span className="status-badge status-complete" style={{ fontSize: "11px" }}>
								✓ Connected
							</span>
							<button
								type="button"
								className="btn btn-ghost btn-small"
								onClick={() => {
									fetch("/api/destination-status")
										.then((r) => r.json())
										.then((d) => {
											const statuses = d as Record<string, SourceStatus | undefined>
											if (!statuses.gdrive?.authenticated) setGdriveConnected(false)
										})
										.catch(() => {})
								}}
							>
								Refresh
							</button>
						</div>
					)}
					<div className="dest-folder-row">
						<input
							type="text"
							placeholder="Drive folder ID or 'root'…"
							value={destFolder}
							onChange={(e) => {
								setDestFolder((e.target as HTMLInputElement).value)
								setFolderSearch((e.target as HTMLInputElement).value)
							}}
							onFocus={() => {
								if (driveFolders.length === 0) fetchDriveFolders()
							}}
							className="dest-folder-input"
						/>
						<span className="dest-folder-hint">Folder ID or &quot;root&quot; for My Drive</span>
					</div>
					{driveFolders.length > 0 && (
						<div className="folder-picker">
							<div className="folder-picker-header">Recent folders</div>
							{driveFolders.slice(0, 8).map((f) => (
								<button
									type="button"
									key={f.id}
									className="folder-picker-item"
									onClick={() => {
										setDestFolder(f.id)
										setFolderSearch("")
									}}
								>
									📁 {f.name}
									<span className="folder-picker-id">{f.id}</span>
								</button>
							))}
						</div>
					)}
					{foldersLoading && (
						<div className="folder-picker-loading">
							<span className="spinner" /> Loading folders…
						</div>
					)}
				</div>
			)}

			{projects.length > 0 && (
				<div className="dest-selector">
					<span className="dest-label">Project:</span>
					<select
						value={projectId}
						onChange={(e) => setProjectId((e.target as HTMLSelectElement).value)}
						style={{
							background: "var(--bg-alt)",
							border: "1px solid var(--border)",
							borderRadius: "6px",
							color: "var(--fg)",
							padding: "5px 8px",
							fontSize: "13px",
							cursor: "pointer",
						}}
					>
						<option value="">None</option>
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</div>
			)}
			<div className="url-bar">
				<input
					type="text"
					placeholder={currentSource.placeholder}
					value={target}
					onChange={(e) => setTarget((e.target as HTMLInputElement).value)}
					onKeyDown={(e) => e.key === "Enter" && canStart && handleStart()}
				/>
				{source && (
					<button
						type="button"
						className="btn btn-secondary"
						onClick={handlePreview}
						disabled={previewing || !target.trim() || sourceUnavailable}
						title="Preview what will be pulled before starting"
					>
						{previewing ? <span className="spinner" /> : "Preview"}
					</button>
				)}
				<button type="button" className="btn btn-primary" onClick={handleStart} disabled={loading || !canStart}>
					{loading ? <span className="spinner" /> : "Pull"}
				</button>
			</div>

			{currentSource.examples.length > 0 && (
				<div className="source-examples">
					Try:{" "}
					{currentSource.examples.map((ex) => (
						<button type="button" key={ex.value} className="source-example-btn" onClick={() => setTarget(ex.value)}>
							{ex.label}
						</button>
					))}
				</div>
			)}

			{!source && hostname && <div className="url-preview">Output: ./{hostname}/</div>}
			{source && (
				<div className="url-preview">
					{currentSource.label} source · Saves to pulls/ folder in project
					{destination && ` · Dest: ${DEST_OPTIONS.find((d) => d.key === destination)?.label.replace("→ ", "")}`}
				</div>
			)}

			{previewItems !== null && (
				<div className="preview-panel">
					<div className="preview-panel-header">
						<span>
							Found {previewTotal} item{previewTotal !== 1 ? "s" : ""}
						</span>
						<button type="button" className="btn btn-ghost btn-small" onClick={() => setPreviewItems(null)}>
							×
						</button>
					</div>
					<div className="preview-panel-list">
						{previewItems.slice(0, 30).map((item) => (
							<div key={item.id} className="preview-item">
								<span className="preview-item-index" />
								<div className="preview-item-main">
									<span className="preview-item-title">{item.title}</span>
									<div className="preview-item-meta">
										{(item.meta as any)?.kind && <span className="preview-item-kind">{(item.meta as any).kind}</span>}
										{(item.meta as any)?.mimeType && (
											<span className="preview-item-kind">{formatMime((item.meta as any).mimeType)}</span>
										)}
										{(item.meta as any)?.published && (
											<span className="preview-item-date">{(item.meta as any).published}</span>
										)}
										{(item.meta as any)?.channel && (
											<span className="preview-item-kind">@{(item.meta as any).channel}</span>
										)}
										{(item.meta as any)?.author && (
											<span className="preview-item-kind">@{(item.meta as any).author}</span>
										)}
										{(item.meta as any)?.size && <span className="preview-item-size">{(item.meta as any).size}</span>}
									</div>
								</div>
							</div>
						))}
						{previewTotal > 30 && <div className="preview-item preview-more">… and {previewTotal - 30} more</div>}
					</div>
				</div>
			)}

			{previewError && <div className="error-msg">{previewError}</div>}

			<div className="config-section">
				<div className="config-section-label">Options</div>
				{!source && (
					<div className="config-row">
						<div className="config-field">
							<span className="field-label">Output directory</span>
							<input
								type="text"
								placeholder={`./${hostname || "hostname"}`}
								value={outDir}
								onChange={(e) => setOutDir((e.target as HTMLInputElement).value)}
							/>
						</div>
					</div>
				)}
				<div className="config-row" style={source ? {} : { marginTop: "12px" }}>
					<div className="config-field">
						<span className="field-label">Max items</span>
						<div className="range-row">
							<input
								type="range"
								min={source ? 5 : 10}
								max={maxItemsLimit}
								step={source ? 5 : 10}
								value={maxPages}
								onChange={(e) => setMaxPages(parseInt((e.target as HTMLInputElement).value, 10))}
							/>
							<span>{maxPages}</span>
						</div>
					</div>
					{!source && (
						<div className="config-field">
							<span className="field-label">Workers</span>
							<div className="range-row">
								<input
									type="range"
									min={0}
									max={64}
									step={1}
									value={workerCount}
									onChange={(e) => setWorkerCount(parseInt((e.target as HTMLInputElement).value, 10))}
								/>
								<span>{workerCount || "auto"}</span>
							</div>
						</div>
					)}
				</div>
			</div>

			{error && <div className="error-msg">{error}</div>}

			{recentPulls.length > 0 && (
				<div className="recent-section">
					<h2>Recent pulls</h2>
					<div className="pull-list">
						{recentPulls.slice(0, 10).map((pull) => (
							// biome-ignore lint/a11y/useSemanticElements: complex row layout with nested button
							<div
								key={pull.id}
								className="pull-row"
								role="button"
								tabIndex={0}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault()
										pull.status === "complete" ? navigate(`/results/${pull.id}`) : navigate(`/pull/${pull.id}`)
									}
								}}
								onClick={() =>
									pull.status === "complete" ? navigate(`/results/${pull.id}`) : navigate(`/pull/${pull.id}`)
								}
							>
								{pull.source && <span className="source-badge">{pull.source}</span>}
								<span className="pull-row-url">{pull.url}</span>
								<span className="pull-row-meta">
									<span className={`status-badge status-${pull.status}`}>
										<span>{STATUS_ICON[pull.status] ?? "?"}</span>
										{pull.status}
									</span>
								</span>
								<span className="pull-row-meta">{pull.pages_ok > 0 ? `${pull.pages_ok} items` : "—"}</span>
								<span className="pull-row-meta" style={{ textAlign: "right" }}>
									{new Date(pull.started_at).toLocaleDateString()}
								</span>
								<button
									type="button"
									className="pull-row-delete"
									onClick={(e) => {
										e.stopPropagation()
										fetch(`/api/pulls/${pull.id}`, { method: "DELETE" }).then(fetchRecent)
									}}
								>
									×
								</button>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	)
}
