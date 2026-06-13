import { useCallback, useEffect, useMemo, useState } from "react"

interface KnowledgeBucket {
	id: string
	name: string
	status?: string
	itemCount?: number
	createdAt?: string
	updatedAt?: string
	lastActivity?: string
}

interface PullRow {
	id: string
	url: string
	status: string
	pages_ok: number
	pages_err: number
	started_at: string
}

interface SearchChunk {
	id?: string
	score?: number
	text?: string
	item?: {
		key?: string
		metadata?: Record<string, unknown>
	}
}

interface SearchResponse {
	chunks?: SearchChunk[]
	search_query?: string
}

interface AskResponse {
	answer?: string
	citations?: { title?: string; path?: string; url?: string; bucket?: string }[]
	error?: string
}

export default function Knowledge() {
	const [buckets, setBuckets] = useState<KnowledgeBucket[]>([])
	const [pulls, setPulls] = useState<PullRow[]>([])
	const [selectedBucketId, setSelectedBucketId] = useState("")
	const [newName, setNewName] = useState("")
	const [selectedPullId, setSelectedPullId] = useState("")
	const [query, setQuery] = useState("")
	const [askQuery, setAskQuery] = useState("")
	const [askResult, setAskResult] = useState<AskResponse | null>(null)
	const [searchResult, setSearchResult] = useState<SearchResponse | null>(null)
	const [loading, setLoading] = useState(true)
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState("")
	const [error, setError] = useState("")

	const selectedBucket = useMemo(
		() => buckets.find((bucket) => bucket.id === selectedBucketId) || buckets[0] || null,
		[buckets, selectedBucketId],
	)

	const completedPulls = useMemo(
		() => pulls.filter((pull) => pull.status === "complete" || pull.status === "partial"),
		[pulls],
	)

	const load = useCallback(async () => {
		setError("")
		try {
			const [bucketRes, pullRes] = await Promise.all([fetch("/api/knowledge-buckets"), fetch("/api/pulls")])
			const bucketData = (await bucketRes.json().catch(() => ({}))) as {
				buckets?: KnowledgeBucket[]
				message?: string
				error?: string
			}
			const pullData = (await pullRes.json().catch(() => [])) as PullRow[]
			if (bucketRes.ok) {
				const nextBuckets = bucketData.buckets || []
				setBuckets(nextBuckets)
				setSelectedBucketId((current) => current || nextBuckets[0]?.id || "")
				if (bucketData.message) setMessage(bucketData.message)
			} else {
				setError(bucketData.error || bucketData.message || "Knowledge buckets are not available.")
			}
			if (pullRes.ok) {
				setPulls(pullData)
				setSelectedPullId((current) => current || pullData.find((pull) => pull.status === "complete")?.id || "")
			}
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		load()
	}, [load])

	const createBucket = async () => {
		if (!newName.trim()) return
		setBusy(true)
		setError("")
		setMessage("")
		try {
			const res = await fetch("/api/knowledge-buckets", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: newName }),
			})
			const data = (await res.json().catch(() => ({}))) as { bucket?: KnowledgeBucket; error?: string }
			if (!res.ok || !data.bucket) {
				setError(data.error || "Bucket create failed.")
				return
			}
			setNewName("")
			setSelectedBucketId(data.bucket.id)
			setMessage(`Created ${data.bucket.name}.`)
			await load()
		} finally {
			setBusy(false)
		}
	}

	const deleteBucket = async (bucketId: string) => {
		setBusy(true)
		setError("")
		setMessage("")
		try {
			const res = await fetch(`/api/knowledge-buckets/${encodeURIComponent(bucketId)}`, { method: "DELETE" })
			const data = (await res.json().catch(() => ({}))) as { error?: string }
			if (!res.ok) {
				setError(data.error || "Delete failed.")
				return
			}
			setSelectedBucketId("")
			setMessage("Bucket deleted.")
			await load()
		} finally {
			setBusy(false)
		}
	}

	const addPull = async () => {
		if (!selectedBucket || !selectedPullId) return
		setBusy(true)
		setError("")
		setMessage("")
		try {
			const res = await fetch(`/api/knowledge-buckets/${encodeURIComponent(selectedBucket.id)}/add-pull`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ pullId: selectedPullId }),
			})
			const data = (await res.json().catch(() => ({}))) as { uploaded?: number; total?: number; error?: string }
			if (!res.ok) {
				setError(data.error || "Add failed.")
				return
			}
			setMessage(`Added ${data.uploaded || 0} of ${data.total || 0} documents.`)
			await load()
		} finally {
			setBusy(false)
		}
	}

	const searchBucket = async () => {
		if (!selectedBucket || !query.trim()) return
		setBusy(true)
		setError("")
		setMessage("")
		setSearchResult(null)
		try {
			const res = await fetch(`/api/knowledge-buckets/${encodeURIComponent(selectedBucket.id)}/search`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query, mode: "hybrid" }),
			})
			const data = (await res.json().catch(() => ({}))) as { results?: SearchResponse; error?: string }
			if (!res.ok) {
				setError(data.error || "Search failed.")
				return
			}
			setSearchResult(data.results || null)
		} finally {
			setBusy(false)
		}
	}

	const askBuckets = async () => {
		if (!askQuery.trim()) return
		setBusy(true)
		setError("")
		setMessage("")
		setAskResult(null)
		try {
			const bucketIds = selectedBucket ? [selectedBucket.id] : buckets.map((bucket) => bucket.id)
			const res = await fetch("/api/ask", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ question: askQuery, bucketIds }),
			})
			const data = (await res.json().catch(() => ({}))) as AskResponse
			setAskResult(res.ok ? data : { error: data.error || "Ask is not available for buckets yet." })
		} catch (caught) {
			setAskResult({ error: String(caught) })
		} finally {
			setBusy(false)
		}
	}

	if (loading) {
		return (
			<div className="knowledge-page">
				<div className="empty-state">
					<span className="spinner" /> Loading
				</div>
			</div>
		)
	}

	return (
		<div className="knowledge-page">
			<header className="knowledge-header">
				<div>
					<h1>Knowledge Buckets</h1>
					<p>{buckets.length} active</p>
				</div>
				<div className="knowledge-create">
					<input
						type="text"
						value={newName}
						placeholder="New bucket name"
						onChange={(event) => setNewName((event.target as HTMLInputElement).value)}
						onKeyDown={(event) => event.key === "Enter" && createBucket()}
					/>
					<button type="button" className="btn btn-primary" onClick={createBucket} disabled={busy || !newName.trim()}>
						Create
					</button>
				</div>
			</header>

			{error && <div className="error-msg knowledge-notice">{error}</div>}
			{message && <div className="success-msg knowledge-notice">{message}</div>}

			<div className="knowledge-layout">
				<section className="knowledge-list" aria-label="Knowledge buckets">
					{buckets.length === 0 ? (
						<div className="empty-state knowledge-empty">No buckets yet</div>
					) : (
						buckets.map((bucket) => (
							<button
								type="button"
								key={bucket.id}
								className={`knowledge-bucket-row ${selectedBucket?.id === bucket.id ? "active" : ""}`}
								onClick={() => setSelectedBucketId(bucket.id)}
							>
								<span>
									<strong>{bucket.name}</strong>
									<code>{bucket.id}</code>
								</span>
								<span>{bucket.itemCount || 0} items</span>
							</button>
						))
					)}
				</section>

				<section className="knowledge-detail">
					{selectedBucket ? (
						<>
							<div className="knowledge-detail-header">
								<div>
									<h2>{selectedBucket.name}</h2>
									<code>{selectedBucket.id}</code>
								</div>
								<button
									type="button"
									className="btn btn-danger btn-small"
									onClick={() => deleteBucket(selectedBucket.id)}
									disabled={busy}
								>
									Delete
								</button>
							</div>

							<div className="knowledge-actions">
								<div className="knowledge-action">
									<label htmlFor="knowledge-pull-select">Add Pull</label>
									<div className="knowledge-action-row">
										<select
											id="knowledge-pull-select"
											value={selectedPullId}
											onChange={(event) => setSelectedPullId((event.target as HTMLSelectElement).value)}
										>
											<option value="">Select completed pull</option>
											{completedPulls.map((pull) => (
												<option key={pull.id} value={pull.id}>
													{pull.url}
												</option>
											))}
										</select>
										<button
											type="button"
											className="btn btn-secondary"
											onClick={addPull}
											disabled={busy || !selectedPullId}
										>
											Add
										</button>
									</div>
								</div>

								<div className="knowledge-action">
									<label htmlFor="knowledge-query">Search</label>
									<div className="knowledge-action-row">
										<input
											id="knowledge-query"
											type="search"
											value={query}
											placeholder="Search this bucket"
											onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
											onKeyDown={(event) => event.key === "Enter" && searchBucket()}
										/>
										<button
											type="button"
											className="btn btn-secondary"
											onClick={searchBucket}
											disabled={busy || !query.trim()}
										>
											Search
										</button>
									</div>
								</div>

								<div className="knowledge-action">
									<label htmlFor="knowledge-ask">Ask</label>
									<div className="knowledge-action-row">
										<input
											id="knowledge-ask"
											type="search"
											value={askQuery}
											placeholder="Ask with citations from this bucket"
											onChange={(event) => setAskQuery((event.target as HTMLInputElement).value)}
											onKeyDown={(event) => event.key === "Enter" && askBuckets()}
										/>
										<button
											type="button"
											className="btn btn-primary"
											onClick={askBuckets}
											disabled={busy || !askQuery.trim()}
										>
											Ask
										</button>
									</div>
								</div>
							</div>

							{askResult && (
								<div className="knowledge-answer">
									{askResult.error ? (
										<div className="error-msg">{askResult.error}</div>
									) : (
										<>
											<p>{askResult.answer || "No answer returned."}</p>
											{askResult.citations && askResult.citations.length > 0 && (
												<div className="ask-citations">
													{askResult.citations.map((citation) => (
														<span key={citation.url || citation.path || citation.title} className="ask-citation-badge">
															{citation.title || citation.path || citation.url}
														</span>
													))}
												</div>
											)}
										</>
									)}
								</div>
							)}

							<div className="knowledge-results">
								{busy && <span className="spinner" />}
								{searchResult?.chunks && searchResult.chunks.length > 0 ? (
									searchResult.chunks.map((chunk, index) => (
										<article key={chunk.id || `${chunk.item?.key || "chunk"}-${index}`} className="knowledge-result">
											<header>
												<strong>{String(chunk.item?.metadata?.title || chunk.item?.key || "Result")}</strong>
												<span className="knowledge-result-score">
													{typeof chunk.score === "number" ? chunk.score.toFixed(2) : ""}
												</span>
											</header>
											<p>{chunk.text || ""}</p>
										</article>
									))
								) : searchResult ? (
									<div className="empty-state knowledge-empty">No matches</div>
								) : null}
							</div>
						</>
					) : (
						<div className="empty-state knowledge-empty">Create a bucket to start</div>
					)}
				</section>
			</div>
		</div>
	)
}
