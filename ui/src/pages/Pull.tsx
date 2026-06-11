import React, { useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { useNavigate, useParams } from "react-router-dom"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism"
import remarkGfm from "remark-gfm"
import { type PullEvent, useWebSocket } from "../hooks/useWebSocket"

interface Doc {
	path: string
	url: string
	title: string
	content: string
}

interface TreeNode {
	name: string
	path: string
	isFolder: boolean
	children: TreeNode[]
	doc?: Doc
}

interface PushResult {
	ok: number
	err: number
	files: { path: string; status: string; error?: string }[]
}

function buildTree(docs: Doc[]): TreeNode[] {
	const root: TreeNode[] = []
	for (const doc of docs) {
		const parts = doc.path.split("/")
		let current = root
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!
			const isLast = i === parts.length - 1
			let existing = current.find((n) => n.name === part)
			if (!existing) {
				existing = {
					name: part,
					path: parts.slice(0, i + 1).join("/"),
					isFolder: !isLast,
					children: [],
				}
				if (isLast) existing.doc = doc
				current.push(existing)
			}
			current = existing.children
		}
	}
	const sortNodes = (nodes: TreeNode[]) => {
		nodes.sort((a, b) => {
			if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
			return a.name.localeCompare(b.name)
		})
		for (const n of nodes) sortNodes(n.children)
	}
	sortNodes(root)
	return root
}

interface ProgressState {
	total: number
	ok: number
	err: number
	workerCount: number
	workerStates: ("idle" | "busy")[]
	recentFiles: string[]
	elapsed: number
	status: "discovering" | "running" | "complete" | "error"
	errorMsg?: string
	source?: string
}

export default function Pull() {
	const { pullId } = useParams<{ pullId: string }>()
	const navigate = useNavigate()
	const [state, setState] = useState<ProgressState>({
		total: 0,
		ok: 0,
		err: 0,
		workerCount: 16,
		workerStates: Array(16).fill("idle") as ("idle" | "busy")[],
		recentFiles: [],
		elapsed: 0,
		status: "discovering",
	})
	const [docMap, setDocMap] = useState<Record<string, Doc>>({})
	const [selectedPath, setSelectedPath] = useState<string | null>(null)
	const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

	// Destination push state
	const [pushing, setPushing] = useState(false)
	const [pushResult, setPushResult] = useState<PushResult | null>(null)
	const [pushError, setPushError] = useState("")
	const destIntent = useRef<any>(null)

	useEffect(() => {
		// Check for destination intent from sessionStorage
		try {
			const stored = sessionStorage.getItem(`webpull-dest-${pullId}`)
			if (stored) {
				destIntent.current = JSON.parse(stored)
			}
		} catch {}
	}, [pullId])

	useWebSocket((msg: PullEvent) => {
		if (msg.pullId !== pullId) return
		const ev = msg.event

		setState((s) => {
			switch (ev.type) {
				case "discover":
					return { ...s, total: ev.urls?.length ?? s.total }
				case "start": {
					const wc = ev.workerCount ?? s.workerCount
					const isSource = !!(ev as any).source
					return {
						...s,
						total: ev.total ?? s.total,
						workerCount: wc,
						workerStates: Array(wc).fill(isSource ? "idle" : "busy") as ("idle" | "busy")[],
						status: "running",
						source: (ev as any).source || s.source,
					}
				}
				case "progress": {
					const next = { ...s }
					next.ok = ev.ok ?? next.ok
					next.err = ev.err ?? next.err
					if ((ev as any).source) {
						next.workerStates = ["busy"]
					} else if (next.workerStates.length > 1) {
						const idx = (next.ok + next.err - 1) % next.workerStates.length
						if (idx >= 0) {
							next.workerStates = [...next.workerStates]
							next.workerStates[idx] = "idle"
						}
					}
					if (ev.status === "ok" && ev.file) {
						next.recentFiles = [...s.recentFiles.slice(-49), ev.file]
						setDocMap((prev) => {
							if (prev[ev.file!]) return prev
							const doc: Doc = {
								path: ev.file!,
								url: ev.url ?? "",
								title: ev.title ?? "",
								content: ev.content ?? "",
							}
							return { ...prev, [ev.file!]: doc }
						})
					}
					next.source = (ev as any).source || next.source
					return next
				}
				case "complete": {
					const nextState: ProgressState = {
						...s,
						ok: ev.ok ?? s.ok,
						err: ev.err ?? s.err,
						status: "complete",
						workerStates: Array(s.workerCount).fill("idle") as ("idle" | "busy")[],
						source: (ev as any).source || s.source,
					}
					// Auto-push to destination if intent is stored
					if (s.source && destIntent.current?.destination) {
						setTimeout(() => handlePush(), 500)
					}
					return nextState
				}
				case "error":
					return { ...s, status: "error", errorMsg: ev.message }
				default:
					return s
			}
		})
	})

	useEffect(() => {
		if (state.status === "complete" && !destIntent.current?.destination) {
			const t = setTimeout(() => navigate(`/results/${pullId}`), 1200)
			return () => clearTimeout(t)
		}
	}, [state.status, pullId, navigate])

	useEffect(() => {
		if (state.status !== "running" && state.status !== "discovering") return
		tickRef.current = setInterval(() => {
			setState((s) => ({ ...s, elapsed: s.elapsed + 0.1 }))
		}, 100)
		return () => {
			if (tickRef.current) clearInterval(tickRef.current)
		}
	}, [state.status])

	const handlePush = async () => {
		if (!destIntent.current || pushing) return
		setPushing(true)
		setPushError("")
		setPushResult(null)

		try {
			const res = await fetch("/api/destination/push", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					pullId,
					destination: destIntent.current.destination,
					source: destIntent.current.source,
					target: destIntent.current.destFolder || "root",
				}),
			})
			const data = (await res.json()) as any
			if (res.ok) {
				setPushResult(data as PushResult)
				// Clean up session storage
				try {
					sessionStorage.removeItem(`webpull-dest-${pullId}`)
				} catch {}
			} else {
				setPushError(data.error || "Push failed")
			}
		} catch (e) {
			setPushError(String(e))
		} finally {
			setPushing(false)
		}
	}

	const docs = useMemo(() => Object.values(docMap), [docMap])
	const tree = useMemo(() => buildTree(docs), [docs])
	const selectedDoc: Doc | null = selectedPath ? (docMap[selectedPath] ?? null) : null
	const workerDots = useMemo(
		() => state.workerStates.map((status, index) => ({ id: `worker-${index + 1}`, status })),
		[state.workerStates],
	)

	useEffect(() => {
		if (!selectedPath && docs.length > 0) {
			setSelectedPath(docs[0]!.path)
		}
	}, [docs, selectedPath])

	const pct = state.total > 0 ? Math.round(((state.ok + state.err) / state.total) * 100) : 0
	const pps = state.elapsed > 0 ? Math.round(state.ok / state.elapsed) : 0
	const eta = pps > 0 && state.total > 0 ? Math.round((state.total - state.ok - state.err) / pps) : 0

	const statusLabel =
		state.status === "discovering"
			? "Discovering…"
			: state.status === "running"
				? state.source
					? `Pulling ${state.source}…`
					: "Pulling…"
				: state.status === "complete"
					? "Complete"
					: "Failed"

	const renderTree = (nodes: TreeNode[], depth = 0) => {
		return nodes.map((node) => (
			<React.Fragment key={node.path}>
				<button
					type="button"
					className={`tree-item ${node.isFolder ? "folder" : ""} ${selectedPath === node.path ? "active" : ""}`}
					style={{ paddingLeft: `${12 + depth * 10}px` }}
					onClick={() => {
						if (node.doc) setSelectedPath(node.path)
					}}
				>
					{node.isFolder ? "▸ " : ""}
					{node.name}
				</button>
				{renderTree(node.children, depth + 1)}
			</React.Fragment>
		))
	}

	const isSource = !!state.source
	const showPush = isSource && state.status === "complete" && (destIntent.current?.destination || pushResult)

	return (
		<div className="pull-shell">
			{/* ── Left panel: progress ── */}
			<div className="pull-progress-panel">
				<div className="pull-header">
					{state.status === "running" || state.status === "discovering" ? (
						<span className="spinner" />
					) : state.status === "complete" ? (
						<span style={{ fontSize: "16px", color: "var(--green)" }}>✓</span>
					) : state.status === "error" ? (
						<span style={{ fontSize: "16px", color: "var(--red)" }}>✕</span>
					) : null}
					<h1>{statusLabel}</h1>
				</div>

				{state.source && <div className="pull-source-label">{state.source} source</div>}

				{state.errorMsg && <div className="error-msg">{state.errorMsg}</div>}

				{!isSource && (
					<div className="worker-strip">
						{workerDots.map((worker) => (
							<div key={worker.id} className={`worker-dot ${worker.status}`} />
						))}
					</div>
				)}

				{isSource && state.status === "running" && (
					<div className="source-progress-line">
						<div className="source-progress-bar-wrap">
							<div className="progress-bar-fill" style={{ width: `${pct}%` }} />
						</div>
						<span className="source-progress-count">
							{state.ok + state.err} / {state.total || "—"}
						</span>
					</div>
				)}

				{!isSource && (
					<div className="progress-bar-wrap">
						<div className="progress-bar-fill" style={{ width: `${pct}%` }} />
					</div>
				)}

				<div className="progress-stats">
					<span>
						<strong>{state.ok}</strong> ok
					</span>
					<span>
						<strong>{state.err}</strong> err
					</span>
					<span>
						<strong>{state.total || "—"}</strong> total
					</span>
					<span>
						<strong>{pps}</strong> p/s
					</span>
					{eta > 0 && (
						<span>
							~<strong>{eta}</strong>s left
						</span>
					)}
					<span>
						<strong>{state.elapsed.toFixed(1)}</strong>s
					</span>
				</div>

				{state.recentFiles.length > 0 && (
					<div className="file-stream">
						{state.recentFiles.map((f) => (
							<button
								type="button"
								key={f}
								className={`file-row ${selectedPath === f ? "active" : ""}`}
								onClick={() => setSelectedPath(f)}
							>
								<span className="check">✓</span>
								<span className="path">{f}</span>
							</button>
						))}
					</div>
				)}

				{/* Destination push section */}
				{showPush && (
					<div className="push-section">
						<div className="push-section-label">{pushResult ? "Push result" : "Push to Google Drive"}</div>

						{pushResult ? (
							<div>
								<div style={{ marginBottom: "8px" }}>
									<span className="status-badge status-complete" style={{ marginRight: "6px" }}>
										✓ {pushResult.ok} ok
									</span>
									{pushResult.err > 0 && <span className="status-badge status-failed">✕ {pushResult.err} err</span>}
								</div>
								{pushResult.files
									.filter((f) => f.status === "err")
									.slice(0, 5)
									.map((f) => (
										<div key={f.path} className="error-msg" style={{ marginBottom: "4px", fontSize: "11px" }}>
											{f.path}: {f.error ?? "unknown"}
										</div>
									))}
							</div>
						) : (
							<button type="button" className="btn btn-secondary" onClick={handlePush} disabled={pushing}>
								{pushing ? <span className="spinner" /> : "Push to Drive"}
							</button>
						)}

						{pushError && (
							<div className="error-msg" style={{ marginTop: "8px" }}>
								{pushError}
							</div>
						)}
					</div>
				)}

				{state.status === "error" && (
					<button
						type="button"
						className="btn btn-secondary"
						style={{ marginTop: "20px" }}
						onClick={() => navigate("/")}
					>
						← Back
					</button>
				)}

				{state.status === "complete" && (
					<button
						type="button"
						className="btn btn-secondary"
						style={{ marginTop: "20px" }}
						onClick={() => navigate(`/results/${pullId}`)}
					>
						View results →
					</button>
				)}
			</div>

			{/* ── Right panel: file tree + preview ── */}
			<div className="pull-preview-panel">
				{docs.length > 0 ? (
					<div className="pull-preview-layout">
						<div className="pull-preview-tree">{renderTree(tree)}</div>
						<div className="pull-preview-content">
							{selectedDoc ? (
								<>
									<div className="frontmatter-block">
										<div>
											<span className="fm-label">title:</span> <span className="fm-value">{selectedDoc.title}</span>
										</div>
										<div>
											<span className="fm-label">url:</span> <span className="fm-value">{selectedDoc.url}</span>
										</div>
									</div>
									<div className="markdown-body">
										<ReactMarkdown
											remarkPlugins={[remarkGfm]}
											components={{
												code({ className, children, ...props }: any) {
													const match = /language-(\w+)/.exec(className || "")
													const inline = !match && !String(children).includes("\n")
													if (inline) {
														return (
															<code className={className} {...props}>
																{children}
															</code>
														)
													}
													return (
														<SyntaxHighlighter style={oneDark} language={match?.[1] || "text"} PreTag="div">
															{String(children).replace(/\n$/, "")}
														</SyntaxHighlighter>
													)
												},
											}}
										>
											{selectedDoc.content}
										</ReactMarkdown>
									</div>
								</>
							) : (
								<div className="preview-empty">Select a file to preview</div>
							)}
						</div>
					</div>
				) : (
					<div className="preview-empty">
						{state.status === "discovering" ? "Discovering pages…" : "Waiting for files…"}
					</div>
				)}
			</div>
		</div>
	)
}
