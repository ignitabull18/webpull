import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"

interface Project {
	id: string
	name: string
	description?: string
	docCount?: number
	sourceCount?: number
	bucketCount?: number
	updated_at?: string
}

interface Source {
	id: string
	project_id?: string
	projectId?: string
	name?: string
	url?: string
	target?: string
	kind?: string
	cadence?: string
	status?: string
	last_run_at?: string
	next_run_at?: string
	last_refreshed_at?: string
	next_refresh_at?: string
	lastRunAt?: string
	nextRunAt?: string
	watch?: boolean
	alerts?: boolean
}

interface Change {
	id?: string
	source_id?: string
	sourceId?: string
	url: string
	title?: string
	status?: "new" | "changed" | "unchanged" | "removed" | string
	before?: string
	after?: string
	summary?: string
	pull_id?: string
	pullId?: string
	created_at?: string
}

interface AskResponse {
	answer?: string
	citations?: { title?: string; url?: string; path?: string; bucket?: string; pullDate?: string }[]
	error?: string
}

interface ExportResponse {
	ok?: boolean
	url?: string
	path?: string
	status?: string
	error?: string
}

const CADENCES = ["manual", "hourly", "daily", "weekly", "monthly"]
const EXTRACTION_MODES = ["markdown", "tables", "api-reference", "entities", "pricing", "changelog"]
const EXPORT_DESTINATIONS = ["local-zip", "github", "google-drive", "notion", "mcp-resource"]

const FALLBACK_PROJECTS: Project[] = [
	{
		id: "local",
		name: "Local collector",
		description: "Connect projects, saved sources, runs, documents, and buckets as the APIs come online.",
		docCount: 0,
		sourceCount: 0,
		bucketCount: 0,
	},
]

function niceDate(value?: string) {
	if (!value) return "Not scheduled"
	try {
		return new Date(value).toLocaleString()
	} catch {
		return value
	}
}

function projectFor(source: Source) {
	return source.project_id || source.projectId || "local"
}

function sourceUrl(source: Source) {
	return source.url || source.target || ""
}

function sourceName(source: Source) {
	return source.name || sourceUrl(source) || source.id
}

function sourceLastRun(source: Source) {
	return source.last_run_at || source.last_refreshed_at || source.lastRunAt
}

function sourceNextRun(source: Source) {
	return source.next_run_at || source.next_refresh_at || source.nextRunAt
}

function changeSourceId(change: Change) {
	return change.source_id || change.sourceId || ""
}

export default function Collector() {
	const navigate = useNavigate()
	const [projects, setProjects] = useState<Project[]>([])
	const [sources, setSources] = useState<Source[]>([])
	const [changes, setChanges] = useState<Change[]>([])
	const [selectedProjectId, setSelectedProjectId] = useState("")
	const [selectedSourceId, setSelectedSourceId] = useState("")
	const [loading, setLoading] = useState(true)
	const [apiNotice, setApiNotice] = useState("")
	const [newSourceUrl, setNewSourceUrl] = useState("")
	const [newSourceCadence, setNewSourceCadence] = useState("daily")
	const [extractionMode, setExtractionMode] = useState("markdown")
	const [exportDestination, setExportDestination] = useState("local-zip")
	const [watchEnabled, setWatchEnabled] = useState(true)
	const [savingSource, setSavingSource] = useState(false)
	const [exporting, setExporting] = useState(false)
	const [exportResult, setExportResult] = useState<ExportResponse | null>(null)
	const [question, setQuestion] = useState("")
	const [asking, setAsking] = useState(false)
	const [askResult, setAskResult] = useState<AskResponse | null>(null)

	const loadCollector = useCallback(async () => {
		setLoading(true)
		setApiNotice("")
		try {
			const [projectRes, sourceRes, changeRes] = await Promise.all([
				fetch("/api/projects"),
				fetch("/api/sources"),
				fetch("/api/changes"),
			])
			const nextProjects = projectRes.ok ? ((await projectRes.json().catch(() => [])) as Project[]) : []
			const sourceData = sourceRes.ok
				? ((await sourceRes.json().catch(() => [])) as { sources?: Source[] } | Source[])
				: []
			const changeData = changeRes.ok
				? ((await changeRes.json().catch(() => [])) as { changes?: Change[] } | Change[])
				: []
			const nextSources = Array.isArray(sourceData) ? sourceData : sourceData.sources || []
			const nextChanges = Array.isArray(changeData) ? changeData : changeData.changes || []
			setProjects(nextProjects.length > 0 ? nextProjects : FALLBACK_PROJECTS)
			setSources(nextSources)
			setChanges(nextChanges)
			setSelectedProjectId((current) => current || nextProjects[0]?.id || FALLBACK_PROJECTS[0]!.id)
			if (!sourceRes.ok || !changeRes.ok) {
				setApiNotice(
					"Collector APIs are still coming online. This page will fill in as /api/sources and /api/changes respond.",
				)
			}
		} catch {
			setProjects(FALLBACK_PROJECTS)
			setApiNotice("Collector APIs are not reachable yet. Saved source and change panels are ready for the backend.")
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		loadCollector()
	}, [loadCollector])

	const selectedProject = useMemo(
		() => projects.find((project) => project.id === selectedProjectId) || projects[0] || FALLBACK_PROJECTS[0]!,
		[projects, selectedProjectId],
	)

	const projectSources = useMemo(
		() => sources.filter((source) => projectFor(source) === selectedProject.id || selectedProject.id === "local"),
		[sources, selectedProject.id],
	)

	const selectedSource = useMemo(
		() => projectSources.find((source) => source.id === selectedSourceId) || projectSources[0] || null,
		[projectSources, selectedSourceId],
	)

	const sourceChanges = useMemo(() => {
		if (!selectedSource) return changes
		return changes.filter((change) => changeSourceId(change) === selectedSource.id || !changeSourceId(change))
	}, [changes, selectedSource])

	const changeCounts = useMemo(() => {
		const counts: Record<string, number> = { new: 0, changed: 0, removed: 0, unchanged: 0 }
		for (const change of sourceChanges)
			counts[change.status || "changed"] = (counts[change.status || "changed"] || 0) + 1
		return counts
	}, [sourceChanges])

	const saveSource = async () => {
		if (!newSourceUrl.trim()) return
		setSavingSource(true)
		setApiNotice("")
		try {
			const res = await fetch("/api/sources", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					projectId: selectedProject.id === "local" ? undefined : selectedProject.id,
					url: newSourceUrl.trim(),
					cadence: newSourceCadence,
					extractionMode,
					watch: watchEnabled,
				}),
			})
			if (!res.ok) {
				setApiNotice(`Saved source API returned ${res.status}. The UI is ready once the route is wired.`)
				return
			}
			setNewSourceUrl("")
			await loadCollector()
		} catch (caught) {
			setApiNotice(String(caught))
		} finally {
			setSavingSource(false)
		}
	}

	const runExport = async () => {
		setExporting(true)
		setExportResult(null)
		try {
			const res = await fetch("/api/exports", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					projectId: selectedProject.id,
					sourceId: selectedSource?.id,
					destination: exportDestination,
					mode: extractionMode,
				}),
			})
			const data = (await res.json().catch(() => ({}))) as ExportResponse
			setExportResult(res.ok ? data : { error: data.error || `Export API returned ${res.status}` })
		} catch (caught) {
			setExportResult({ error: String(caught) })
		} finally {
			setExporting(false)
		}
	}

	const askAcrossBuckets = async () => {
		if (!question.trim()) return
		setAsking(true)
		setAskResult(null)
		try {
			const res = await fetch("/api/ask", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					question,
					projectId: selectedProject.id,
					sourceIds: selectedSource ? [selectedSource.id] : projectSources.map((source) => source.id),
				}),
			})
			const data = (await res.json().catch(() => ({}))) as AskResponse
			setAskResult(res.ok ? data : { error: data.error || `Ask API returned ${res.status}` })
		} catch (caught) {
			setAskResult({ error: String(caught) })
		} finally {
			setAsking(false)
		}
	}

	return (
		<div className="collector-page">
			<header className="collector-header">
				<div>
					<h1>Collector</h1>
					<p>Projects, saved sources, refreshes, changes, documents, and buckets in one working surface.</p>
				</div>
				<button type="button" className="btn btn-secondary" onClick={() => navigate("/")}>
					New pull
				</button>
			</header>

			{apiNotice && <div className="collector-notice">{apiNotice}</div>}

			<div className="collector-layout">
				<aside className="collector-rail" aria-label="Projects">
					<h2>Projects</h2>
					{loading ? (
						<div className="empty-state">
							<span className="spinner" /> Loading
						</div>
					) : (
						projects.map((project) => (
							<button
								type="button"
								key={project.id}
								className={`collector-project ${selectedProject.id === project.id ? "active" : ""}`}
								onClick={() => {
									setSelectedProjectId(project.id)
									setSelectedSourceId("")
								}}
							>
								<strong>{project.name}</strong>
								<span className="collector-project-description">
									{project.description || `${project.docCount || 0} docs`}
								</span>
							</button>
						))
					)}
				</aside>

				<main className="collector-main">
					<section className="collector-band collector-kpis" aria-label="Collector status">
						<div>
							<span className="collector-kpi-label">Sources</span>
							<strong>{projectSources.length}</strong>
						</div>
						<div>
							<span className="collector-kpi-label">Changed</span>
							<strong>{changeCounts.changed || 0}</strong>
						</div>
						<div>
							<span className="collector-kpi-label">New</span>
							<strong>{changeCounts.new || 0}</strong>
						</div>
						<div>
							<span className="collector-kpi-label">Removed</span>
							<strong>{changeCounts.removed || 0}</strong>
						</div>
					</section>

					<section className="collector-band">
						<div className="collector-section-head">
							<div>
								<h2>Saved Sources</h2>
								<p>Choose cadence, extraction mode, and watch status for automatic refresh.</p>
							</div>
						</div>
						<div className="collector-source-form">
							<input
								type="text"
								value={newSourceUrl}
								placeholder="https://developers.cloudflare.com/..."
								onChange={(event) => setNewSourceUrl((event.target as HTMLInputElement).value)}
								onKeyDown={(event) => event.key === "Enter" && saveSource()}
							/>
							<select value={newSourceCadence} onChange={(event) => setNewSourceCadence(event.target.value)}>
								{CADENCES.map((cadence) => (
									<option key={cadence} value={cadence}>
										{cadence}
									</option>
								))}
							</select>
							<label className="collector-toggle">
								<input
									type="checkbox"
									checked={watchEnabled}
									onChange={(event) => setWatchEnabled((event.target as HTMLInputElement).checked)}
								/>
								Watch
							</label>
							<button
								type="button"
								className="btn btn-primary"
								onClick={saveSource}
								disabled={savingSource || !newSourceUrl.trim()}
							>
								{savingSource ? <span className="spinner" /> : "Save"}
							</button>
						</div>

						<div className="collector-source-list">
							{projectSources.length === 0 ? (
								<div className="empty-state collector-empty">No saved sources yet.</div>
							) : (
								projectSources.map((source) => (
									<button
										type="button"
										key={source.id}
										className={`collector-source ${selectedSource?.id === source.id ? "active" : ""}`}
										onClick={() => setSelectedSourceId(source.id)}
									>
										<span>
											<strong>{sourceName(source)}</strong>
											<code>{sourceUrl(source)}</code>
										</span>
										<span className="collector-source-meta">
											{source.cadence || "manual"} · next {niceDate(sourceNextRun(source))}
										</span>
									</button>
								))
							)}
						</div>
					</section>

					<div className="collector-grid">
						<section className="collector-band">
							<div className="collector-section-head">
								<div>
									<h2>Change Tracking</h2>
									<p>New, changed, removed, and unchanged pages between runs.</p>
								</div>
							</div>
							<div className="change-list">
								{sourceChanges.length === 0 ? (
									<div className="empty-state collector-empty">No changes reported yet.</div>
								) : (
									sourceChanges.slice(0, 8).map((change, index) => (
										<article key={change.id || `${change.url}-${index}`} className="change-row">
											<header>
												<span className={`change-status change-${change.status || "changed"}`}>
													{change.status || "changed"}
												</span>
												<strong>{change.title || change.url}</strong>
											</header>
											<p>{change.summary || change.url}</p>
											{(change.before || change.after) && (
												<div className="diff-preview">
													<span className="diff-line diff-line-old">- {change.before || "previous version"}</span>
													<span className="diff-line diff-line-new">+ {change.after || "current version"}</span>
												</div>
											)}
										</article>
									))
								)}
							</div>
						</section>

						<section className="collector-band">
							<div className="collector-section-head">
								<div>
									<h2>Quality Diagnostics</h2>
									<p>Extraction confidence, render mode, lineage, and weak-page signals.</p>
								</div>
							</div>
							<div className="diagnostic-grid">
								<div>
									<span className="collector-kpi-label">Confidence</span>
									<strong>{sourceChanges.length > 0 ? "Needs review" : "Waiting"}</strong>
								</div>
								<div>
									<span className="collector-kpi-label">Render mode</span>
									<strong>{selectedSource?.kind === "website" ? "SPA aware" : selectedSource?.kind || "auto"}</strong>
								</div>
								<div>
									<span className="collector-kpi-label">Last refresh</span>
									<strong>{niceDate(selectedSource ? sourceLastRun(selectedSource) : undefined)}</strong>
								</div>
								<div>
									<span className="collector-kpi-label">Lineage</span>
									<strong>{selectedProject.name}</strong>
								</div>
							</div>
						</section>
					</div>

					<section className="collector-band">
						<div className="collector-section-head">
							<div>
								<h2>Structured Extraction and Exports</h2>
								<p>Collect markdown plus schema-friendly data and send it where teams work.</p>
							</div>
						</div>
						<div className="collector-controls">
							<select value={extractionMode} onChange={(event) => setExtractionMode(event.target.value)}>
								{EXTRACTION_MODES.map((mode) => (
									<option key={mode} value={mode}>
										{mode}
									</option>
								))}
							</select>
							<select value={exportDestination} onChange={(event) => setExportDestination(event.target.value)}>
								{EXPORT_DESTINATIONS.map((destination) => (
									<option key={destination} value={destination}>
										{destination}
									</option>
								))}
							</select>
							<button type="button" className="btn btn-secondary" onClick={runExport} disabled={exporting}>
								{exporting ? <span className="spinner" /> : "Export"}
							</button>
						</div>
						{exportResult && (
							<div className={exportResult.error ? "error-msg collector-inline" : "success-msg collector-inline"}>
								{exportResult.error || exportResult.url || exportResult.path || exportResult.status || "Export queued"}
							</div>
						)}
					</section>

					<section className="collector-band">
						<div className="collector-section-head">
							<div>
								<h2>Ask Across Buckets</h2>
								<p>Answers should include citations, source filters, pull dates, versions, and extraction method.</p>
							</div>
						</div>
						<div className="collector-ask-row">
							<input
								type="search"
								value={question}
								placeholder="What changed in this project?"
								onChange={(event) => setQuestion((event.target as HTMLInputElement).value)}
								onKeyDown={(event) => event.key === "Enter" && askAcrossBuckets()}
							/>
							<button
								type="button"
								className="btn btn-primary"
								onClick={askAcrossBuckets}
								disabled={asking || !question.trim()}
							>
								{asking ? <span className="spinner" /> : "Ask"}
							</button>
						</div>
						{askResult && (
							<div className="collector-answer">
								{askResult.error ? (
									<div className="error-msg">{askResult.error}</div>
								) : (
									<>
										<p>{askResult.answer || "No answer returned."}</p>
										<div className="ask-citations">
											{(askResult.citations || []).map((citation) => (
												<span key={citation.url || citation.path || citation.title} className="ask-citation-badge">
													{citation.title || citation.path || citation.url}
												</span>
											))}
										</div>
									</>
								)}
							</div>
						)}
					</section>
				</main>
			</div>
		</div>
	)
}
