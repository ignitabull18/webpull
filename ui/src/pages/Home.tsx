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

const STATUS_ICON: Record<string, string> = {
	complete: "✓",
	running: "○",
	failed: "✕",
}

export default function Home() {
	const navigate = useNavigate()
	const [url, setUrl] = useState("")
	const [outDir, setOutDir] = useState("")
	const [maxPages, setMaxPages] = useState(500)
	const [workerCount, setWorkerCount] = useState(0)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState("")
	const [recentPulls, setRecentPulls] = useState<PullSummary[]>([])

	const fetchRecent = useCallback(async () => {
		try {
			const res = await fetch("/api/pulls")
			if (res.ok) setRecentPulls((await res.json()) as PullSummary[])
		} catch {}
	}, [])

	useEffect(() => {
		fetchRecent()
	}, [fetchRecent])

	const getHostname = () => {
		try {
			let u = url.trim()
			if (!u) return ""
			if (!/^https?:\/\//i.test(u)) u = `https://${u}`
			return new URL(u).hostname
		} catch {
			return ""
		}
	}

	const normalizedUrl = (() => {
		try {
			let u = url.trim()
			if (!/^https?:\/\//i.test(u)) u = `https://${u}`
			return u
		} catch {
			return url.trim()
		}
	})()

	const handleStart = async () => {
		if (!url.trim()) return
		setLoading(true)
		setError("")
		try {
			const res = await fetch("/api/pull", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					url: normalizedUrl,
					outDir: outDir || undefined,
					maxPages,
					workerCount: workerCount || undefined,
				}),
			})
			const data = (await res.json()) as any
			if (res.ok) {
				navigate(`/pull/${data.pullId}`)
			} else {
				setError(data.error || "Failed to start pull")
			}
		} catch (e) {
			setError(String(e))
		} finally {
			setLoading(false)
		}
	}

	const hostname = getHostname()

	return (
		<div className="home-page">
			<h1>Pull documentation</h1>
			<p className="subtitle">Download any public docs site as local markdown files.</p>

			<div className="url-bar">
				<input
					type="text"
					placeholder="Paste a docs URL…"
					value={url}
					onChange={(e) => setUrl((e.target as HTMLInputElement).value)}
					onKeyDown={(e) => e.key === "Enter" && handleStart()}
				/>
				<button type="button" className="btn btn-primary" onClick={handleStart} disabled={loading || !url.trim()}>
					{loading ? <span className="spinner" /> : "Pull"}
				</button>
			</div>

			{hostname && <div className="url-preview">Output: ./{hostname}/</div>}

			<div className="config-section">
				<div className="config-section-label">Options</div>
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
					<div className="config-field">
						<span className="field-label">Max pages</span>
						<div className="range-row">
							<input
								type="range"
								min={10}
								max={2000}
								step={10}
								value={maxPages}
								onChange={(e) => setMaxPages(parseInt((e.target as HTMLInputElement).value, 10))}
							/>
							<span>{maxPages}</span>
						</div>
					</div>
				</div>
				<div className="config-row" style={{ marginTop: "12px" }}>
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
					<div />
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
								<span className="pull-row-url">{pull.url}</span>
								<span className="pull-row-meta">
									<span className={`status-badge status-${pull.status}`}>
										<span>{STATUS_ICON[pull.status] ?? "?"}</span>
										{pull.status}
									</span>
								</span>
								<span className="pull-row-meta">{pull.pages_ok > 0 ? `${pull.pages_ok} pages` : "—"}</span>
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
