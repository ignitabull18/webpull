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
	const onEventRef = useRef(onEvent)
	onEventRef.current = onEvent

	const connect = useCallback(() => {
		const proto = globalThis.location.protocol === "https:" ? "wss:" : "ws:"
		const ws = new WebSocket(`${proto}//${globalThis.location.host}/ws`)

		ws.onmessage = (msg) => {
			try {
				const data = JSON.parse(msg.data) as PullEvent
				onEventRef.current(data)
			} catch {}
		}

		ws.onclose = () => {
			setTimeout(connect, 2000)
		}

		wsRef.current = ws
	}, [])

	useEffect(() => {
		connect()
		return () => wsRef.current?.close()
	}, [connect])

	return wsRef
}
