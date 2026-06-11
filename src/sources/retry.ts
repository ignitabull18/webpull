import { Effect, Schedule } from "effect"

/**
 * Retry an effect with exponential backoff for transient CLI failures.
 * Retries up to 3 times with delays of 1s, 2s, 4s.
 */
export function withRetry<E extends Error, A>(effect: Effect.Effect<A, E>, label?: string): Effect.Effect<A, E> {
	const policy = Schedule.addDelay(Schedule.recurs(2), (i: number) => 1000 * 2 ** i)

	return Effect.retry(effect, policy).pipe(
		Effect.catchAll((e) => {
			if (label) {
				console.error(`[retry] ${label}: exhausted retries — ${String(e).slice(0, 120)}`)
			}
			return Effect.fail(e)
		}),
	)
}

/**
 * Run an effect and return null on failure instead of propagating.
 */
export function optional<E extends Error, A>(
	effect: Effect.Effect<A, E>,
	label?: string,
): Effect.Effect<A | null, never> {
	return Effect.either(effect).pipe(
		Effect.map((result) => {
			if (result._tag === "Left") {
				if (label) {
					console.error(`[optional] ${label}: ${String(result.left).slice(0, 120)}`)
				}
				return null
			}
			return result.right
		}),
	)
}
