// Daemon launcher: spawns the server as a detached process that survives the parent shell.
// Usage: bun run scripts/daemon.ts [port]
import { resolve } from "node:path"

const PORT = process.env.WEBPULL_PORT || "3456"
const ROOT = resolve(import.meta.dir, "..")
const LOG = process.env.WEBPULL_LOG || "/tmp/webpull-server.log"

const proc = Bun.spawn({
	cmd: [Bun.which("bun") || "bun", "run", "src/index.ts", "--server"],
	cwd: ROOT,
	env: { ...process.env, WEBPULL_PORT: PORT },
	stdio: ["ignore", Bun.file(LOG), Bun.file(LOG)],
	detached: true,
})

console.log(`Daemon PID: ${proc.pid}, port: ${PORT}`)
console.log(`Logs: ${LOG}`)
process.exit(0)
