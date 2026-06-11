import { useCallback, useEffect, useState } from "react"
import ReactMarkdown from "react-markdown"
import { useNavigate } from "react-router-dom"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism"
import remarkGfm from "remark-gfm"

interface Project {
	id: string
	name: string
	description: string
	created_at: string
	updated_at: string
	docCount: number
}

interface PullSummary {
	id: string
	url: string
	source: string
	status: string
	pages_ok: number
	pages_err: number
	started_at: string
	project_id: string | null
}

interface DocRow {
	id: number
	pull_id: string
	path: string
	url: string
	title: string
	content: string
}

// File tree node
interface TreeNode {
	pull: PullSummary
	docs: DocRow[]
	expanded: boolean
}

export default function Projects() {
	const navigate = useNavigate()
	const [projects, setProjects] = useState<Project[]>([])
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [treeNodes, setTreeNodes] = useState<TreeNode[]>([])
	const [treeLoading, setTreeLoading] = useState(false)

	// File content viewer
	const [selectedDoc, setSelectedDoc] = useState<DocRow | null>(null)
	const [docLoading, setDocLoading] = useState(false)

	// Project CRUD
	const [creating, setCreating] = useState(false)
	const [newName, setNewName] = useState("")
	const [editingId, setEditingId] = useState<string | null>(null)
	const [editName, setEditName] = useState("")
	const [error, setError] = useState("")

	const fetchProjects = useCallback(async () => {
		try {
			const res = await fetch("/api/projects")
			if (res.ok) setProjects((await res.json()) as Project[])
		} catch {}
	}, [])

	useEffect(() => {
		fetchProjects()
	}, [fetchProjects])

	const fetchTree = useCallback(async (projectId: string) => {
		setTreeLoading(true)
		setTreeNodes([])
		setSelectedDoc(null)
		try {
			const [pullsRes, docsRes] = await Promise.all([
				fetch(`/api/projects/${projectId}?pulls=1`),
				fetch(`/api/projects/${projectId}?docs=1`),
			])
			const pulls = pullsRes.ok ? ((await pullsRes.json()) as PullSummary[]) : []
			const docs = docsRes.ok ? ((await docsRes.json()) as DocRow[]) : []

			// Group docs by pull_id
			const docsByPull: Record<string, DocRow[]> = {}
			for (const doc of docs) {
				if (!docsByPull[doc.pull_id]) docsByPull[doc.pull_id] = []
				docsByPull[doc.pull_id]!.push(doc)
			}

			// Build tree nodes: each pull is a folder, containing its docs
			const nodes: TreeNode[] = pulls.map((pull) => ({
				pull,
				docs: docsByPull[pull.id] || [],
				expanded: pulls.length <= 3, // auto-expand if few pulls
			}))

			// Also include any docs whose pull isn't in the pull list (orphaned)
			const pullIds = new Set(pulls.map((p) => p.id))
			const orphanDocs = docs.filter((d) => !pullIds.has(d.pull_id))
			if (orphanDocs.length > 0) {
				nodes.push({
					pull: {
						id: "__orphan__",
						url: "Orphaned documents",
						source: "",
						status: "complete",
						pages_ok: orphanDocs.length,
						pages_err: 0,
						started_at: "",
						project_id: projectId,
					},
					docs: orphanDocs,
					expanded: true,
				})
			}

			setTreeNodes(nodes)
		} catch {
		} finally {
			setTreeLoading(false)
		}
	}, [])

	const handleSelect = (id: string) => {
		setSelectedId(id)
		fetchTree(id)
	}

	const handleToggleExpand = (index: number) => {
		setTreeNodes((prev) => prev.map((n, i) => (i === index ? { ...n, expanded: !n.expanded } : n)))
	}

	const handleDocClick = async (docId: number) => {
		setDocLoading(true)
		setSelectedDoc(null)
		try {
			const res = await fetch(`/api/docs/${docId}`)
			if (res.ok) {
				setSelectedDoc((await res.json()) as DocRow)
			}
		} catch {
		} finally {
			setDocLoading(false)
		}
	}

	const handleCreate = async () => {
		const name = newName.trim()
		if (!name) return
		setError("")
		try {
			const res = await fetch("/api/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name }),
			})
			if (res.ok) {
				setCreating(false)
				setNewName("")
				await fetchProjects()
			} else {
				const data = await res.json().catch(() => ({}))
				setError(data.error || `Failed to create project (${res.status})`)
			}
		} catch (e) {
			setError(`Connection error: ${e}`)
		}
	}

	const handleRename = async (id: string) => {
		const name = editName.trim()
		if (!name) return
		try {
			await fetch(`/api/projects/${id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name }),
			})
			setEditingId(null)
			setEditName("")
			await fetchProjects()
		} catch {}
	}

	const handleDelete = async (id: string) => {
		if (!confirm("Delete this project? Pulls will be unlinked, files on disk are kept.")) return
		try {
			await fetch(`/api/projects/${id}`, { method: "DELETE" })
			if (selectedId === id) {
				setSelectedId(null)
				setTreeNodes([])
				setSelectedDoc(null)
			}
			await fetchProjects()
		} catch {}
	}

	const selectedProject = projects.find((p) => p.id === selectedId)

	const formatDate = (ts: string) => {
		try {
			return new Date(ts).toLocaleDateString()
		} catch {
			return ts
		}
	}

	const statusIcon = (s: string) => {
		if (s === "complete") return "✓"
		if (s === "failed") return "✕"
		return "○"
	}

	const totalDocs = treeNodes.reduce((sum, n) => sum + n.docs.length, 0)
	const totalPulls = treeNodes.filter((n) => n.pull.id !== "__orphan__").length

	return (
		<div className="results-shell">
			{/* Sidebar: project list */}
			<div className="results-sidebar">
				<div className="results-sidebar-header" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
					<h3 style={{ margin: 0, fontSize: "13px", fontWeight: 600 }}>Projects</h3>

					{!creating && (
						<button
							type="button"
							className="btn btn-ghost btn-small"
							onClick={() => {
								setCreating(true)
								setError("")
							}}
						>
							+ New project
						</button>
					)}

					{creating && (
						<div style={{ display: "flex", gap: "4px" }}>
							<input
								type="text"
								className="search-input"
								placeholder="Project name…"
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleCreate()
									if (e.key === "Escape") setCreating(false)
								}}
							/>
							<button type="button" className="btn btn-ghost btn-small" onClick={handleCreate}>
								Create
							</button>
							<button type="button" className="btn btn-ghost btn-small" onClick={() => setCreating(false)}>
								✕
							</button>
						</div>
					)}
					{error && (
						<div className="error-msg" style={{ margin: "4px 0 0" }}>
							{error}
						</div>
					)}
				</div>

				<div className="results-sidebar-header" style={{ paddingTop: 0 }}>
					{projects.length === 0 && (
						<p style={{ color: "var(--subtle)", fontSize: "12px", padding: "0 8px" }}>
							No projects yet. Create one to organize your pulls.
						</p>
					)}
					{projects.map((proj) => (
						<div key={proj.id} style={{ marginBottom: "2px" }}>
							{editingId === proj.id ? (
								<div style={{ display: "flex", gap: "4px", padding: "0 8px" }}>
									<input
										type="text"
										className="search-input"
										value={editName}
										onChange={(e) => setEditName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleRename(proj.id)
											if (e.key === "Escape") setEditingId(null)
										}}
										style={{ flex: 1 }}
									/>
									<button type="button" className="btn btn-ghost btn-small" onClick={() => handleRename(proj.id)}>
										✓
									</button>
									<button type="button" className="btn btn-ghost btn-small" onClick={() => setEditingId(null)}>
										✕
									</button>
								</div>
							) : (
								<div
									className={`tree-item ${selectedId === proj.id ? "active" : ""}`}
									style={{ display: "flex", alignItems: "center", gap: "8px" }}
								>
									<button
										type="button"
										style={{
											all: "unset",
											flex: 1,
											cursor: "pointer",
											display: "flex",
											alignItems: "center",
											gap: "6px",
											fontSize: "13px",
										}}
										onClick={() => handleSelect(proj.id)}
									>
										<span style={{ opacity: 0.6 }}>📁</span>
										<span style={{ fontWeight: selectedId === proj.id ? 600 : 400 }}>{proj.name}</span>
										<span style={{ color: "var(--subtle)", fontSize: "11px", marginLeft: "auto" }}>
											{proj.docCount}
										</span>
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-small"
										style={{ padding: "0 4px", fontSize: "10px", flexShrink: 0 }}
										onClick={(e) => {
											e.stopPropagation()
											setEditingId(proj.id)
											setEditName(proj.name)
										}}
									>
										✎
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-small"
										style={{ padding: "0 4px", fontSize: "10px", flexShrink: 0 }}
										onClick={(e) => {
											e.stopPropagation()
											handleDelete(proj.id)
										}}
									>
										✕
									</button>
								</div>
							)}
						</div>
					))}
				</div>

				{/* File tree within selected project */}
				{selectedProject && !treeLoading && treeNodes.length > 0 && (
					<div className="results-sidebar-header" style={{ borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
						<div style={{ fontSize: "11px", color: "var(--subtle)", padding: "0 8px 6px", fontWeight: 600 }}>
							{totalPulls} pulls · {totalDocs} files
						</div>
						{treeNodes.map((node, i) => (
							<div key={node.pull.id} style={{ marginBottom: "2px" }}>
								{/* Pull folder */}
								<button
									type="button"
									className="tree-item folder"
									style={{ fontSize: "12px", paddingLeft: "8px" }}
									onClick={() => handleToggleExpand(i)}
								>
									<span style={{ marginRight: "4px", width: "12px", display: "inline-block", textAlign: "center" }}>
										{node.expanded ? "▾" : "▸"}
									</span>
									{node.pull.id === "__orphan__" ? (
										<span>📄 Orphaned ({node.docs.length})</span>
									) : (
										<span>
											{node.pull.source ? `[${node.pull.source}] ` : ""}
											{node.pull.url.length > 30 ? `${node.pull.url.slice(0, 30)}…` : node.pull.url}{" "}
											<span style={{ color: "var(--subtle)", fontSize: "10px" }}>({node.docs.length})</span>
										</span>
									)}
								</button>
								{/* Docs inside pull */}
								{node.expanded &&
									node.docs.map((doc) => (
										<button
											key={doc.id}
											type="button"
											className={`tree-item ${selectedDoc?.id === doc.id ? "active" : ""}`}
											style={{
												fontSize: "12px",
												paddingLeft: "32px",
												display: "block",
												width: "100%",
												textAlign: "left",
											}}
											onClick={() => handleDocClick(doc.id)}
										>
											<span style={{ marginRight: "4px", opacity: 0.5 }}>📝</span>
											{doc.title || doc.path.split("/").pop() || doc.path}
										</button>
									))}
							</div>
						))}
					</div>
				)}
			</div>

			{/* Main area */}
			<div className="results-main">
				{!selectedProject && (
					<div className="empty-state" style={{ padding: "48px" }}>
						<h3>File Explorer</h3>
						<p>
							Select a project from the sidebar to browse its files. Projects act as folders, containing pulls
							(sub-folders) and their documents (files).
						</p>
						<p style={{ color: "var(--subtle)", fontSize: "13px", marginTop: "16px" }}>
							Use the Pull tab to pull new content into a project, then browse it here.
						</p>
					</div>
				)}

				{selectedProject && (
					<>
						{/* Header */}
						<div
							style={{
								padding: "16px 20px",
								borderBottom: "1px solid var(--border)",
								display: "flex",
								alignItems: "center",
								gap: "12px",
								flexWrap: "wrap",
							}}
						>
							<h2 style={{ margin: 0, fontSize: "18px" }}>📁 {selectedProject.name}</h2>
							<span style={{ color: "var(--subtle)", fontSize: "13px" }}>
								{selectedProject.docCount} docs · created {formatDate(selectedProject.created_at)}
							</span>
							{selectedDoc && (
								<span style={{ color: "var(--subtle)", fontSize: "12px", marginLeft: "auto" }}>
									Viewing: {selectedDoc.title || selectedDoc.path}
								</span>
							)}
						</div>

						{/* Loading state */}
						{treeLoading && (
							<div className="empty-state" style={{ padding: "32px" }}>
								<span className="spinner" /> Loading files…
							</div>
						)}

						{/* Empty state */}
						{!treeLoading && treeNodes.length === 0 && (
							<div className="empty-state" style={{ padding: "32px" }}>
								<p>No files in this project yet.</p>
								<p style={{ color: "var(--subtle)", fontSize: "13px" }}>
									Go to the Pull tab, select this project in the dropdown, and pull some content.
								</p>
							</div>
						)}

						{/* File content viewer */}
						{!treeLoading && selectedDoc && (
							<div style={{ padding: "24px 20px", maxWidth: "860px" }}>
								<div style={{ marginBottom: "16px", display: "flex", alignItems: "center", gap: "12px" }}>
									<a
										href={selectedDoc.url}
										target="_blank"
										rel="noreferrer"
										style={{ color: "var(--accent)", fontSize: "12px", textDecoration: "none" }}
									>
										↗ Source
									</a>
									<span style={{ color: "var(--subtle)", fontSize: "11px" }}>{selectedDoc.path}</span>
								</div>
								<div className="markdown-body" style={{ maxHeight: "calc(100vh - 220px)", overflowY: "auto" }}>
									<ReactMarkdown
										remarkPlugins={[remarkGfm]}
										components={{
											code({ className, children, ...props }) {
												const match = /language-(\w+)/.exec(className || "")
												const codeStr = String(children).replace(/\n$/, "")
												const nodeProps = props as Record<string, unknown>
												if (match && !(nodeProps.inline as boolean)) {
													return (
														<SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div">
															{codeStr}
														</SyntaxHighlighter>
													)
												}
												return (
													<code className={className} {...props}>
														{children}
													</code>
												)
											},
										}}
									>
										{selectedDoc.content}
									</ReactMarkdown>
								</div>
							</div>
						)}

						{/* Doc loading indicator */}
						{docLoading && (
							<div className="empty-state" style={{ padding: "32px" }}>
								<span className="spinner" /> Loading document…
							</div>
						)}

						{/* Grid view when no doc selected */}
						{!treeLoading && !selectedDoc && !docLoading && treeNodes.length > 0 && (
							<div style={{ padding: "20px" }}>
								<div
									style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "12px" }}
								>
									{treeNodes.map((node) => (
										<div
											key={node.pull.id}
											style={{
												background: "var(--bg-alt)",
												border: "1px solid var(--border)",
												borderRadius: "6px",
												padding: "16px",
											}}
										>
											<div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "4px", wordBreak: "break-all" }}>
												{node.pull.source && (
													<span
														style={{
															fontSize: "10px",
															padding: "1px 5px",
															borderRadius: "3px",
															background: "var(--bg-hover)",
															marginRight: "6px",
															color: "var(--subtle)",
														}}
													>
														{node.pull.source}
													</span>
												)}
												{node.pull.id === "__orphan__"
													? "Orphaned documents"
													: node.pull.url.length > 40
														? `${node.pull.url.slice(0, 40)}…`
														: node.pull.url}
											</div>
											<div style={{ fontSize: "11px", color: "var(--subtle)" }}>
												{statusIcon(node.pull.status)} {node.docs.length} file{node.docs.length !== 1 ? "s" : ""}
												{node.pull.id !== "__orphan__" && (
													<button
														type="button"
														className="btn btn-ghost btn-small"
														style={{ marginLeft: "8px", fontSize: "10px" }}
														onClick={() =>
															navigate(
																node.pull.status === "complete" ? `/results/${node.pull.id}` : `/pull/${node.pull.id}`,
															)
														}
													>
														Open pull →
													</button>
												)}
											</div>
											{node.docs.slice(0, 5).map((doc) => (
												<div key={doc.id} style={{ marginTop: "6px", fontSize: "12px" }}>
													<button
														type="button"
														style={{
															all: "unset",
															cursor: "pointer",
															color: "var(--accent)",
															display: "block",
															width: "100%",
															overflow: "hidden",
															textOverflow: "ellipsis",
															whiteSpace: "nowrap",
														}}
														onClick={() => handleDocClick(doc.id)}
													>
														📝 {doc.title || doc.path.split("/").pop()}
													</button>
												</div>
											))}
											{node.docs.length > 5 && (
												<div style={{ marginTop: "6px", fontSize: "11px", color: "var(--subtle)" }}>
													+ {node.docs.length - 5} more files
												</div>
											)}
										</div>
									))}
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	)
}
