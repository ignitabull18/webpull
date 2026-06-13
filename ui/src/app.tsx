import { Route, Routes, useLocation, useNavigate } from "react-router-dom"
import Collector from "./pages/Collector"
import History from "./pages/History"
import Home from "./pages/Home"
import Knowledge from "./pages/Knowledge"
import Projects from "./pages/Projects"
import Pull from "./pages/Pull"
import Results from "./pages/Results"

const NAV_ITEMS = [
	{ path: "/", label: "Pull", icon: "↓" },
	{ path: "/collector", label: "Collector", icon: "↻" },
	{ path: "/knowledge", label: "Knowledge", icon: "◆" },
	{ path: "/projects", label: "Projects", icon: "📁" },
	{ path: "/history", label: "History", icon: "☰" },
]

export default function App() {
	const navigate = useNavigate()
	const location = useLocation()

	return (
		<div className="app-shell">
			<nav className="sidebar">
				<div className="sidebar-brand">
					<span className="sidebar-brand-dot" />
					<span>webpull</span>
				</div>
				<div className="sidebar-nav">
					{NAV_ITEMS.map((item) => (
						<button
							type="button"
							key={item.path}
							className={`sidebar-btn ${location.pathname === item.path || (item.path === "/" && location.pathname.startsWith("/pull")) || (item.path === "/projects" && location.pathname.startsWith("/projects")) ? "active" : ""}`}
							onClick={() => navigate(item.path)}
						>
							<span className="sidebar-icon">{item.icon}</span>
							<span>{item.label}</span>
						</button>
					))}
				</div>
			</nav>
			<main className="main-content">
				<Routes>
					<Route path="/" element={<Home />} />
					<Route path="/collector" element={<Collector />} />
					<Route path="/pull/:pullId" element={<Pull />} />
					<Route path="/results/:pullId" element={<Results />} />
					<Route path="/history" element={<History />} />
					<Route path="/knowledge" element={<Knowledge />} />
					<Route path="/projects" element={<Projects />} />
				</Routes>
			</main>
		</div>
	)
}
