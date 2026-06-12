import { useCallback, useEffect, useRef } from "react"

export interface PullEvent {
	pullId: string
	event: {
		type: "start" | "progress" | "discover" | "complete" | "error"
		total?: number
		workerCount?: number
		urls?: string[]
		index?: number
		url?: string
		status?: "ok" | "err"
		title?: string
		content?: string
		file?: string
		ok?: number
		err?: number
		elapsed?: number
		message?: string
	}
}

export function useWebSocket(onEvent: (event: PullEvent) => void) {
	const wsRef = useRef<WebSocket | null>(null)
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const shouldReconnectRef = useRef(true)
	const onEventRef = useRef(onEvent)
	onEventRef.current = onEvent

	const connect = useCallback(() => {
		if (!shouldReconnectRef.current) return
		const proto = globalThis.location.protocol === "https:" ? "wss:" : "ws:"
		const ws = new WebSocket(`${proto}//${globalThis.location.host}/ws`)

		ws.onmessage = (msg) => {
			try {
				const data = JSON.parse(msg.data) as PullEvent
				onEventRef.current(data)
			} catch {}
		}

		ws.onclose = () => {
			if (!shouldReconnectRef.current) return
			reconnectTimerRef.current = setTimeout(connect, 2000)
		}

		wsRef.current = ws
	}, [])

	useEffect(() => {
		shouldReconnectRef.current = true
		let cancelled = false

		const maybeConnect = async () => {
			try {
				const res = await fetch("/api/health", { cache: "no-store" })
				const health = (await res.json()) as { runtime?: string }
				if (cancelled || health.runtime === "cloudflare") return
			} catch {}
			if (!cancelled) connect()
		}

		maybeConnect()
		return () => {
			cancelled = true
			shouldReconnectRef.current = false
			if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
			wsRef.current?.close()
		}
	}, [connect])

	return wsRef
}
