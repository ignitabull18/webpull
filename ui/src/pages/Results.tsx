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
	const [pull, setPull] = useState<PullInfo | null>(null)
	const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null)
	const [searchQuery, setSearchQuery] = useState("")
	const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
	const [loading, setLoading] = useState(true)

	useEffect(() => {
		async function load() {
			try {
				const [pullRes, docsRes] = await Promise.all([
					fetch(`/api/pulls/${pullId}`),
					fetch(`/api/pulls/${pullId}/docs`),
				])
				if (pullRes.ok) setPull((await pullRes.json()) as PullInfo)
				if (docsRes.ok) {
					const docsData = (await docsRes.json()) as Doc[]
					setDocs(docsData)
					if (docsData.length > 0) setSelectedDoc(docsData[0]!)
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
			const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&pullId=${pullId}`)
			if (res.ok) setSearchResults((await res.json()) as SearchResult[])
		} catch {}
	}, [searchQuery, pullId])

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
					{pull?.status === "complete" && (
						<button
							type="button"
							className="btn btn-ghost btn-small"
							onClick={() => {
								const a = document.createElement("a")
								a.href = `/api/pulls/${pullId}/export`
								a.download = ""
								a.click()
							}}
						>
							Download ZIP
						</button>
					)}
				</div>
				<div className="results-sidebar-header">
					<input
						type="text"
						placeholder="Filter docs…"
						value={searchQuery}
						onChange={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
					/>
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
