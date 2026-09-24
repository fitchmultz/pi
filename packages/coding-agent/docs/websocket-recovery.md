# Codex WebSocket recovery

Keep `transport: "auto"` to prefer persistent WebSockets and incremental conversation requests.

After live steering, Pi sends the next request with full current input, including saved steering and tool results. That response establishes a new baseline for incremental requests on the same connection.

If the connection closes cleanly after the parent response finishes but before a successor starts, Pi keeps the completed response and continues unresolved steering on a fresh connection without showing a failed response. Saved tool results are reused; completed tools are not rerun. A close before completion, after a successor starts, or with a transport or protocol error remains a failure.

If Codex rejects a missing previous response ID, Pi retries once on a fresh connection with full current input. Response and rate-limit metadata alone do not prevent this recovery, even if the stream-start notification was already delivered. Output items, completed responses, and submitted steering prevent replay. A second missing-ID rejection ends the request.

A connection that drops after only response or rate-limit metadata reconnects once with full current input. If that attempt fails too, Pi uses HTTP for the request. Local timeouts go directly to HTTP rather than doubling the timeout. Provider errors and cancellation do not trigger this transport retry.

Once output has started, Pi's normal agent retry policy handles the interrupted response. After two consecutive WebSocket transport failures in a cached session, the next request uses HTTP once. Later requests try WebSockets again; a successful WebSocket response clears the failure count. An explicit message-too-large close (1009) continues to disable WebSockets for that session.

The interactive view removes a failed attempt and its unfinished tool cards when retry starts. Completed tools remain visible and are not rerun by the retry loop. Failed messages and their diagnostics remain in session history; a separate presentation marker keeps them hidden after chat rebuilds and resume. Cancellation and exhausted retries remain visible.

## Diagnosing disconnects

Assistant messages store `provider_request` diagnostics and a `provider_transport_failure` snapshot for each failed transport attempt. Inspect the session file shown by `/session`; successful recovery also retains these snapshots.

Useful fields:

- `runtime`, `responseId`, `socketReused`, `socketAgeMs`, and `websocketRequestMode`: runtime and connection context.
- `lastEventType`, event times, and `localTimeout`: distinguish an adapter timeout from a drop while data was arriving.
- `closeCode` and `closeWasClean`: WebSocket close information. Code 1006 means no close frame arrived; it does not identify who caused the loss.
- `socket`: when Node/Undici exposes its socket, connection ID, bytes read/written, readable-end and close timing, available network error code/syscall, and any close requested by Pi. Socket times start at the upgrade request; adapter times start at the provider call. Byte counts cover the connection, including its handshake and earlier requests.

Socket diagnostics use native Undici events and local async context to match the request to its socket. They do not change request headers or session affinity. They do not log payloads, authorization headers, addresses, or raw socket error messages. They may be absent in other runtimes or custom WebSocket implementations. Absence of a local close or timeout is evidence against those particular causes, not proof of a backend fault.

For a controlled comparison, run the same workload with `auto` and `sse`, retaining diagnostic records from both successful and failed requests. Compare fresh and reused connections, request sizes, and service tiers before changing connection lifetime or client dependencies.
