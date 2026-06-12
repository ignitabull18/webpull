import type React from "react"
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"

interface PullSummary {
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

interface SearchResult {
	id: number
	pull_id: string
	path: string
	url: string
	title: string
	content: string
	rank: number
	pull_url: string
}

const STATUS_ICON: Record<string, string> = {
	complete: "✓",
	running: "○",
	queued: "○",
	cancelled: "×",
	failed: "✕",
}

export default function History() {
	const navigate = useNavigate()
	const [pulls, setPulls] = useState<PullSummary[]>([])
	const [searchQuery, setSearchQuery] = useState("")
	const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
	const [loading, setLoading] = useState(true)

	const fetchPulls = useCallback(async () => {
		try {
			const res = await fetch("/api/pulls")
			if (res.ok) setPulls((await res.json()) as PullSummary[])
		} catch {
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		fetchPulls()
	}, [fetchPulls])

	const handleSearch = useCallback(async () => {
		if (!searchQuery.trim()) {
			setSearchResults(null)
			return
		}
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`)
			if (res.ok) setSearchResults((await res.json()) as SearchResult[])
		} catch {}
	}, [searchQuery])

	useEffect(() => {
		const timer = setTimeout(handleSearch, 300)
		return () => clearTimeout(timer)
	}, [handleSearch])

	const handleDelete = async (e: React.MouseEvent, pullId: string) => {
		e.stopPropagation()
		await fetch(`/api/pulls/${pullId}`, { method: "DELETE" })
		fetchPulls()
	}

	if (loading) {
		return (
			<div className="history-page">
				<div className="empty-state">
					<span className="spinner" /> Loading…
				</div>
			</div>
		)
	}

	return (
		<div className="history-page">
			<h1>History</h1>
			<p className="subtitle">Past pulls and full-text search across all downloaded content.</p>

			<div className="search-bar">
				<input
					type="search"
					placeholder="Search across all pulled docs…"
					value={searchQuery}
					onChange={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
				/>
			</div>

			{searchResults && (
				<div className="search-results-section">
					<div className="search-results-header">
						{searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
					</div>
					{searchResults.length === 0 ? (
						<div className="empty-state" style={{ padding: "24px 0" }}>
							No matches found.
						</div>
					) : (
						searchResults.map((sr) => {
							const hostname = (() => {
								try {
									return new URL(sr.pull_url).hostname
								} catch {
									return sr.pull_url
								}
							})()
							return (
								<button
									type="button"
									key={`${sr.pull_id}-${sr.id}`}
									className="search-result-item"
									onClick={() => navigate(`/results/${sr.pull_id}`)}
								>
									<div className="result-title">{sr.title || sr.path}</div>
									<div className="result-meta">
										{hostname} → {sr.path}
									</div>
									<div className="result-snippet">
										{sr.content.slice(0, 240)}
										{sr.content.length > 240 ? "…" : ""}
									</div>
								</button>
							)
						})
					)}
				</div>
			)}

			{pulls.length === 0 && !searchResults ? (
				<div className="empty-state">No pulls yet.</div>
			) : (
				!searchResults && (
					<>
						<h2>All pulls</h2>
						<table className="pull-table">
							<thead>
								<tr>
									<th>URL</th>
									<th>Status</th>
									<th>Pages</th>
									<th>Date</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								{pulls.map((pull) => (
									<tr key={pull.id} onClick={() => navigate(`/results/${pull.id}`)}>
										<td className="url-cell">{pull.url}</td>
										<td>
											<span className={`status-badge status-${pull.status}`}>
												<span>{STATUS_ICON[pull.status] ?? "?"}</span>
												{pull.status}
											</span>
										</td>
										<td style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
											{pull.pages_ok > 0 ? pull.pages_ok : "—"}
											{pull.pages_err > 0 && (
												<span style={{ color: "var(--red)", marginLeft: "4px" }}>{pull.pages_err} err</span>
											)}
										</td>
										<td className="date-cell">{new Date(pull.started_at).toLocaleDateString()}</td>
										<td className="del-cell">
											<button type="button" className="pull-row-delete" onClick={(e) => handleDelete(e, pull.id)}>
												×
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</>
				)
			)}
		</div>
	)
}
