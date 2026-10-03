# Native working sessions

A working session saves the complete private conversation and its accepted pending input. It preserves the original journal header, all branches, the selected leaf (including no selected leaf), both full steering/follow-up queues, next-turn context, model/thinking/scopes, tool restrictions, effective settings, unsent prompt options and supported native mode buffers. This is separate from a branch export.

Credentials, executable tools, live promises and process memory are not included. Restore the matching private filesystem and native resources as well. Extensions reconstruct supported state from ordinary custom entries, tool details and their private files.

## SDK

```typescript
import { createAgentSession, writeWorkingSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();
const hold = await session.acquireWorkingSession({ boundary: "settled" });
try {
  hold.assertHeld();
  writeWorkingSession("/private/session/state.json", hold.state);
  // Keep the hold until the consumer has finished copying the matching files.
} finally {
  await hold.release();
}

const { session: restored } = await createAgentSession({
  workingSession: "/private/session/state.json",
});
```

Paths written through `writeWorkingSession` must be absolute, have a canonical parent directory owned by the current user and not writable by others, and name a missing file or an owner-only regular file. The writer publishes atomically after syncing its contents.

Acquisition waits for native admission/preflight, commands, asynchronous notifications, UI callbacks and settlement handlers. A `turn` request can reserve an awaited completed turn before either queue drains. That intermediate cut has `sleepReady: false` because the current agent continuation is still active. A naturally settled session can satisfy either request with a `settled` cut. Pending idle queues are saved directly; acquisition does not drain them.

`hold.blockers` explains independent work that requires live compute. Detached jobs, live MCP requests/authentication, arbitrary dialogs/custom factories, unsent drafts and unsupported custom editor state cannot authorize sleep. Ordinary MCP reconnect and later tool registration are supported. Native completion monitors pause during the hold and resume after release.

Invalidation and release are different. `hold.invalidated` makes the saved cut unusable; `hold.signal` ends only on release, cancellation or preparation failure. Native mutations are refused before changing state while reserved and invalidate the cut synchronously. Release is idempotent. Do not mutate raw Agent state or returned entry objects around the supported APIs.

SDK hosts with extra memory-owned state bind one `WorkingSessionHost` using `session.bindWorkingSessionHost({ kind, readiness, capture, restore })`. Its readiness callback returns `{ blockers }` when live memory cannot be restored. `capture` must return JSON-serializable data; `restore` receives it before mode startup. A mode-kind mismatch fails rather than losing buffers.

## Extension persistence and readiness

```typescript
pi.on("working_session_save", async (event) => {
  await flushPrivateState();
  event.appendEntry("my-extension-state", persistedState);
  event.signal.addEventListener("abort", resumeOwnMonitor, { once: true });
  return { blockers: liveDialog ? ["My extension has a live dialog"] : [] };
});
```

Save handlers are strict: errors fail acquisition. The event's `appendEntry` is the only mutation capability allowed during preparation and expires when that handler returns. Ordinary extension mutation APIs remain guarded even while an asynchronous save handler yields. `event.invalidate(reason)` invalidates the cut without releasing the lifetime. Persisted extensions need no separate state database.

## Restore

`pi --working-session /private/session/state.json` validates the artifact and matching journal before session, resource, model or extension-start construction. A different or newer journal is refused without repair or overwrite. Missing journals are materialized from the exact saved entries.

The selected model and tool policy are retained. Missing selected models fail; missing restored tools retain their pending names and refuse a new request until native registration completes or the user explicitly changes the selection. Restore never selects a different default payer or silently removes required tools.

Restoration waits for new native input. It does not replay a provider action, tool batch, retry, consumed startup prompt or old low-level loop. Accepted native TUI/print buffers remain paused until an explicit new submission; extension reconstruction uses normal `session_start` behavior. CLI `--api-key` stays transient and is never serialized.

## Conditional local control

The CLI enables a private Unix-socket bridge only when `PI_WORKING_SESSION_SOCKET` is set. One JSONL connection owns one acquisition:

```json
{"action":"acquire","path":"/private/session/state.json","boundary":"settled"}
```

A successful reply contains `ok`, `path`, actual `boundary`, `token`, worker `pid`, worker incarnation `worker`, launcher nonce `launch`, `guardPath`, `sleepReady` and `blockers`. Release uses `{"action":"release","token":"..."}`. EOF releases ownership. A mismatched token cannot release another hold. Invalidation sends `{"invalidated":true,"token":"...","reason":"..."}` but keeps ownership until release.

The transient `${PI_WORKING_SESSION_SOCKET}.guard` is synchronously published before the grant and invalidated before incompatible admission returns. Its fields are `version: 1`, `token`, `pid`, `worker`, `launch`, `valid` and optional `reason`. A filesystem-freezing consumer must read this guard **after every writer is frozen**, require the exact granted token/worker/launch/PID and `valid: true`, and keep writers frozen through its sleep commit and teardown. Buffered socket notifications alone are insufficient. The guard is not archive or restore authority.

The bridge owns no archive, polling policy, leases or sleep controller. It follows the runtime's current session, and its socket/guard are removed on orderly worker shutdown.

## Completed exit

`PI_WORKING_SESSION_EXIT_PATH` enables strict final serialization to `${exitPath}.state`. The worker joins its agent, runs shutdown persistence, performs the strict native save and sends a digest-bound completion to the native launcher. Independent unfinished work or failed persistence produces no successful receipt.

The launcher clears any prior receipt at launch and attests only its current ready worker after the final normal zero exit, with no replacement or rollback remaining. The owner-only receipt contains `version: 1`, state `path`, SHA-256 `digest`, `sessionId`, worker `pid`, `worker`, `launch`, `launcherPid` and `launcher` (the same launch nonce). Metadata commands, crashes, stale workers, incomplete finalization and mismatching artifacts produce no receipt.

An outer workspace wrapper must wait for the entire native launcher and verify this receipt, state digest/session identity and its own process/pane identities. A worker exit code or old state file alone does not establish a completed native exit.
