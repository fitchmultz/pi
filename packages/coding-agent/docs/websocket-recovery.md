# Codex WebSocket recovery

Keep `transport: "auto"` to prefer persistent WebSockets and incremental conversation requests.

After live steering, Pi sends the next request with full current input, including saved steering and tool results. That response establishes a new baseline for incremental requests on the same connection.

The socket is retained only after a terminal response and resolved steering acknowledgements. Unknown steering, cancellation, or retirement cannot establish a reusable chain. Once a terminal frame arrives, new steering stays queued for the next ordinary request, even if earlier response events are still being processed. Continuation baselines are value snapshots: later edits to request or assistant objects cannot silently change the saved prefix.

Codex routing state is separate from the continuation baseline. When an exact `response.metadata` event issues `x-codex-turn-state`, the first eligible value is echoed on later `response.create` frames in that logical turn, including reconnects, but never on `response.steer`. New turns and authentication-owner changes discard it. The agent loop supplies one in-memory `turnScope` per prompt/continue run; direct AI callers must supply a shared object for their logical turn or no token is latched. `codex.response.metadata` is not eligible under the official event-parser contract. Pi deliberately captures events only, not WebSocket handshake headers: the official `codex-api` layer supports handshake-header capture, while the inspected official core connection path passes `None` for that capture. Pi's event-only behavior is a limitation, not full parity with `codex-api`.

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

For native steering, the parent may be journaled before the successor gap ends. Its saved diagnostic snapshot then lacks the later close information; do not use that absence to identify who closed the connection. Unknown `response-steering` custom entries now retain a `diagnostic` of type `provider_transport_close`, including available `closeCode`, `closeWasClean`, `closeReason`, `closeInitiator`, `sinceParentTerminalMs`, and `pendingSteerStatus`. Local close reasons are fixed client labels; nonempty remote reason text is redacted. An abnormal close (1006) without a local close request has an unknown initiator, not a proven remote cause.

In the September 26–27, 2026 incident session, all 53 unknown steering entries followed recorded parent completion by 3.1–4.4 seconds. All 53 had queued steering before parent persistence; 52 also had acceptance recorded before it. None of those parent snapshots retained the eventual close code or initiator. The inspected client has no steering-specific timeout or close-on-send path; this history alone cannot prove a server-initiated close or exact terminal-frame arrival ordering. Reusing an unresolved chain is not a safe cache repair.

For a controlled comparison, run the same workload with `auto` and `sse`, retaining diagnostic records from both successful and failed requests. Compare fresh and reused connections, request sizes, and service tiers before changing connection lifetime or client dependencies.
