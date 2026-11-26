const PI_TRANSPORT_FETCH_SYMBOL = Symbol.for("pi.transportFetch");

/**
 * Tag a Pi-owned transport `fetch` wrapper (e.g. per-session Undici dispatcher) so adapters
 * and request builders can distinguish it from a caller-supplied custom `fetch`.
 */
export function markTransportFetch<T extends typeof globalThis.fetch>(fetchFn: T): T {
	Object.defineProperty(fetchFn, PI_TRANSPORT_FETCH_SYMBOL, { value: true });
	return fetchFn;
}

/** Returns true when `fetchFn` was tagged by {@link markTransportFetch}. */
export function isTransportFetch(fetchFn: unknown): boolean {
	return (
		typeof fetchFn === "function" &&
		Boolean((fetchFn as unknown as Record<symbol, unknown>)[PI_TRANSPORT_FETCH_SYMBOL])
	);
}
