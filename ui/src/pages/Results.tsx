import React, { useCallback, useEffect, useMemo, useState } from "react"
import ReactMarkdown from "react-markdown"
import { useNavigate, useParams } from "react-router-dom"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism"
import remarkGfm from "remark-gfm"

interface Doc {
	id: number
	pull_id: string
	path: string
	url: string
	title: string
	content: string
}

interface PullInfo {
	url: string
	status: string
	pages_ok: number
	pages_err: number
	out_dir: string
}

interface PageFailure {
	url: string
	reason: string
	created_at: string
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

type SearchMode = "keyword" | "semantic" | "hybrid"

interface AskResponse {
	answer?: string
	citations?: { title?: string; path?: string; url?: string }[]
	error?: string
}

interface ArtifactResponse {
	id?: string
	status?: string
	repo_url?: string
	manifest_key?: string
	error?: string
}

interface KnowledgeBucket {
	id: string
	name: string
	itemCount?: number
}

interface TreeNode {
	name: string
	path: string
	isFolder: boolean
	children: TreeNode[]
	doc?: Doc
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

export default function Results() {
	const { pullId } = useParams<{ pullId: string }>()
	const navigate = useNavigate()
	const [docs, setDocs] = useState<Doc[]>([])
	const [failures, setFailures] = useState<PageFailure[]>([])
	const [pull, setPull] = useState<PullInfo | null>(null)
	const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null)
	const [searchQuery, setSearchQuery] = useState("")
	const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
	const [loading, setLoading] = useState(true)
	const [pushing, setPushing] = useState(false)
	const [pushError, setPushError] = useState("")
	const [pushOk, setPushOk] = useState(false)
	const [pushFiles, setPushFiles] = useState<{ path: string; url: string }[]>([])
	const [searchMode, setSearchMode] = useState<SearchMode>("hybrid")
	const [askQuestion, setAskQuestion] = useState("")
	const [asking, setAsking] = useState(false)
	const [askResponse, setAskResponse] = useState<AskResponse | null>(null)
	const [askError, setAskError] = useState("")
	const [publishingArtifact, setPublishingArtifact] = useState(false)
	const [artifactResult, setArtifactResult] = useState<ArtifactResponse | null>(null)
	const [artifactError, setArtifactError] = useState("")
	const [knowledgeBuckets, setKnowledgeBuckets] = useState<KnowledgeBucket[]>([])
	const [knowledgeBucketId, setKnowledgeBucketId] = useState("")
	const [knowledgeBusy, setKnowledgeBusy] = useState(false)
	const [knowledgeMessage, setKnowledgeMessage] = useState("")
	const [knowledgeError, setKnowledgeError] = useState("")

	useEffect(() => {
		async function load() {
			try {
				const [pullRes, docsRes, failuresRes, bucketsRes] = await Promise.all([
					fetch(`/api/pulls/${pullId}`),
					fetch(`/api/pulls/${pullId}/docs`),
					fetch(`/api/pulls/${pullId}/failures`),
					fetch("/api/knowledge-buckets"),
				])
				if (pullRes.ok) setPull((await pullRes.json()) as PullInfo)
				if (docsRes.ok) {
					const docsData = (await docsRes.json()) as Doc[]
					setDocs(docsData)
					if (docsData.length > 0) setSelectedDoc(docsData[0]!)
				}
				if (failuresRes.ok) setFailures((await failuresRes.json()) as PageFailure[])
				if (bucketsRes.ok) {
					const bucketData = (await bucketsRes.json()) as { buckets?: KnowledgeBucket[] }
					const buckets = bucketData.buckets || []
					setKnowledgeBuckets(buckets)
					setKnowledgeBucketId((current) => current || buckets[0]?.id || "")
				}
			} catch {
			} finally {
				setLoading(false)
			}
		}
		load()
	}, [pullId])

	const handleSearch = useCallback(async () => {
		if (!searchQuery.trim()) {
			setSearchResults(null)
			return
		}
		try {
			const params = new URLSearchParams({
				q: searchQuery,
				mode: searchMode,
				pullId: pullId || "",
			})
			const res = await fetch(`/api/search?${params.toString()}`)
			if (res.ok) setSearchResults((await res.json()) as SearchResult[])
		} catch {}
	}, [searchQuery, pullId, searchMode])

	useEffect(() => {
		const timer = setTimeout(handleSearch, 300)
		return () => clearTimeout(timer)
	}, [handleSearch])

	const tree = useMemo(() => buildTree(docs), [docs])

	const renderTree = (nodes: TreeNode[], depth = 0) => {
		return nodes.map((node) => (
			<React.Fragment key={node.path}>
				<button
					type="button"
					className={`tree-item ${node.isFolder ? "folder" : ""} ${selectedDoc?.path === node.path ? "active" : ""}`}
					style={{ paddingLeft: `${12 + depth * 10}px` }}
					onClick={() => {
						if (node.doc) setSelectedDoc(node.doc)
					}}
				>
					{node.isFolder ? "▸ " : ""}
					{node.name}
				</button>
				{renderTree(node.children, depth + 1)}
			</React.Fragment>
		))
	}

	if (loading) {
		return (
			<div className="empty-state" style={{ padding: "48px" }}>
				<span className="spinner" /> Loading…
			</div>
		)
	}

	const downloadExport = (format: "markdown" | "json") => {
		const a = document.createElement("a")
		a.href = `/api/pulls/${pullId}/export?format=${format}`
		a.download = ""
		a.click()
	}

	const handlePushToR2 = async () => {
		setPushing(true)
		setPushError("")
		setPushOk(false)
		setPushFiles([])
		try {
			const res = await fetch("/api/destination/push", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ pullId, destination: "r2" }),
			})
			const data = (await res.json()) as any
			if (res.ok && data.ok > 0) {
				setPushOk(true)
				setPushFiles(data.files || [])
			} else {
				setPushError(data.error || data.files?.[0]?.error || "Push failed")
			}
		} catch (e) {
			setPushError(String(e))
		} finally {
			setPushing(false)
		}
	}

	const handleAsk = async () => {
		if (!askQuestion.trim()) return
		setAsking(true)
		setAskError("")
		setAskResponse(null)
		try {
			const body = JSON.stringify({ pullId, question: askQuestion, mode: searchMode })
			for (const endpoint of [`/api/pulls/${pullId}/ask`, "/api/ask"]) {
				const res = await fetch(endpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				})
				const data = (await res.json().catch(() => ({}))) as AskResponse
				if (res.ok) {
					setAskResponse(data)
					return
				}
				if (res.status !== 404 && res.status !== 405) {
					setAskError(data.error || "Ask is not available for this pull yet.")
					return
				}
			}
			setAskError("Ask is not available for this pull yet.")
		} catch (e) {
			setAskError(String(e))
		} finally {
			setAsking(false)
		}
	}

	const handlePublishArtifact = async () => {
		setPublishingArtifact(true)
		setArtifactError("")
		setArtifactResult(null)
		try {
			const body = JSON.stringify({ pullId })
			for (const endpoint of [`/api/pulls/${pullId}/artifact`, "/api/artifact/publish"]) {
				const res = await fetch(endpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				})
				const data = (await res.json().catch(() => ({}))) as ArtifactResponse
				if (res.ok) {
					setArtifactResult(data)
					return
				}
				if (res.status !== 404 && res.status !== 405) {
					setArtifactError(data.error || "Artifact publishing is not available yet.")
					return
				}
			}
			setArtifactError("Artifact publishing is not available yet.")
		} catch (e) {
			setArtifactError(String(e))
		} finally {
			setPublishingArtifact(false)
		}
	}

	const handleAddToKnowledge = async () => {
		if (!knowledgeBucketId) return
		setKnowledgeBusy(true)
		setKnowledgeError("")
		setKnowledgeMessage("")
		try {
			const res = await fetch(`/api/knowledge-buckets/${encodeURIComponent(knowledgeBucketId)}/add-pull`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ pullId }),
			})
			const data = (await res.json().catch(() => ({}))) as { uploaded?: number; total?: number; error?: string }
			if (!res.ok) {
				setKnowledgeError(data.error || "Knowledge bucket update failed.")
				return
			}
			setKnowledgeMessage(`Added ${data.uploaded || 0} of ${data.total || 0} documents.`)
		} catch (caught) {
			setKnowledgeError(String(caught))
		} finally {
			setKnowledgeBusy(false)
		}
	}

	const hostname = pull?.url
		? (() => {
				try {
					return new URL(pull.url).hostname
				} catch {
					return pull.url
				}
			})()
		: "Results"

	return (
		<div className="results-shell">
			<div className="results-sidebar">
				<div className="results-toolbar">
					<h3>{hostname}</h3>
					{(pull?.status === "complete" || pull?.status === "partial") && (
						<button type="button" className="btn btn-ghost btn-small" onClick={() => downloadExport("markdown")}>
							Download MD
						</button>
					)}
					{(pull?.status === "complete" || pull?.status === "partial") && (
						<button type="button" className="btn btn-ghost btn-small" onClick={() => downloadExport("json")}>
							Download JSON
						</button>
					)}
					{(pull?.status === "complete" || pull?.status === "partial") && (
						<button
							type="button"
							className="btn btn-ghost btn-small"
							onClick={handlePushToR2}
							disabled={pushing || pushOk}
							title="Publish all markdown files to Cloudflare R2"
						>
							{pushing ? <span className="spinner" /> : pushOk ? "✓ Published" : "Publish to R2"}
						</button>
					)}
					{(pull?.status === "complete" || pull?.status === "partial") && (
						<button
							type="button"
							className="btn btn-ghost btn-small"
							onClick={handlePublishArtifact}
							disabled={publishingArtifact || artifactResult?.status === "complete"}
							title="Publish a Cloudflare artifact export"
						>
							{publishingArtifact ? (
								<span className="spinner" />
							) : artifactResult ? (
								"Artifact queued"
							) : (
								"Publish Artifact"
							)}
						</button>
					)}
				</div>
				<div className="results-sidebar-header">
					{(pull?.status === "complete" || pull?.status === "partial") && (
						<div className="result-knowledge-box">
							<div className="result-knowledge-title">Knowledge Bucket</div>
							<div className="compact-control-row">
								<select
									value={knowledgeBucketId}
									onChange={(e) => setKnowledgeBucketId((e.target as HTMLSelectElement).value)}
								>
									<option value="">Select bucket</option>
									{knowledgeBuckets.map((bucket) => (
										<option key={bucket.id} value={bucket.id}>
											{bucket.name}
										</option>
									))}
								</select>
								<button
									type="button"
									className="btn btn-secondary btn-small"
									onClick={handleAddToKnowledge}
									disabled={knowledgeBusy || !knowledgeBucketId}
								>
									{knowledgeBusy ? <span className="spinner" /> : "Add"}
								</button>
							</div>
							{knowledgeMessage && <div className="success-msg result-inline-msg">{knowledgeMessage}</div>}
							{knowledgeError && <div className="error-msg result-inline-msg">{knowledgeError}</div>}
							{knowledgeBuckets.length === 0 && (
								<button type="button" className="btn btn-ghost btn-small" onClick={() => navigate("/knowledge")}>
									Create bucket
								</button>
							)}
						</div>
					)}
					<div className="compact-control-row">
						<label htmlFor="result-search-mode">Mode</label>
						<select
							id="result-search-mode"
							value={searchMode}
							onChange={(e) => setSearchMode((e.target as HTMLSelectElement).value as SearchMode)}
						>
							<option value="hybrid">Hybrid</option>
							<option value="semantic">Semantic</option>
							<option value="keyword">Keyword</option>
						</select>
					</div>
					<input
						type="text"
						placeholder="Filter docs…"
						value={searchQuery}
						onChange={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
					/>
					<div className="ask-control">
						<input
							type="text"
							placeholder="Ask this pull…"
							value={askQuestion}
							onChange={(e) => setAskQuestion((e.target as HTMLInputElement).value)}
							onKeyDown={(e) => e.key === "Enter" && handleAsk()}
						/>
						<button
							type="button"
							className="btn btn-ghost btn-small"
							onClick={handleAsk}
							disabled={asking || !askQuestion.trim()}
						>
							{asking ? <span className="spinner" /> : "Ask"}
						</button>
					</div>
				</div>
				<div className="results-tree">
					{searchResults ? (
						searchResults.length === 0 ? (
							<div className="empty-state" style={{ padding: "16px", fontSize: "12px" }}>
								No matches
							</div>
						) : (
							searchResults.map((sr) => (
								<button
									type="button"
									key={sr.id}
									className={`tree-item ${selectedDoc?.path === sr.path ? "active" : ""}`}
									onClick={() => {
										setSelectedDoc({
											id: sr.id,
											pull_id: sr.pull_id,
											path: sr.path,
											url: sr.url,
											title: sr.title,
											content: sr.content,
										})
									}}
								>
									{sr.title || sr.path}
									<span className="sub-path">{sr.path}</span>
								</button>
							))
						)
					) : (
						renderTree(tree)
					)}
				</div>
				<div className="results-sidebar-footer">
					{artifactError && (
						<div className="error-msg" style={{ marginBottom: "6px", fontSize: "11px" }}>
							{artifactError}
						</div>
					)}
					{artifactResult && (
						<div className="success-msg" style={{ marginBottom: "6px", fontSize: "11px" }}>
							Artifact {artifactResult.status || "queued"}
							{artifactResult.repo_url && (
								<a href={artifactResult.repo_url} target="_blank" rel="noreferrer">
									{" "}
									Open
								</a>
							)}
						</div>
					)}
					{pushError && (
						<div className="error-msg" style={{ marginBottom: "6px", fontSize: "11px" }}>
							{pushError}
						</div>
					)}
					{pushFiles.length > 0 && (
						<div className="success-msg" style={{ marginBottom: "6px", fontSize: "11px" }}>
							Published {pushFiles.length} files to R2
						</div>
					)}
					{failures.length > 0 && (
						<div className="error-msg" style={{ marginBottom: "6px", fontSize: "11px" }}>
							{failures.length} page{failures.length === 1 ? "" : "s"} failed. First: {failures[0]?.reason}
						</div>
					)}
					<button type="button" className="btn btn-ghost btn-small" onClick={() => navigate("/")}>
						← Back to pulls
					</button>
				</div>
			</div>

			<div className="results-preview">
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
						{(askResponse || askError) && (
							<div className="ask-answer-block">
								<div className="ask-answer-header">
									<span>Ask</span>
									<span>{searchMode}</span>
								</div>
								{askError ? (
									<div className="error-msg">{askError}</div>
								) : (
									<>
										<p>{askResponse?.answer || "No answer returned."}</p>
										{askResponse?.citations && askResponse.citations.length > 0 && (
											<div className="ask-citations">
												{askResponse.citations.slice(0, 4).map((citation) => (
													<span key={citation.path ?? citation.url ?? citation.title} className="ask-citation-badge">
														{citation.title || citation.path || citation.url}
													</span>
												))}
											</div>
										)}
									</>
								)}
							</div>
						)}
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
	)
}
