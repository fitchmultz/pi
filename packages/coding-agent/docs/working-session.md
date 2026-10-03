# Native working sessions

A working session saves the complete private conversation and its accepted pending input. It preserves the original journal header, all branches, the selected leaf (including no selected leaf), both full steering/follow-up queues, next-turn context, model/thinking/scopes, tool restrictions, effective settings and their global/project layers, unsent prompt options and supported native mode buffers. Declaration-merged extension message roles keep their opaque JSON payloads in queues and journal entries. This is separate from a branch export.

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

Paths written through `writeWorkingSession` must be absolute, have a canonical parent directory owned by the current user and not writable by others, and name a missing file or an owner-only regular file. Windows checks the native access control lists on both directory and file; only the current user, System and Administrators may have access. The writer publishes atomically after syncing its contents.

Acquisition waits for native admission/preflight, commands, asynchronous notifications, UI callbacks and settlement handlers. A `turn` request can reserve an awaited completed turn before either queue drains. That intermediate cut has `sleepReady: false` because the current agent continuation is still active. A naturally settled session can satisfy either request with a `settled` cut. Pending idle queues are saved directly; acquisition does not drain them.

`hold.blockers` explains independent work that requires live compute. Detached jobs, live MCP requests/authentication, arbitrary dialogs/custom factories, unsent drafts and unsupported custom editor state cannot authorize sleep. Ordinary MCP reconnect and later tool registration are supported. Native completion monitors pause during the hold and resume after release.

Invalidation and release are different. `hold.invalidated` makes the saved cut unusable; `hold.signal` ends only on release, cancellation or preparation failure. Native mutations are refused before changing state while reserved and invalidate the cut synchronously. Release is idempotent. Do not mutate raw Agent state or returned entry objects around the supported APIs.

Native terminal input and mutating RPC commands received during a hold invalidate the cut and wait for release before delivery. Terminal input also resumes when save preparation fails. Read-only RPC queries and display-only extension UI updates, such as status, notifications and widgets, do not invalidate the hold. Interactive UI callbacks and editor mutation remain admitted through the native gate.

SDK hosts with extra memory-owned state bind one `WorkingSessionHost` using `session.bindWorkingSessionHost({ kind, readiness, capture, restore })`. Its readiness callback returns `{ blockers }` when live memory cannot be restored. `capture` must return plain JSON data; `restore` receives it before mode startup. A mode-kind mismatch fails rather than losing buffers.

Capture, restore and `writeWorkingSession` use the same strict v1 codec. Undefined object properties are omitted, but non-finite numbers, functions, symbols, getters, class instances, sparse arrays and cycles are rejected rather than silently dropped or coerced. Failed capture releases admission; an invalid write leaves the existing artifact unchanged.

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

Unresolved settings load or write failures refuse acquisition even after their diagnostics have been displayed. A successful write repairs its scope; an explicit successful reload adopts the persisted settings and clears that scope's failure.

## Restore

`pi --working-session /private/session/state.json` validates the artifact and matching journal before session, resource, model or extension-start construction. A different or newer journal is refused without repair or overwrite. Missing journals are materialized from the exact saved entries.

`DefaultResourceLoader` supports complete persistence. Custom SDK loaders need not implement `getWorkingSessionResources()` for ordinary session creation, prompting or reload. Complete capture and explicit restore require that method and a loader that honors `reload({ workingSession })` under the saved settings. Unsupported persistence fails clearly; Pi never substitutes an empty resource manifest.

SDK and service-created sessions with persistence support capture their agent directory, explicit resource selections and current trust/offline policy automatically. A directly constructed `AgentSession` also needs an explicit `workingSessionLaunch` owner. A v1 artifact without `launch` can be restored only by an SDK host supplying a persistence-capable `resourceLoader` and explicit `agentDir`; CLI/service restoration does not infer its resources. Native TUI state also preserves the effective regular/fullscreen renderer and restores it before constructing the interface. SDK and CLI restoration apply saved project trust, offline policy and settings before discovery and extension factories, including when the host supplies native services. The artifact's `settings` is the exact effective configuration; `settingsLayers.global` and `settingsLayers.project` preserve global-only preferences and relative resource origins. Restoration changes settings in memory, never overwrites settings files. Persisted setters still write only the changed fields; ordinary `/reload` reads the current files. Required saved extension-load or provider-registration failures abort restoration.

The selected model and tool policy are retained. Missing selected models fail; missing restored tools retain their pending names and refuse a new request until native registration completes or the user explicitly changes the selection. Restore never selects a different default payer or silently removes required tools.

Restoration waits for new native input. It does not replay a provider action, tool batch, retry, consumed startup prompt or old low-level loop. Accepted native TUI/print buffers remain paused until an explicit new submission; extension reconstruction uses normal `session_start` behavior. CLI `--api-key` stays transient and is never serialized.

## Conditional local control

The CLI enables a private Unix-socket bridge only when `PI_WORKING_SESSION_SOCKET` is set.

Before loading resources or extension factories, the worker consumes `PI_WORKING_SESSION_SOCKET`, `PI_WORKING_SESSION_EXIT_PATH`, `PI_WORKING_SESSION_LAUNCH` and `PI_WORKING_SESSION_WORKER` into its private control state. Factory-spawned processes and shell tools therefore do not pass the primary launch's transport to nested Pi sessions. The launcher retains its own environment for replacement workers and final receipts. The separate `PI_RESTART_SOCKET` still lets shell tools request a managed restart.

One JSONL connection owns one acquisition:

```json
{"action":"acquire","path":"/private/session/state.json","boundary":"settled"}
```

A successful reply contains `ok`, `path`, actual `boundary`, `token`, worker `pid`, worker incarnation `worker`, launcher nonce `launch`, `guardPath`, `sleepReady` and `blockers`. Release uses `{"action":"release","token":"..."}`. EOF releases ownership. A mismatched token cannot release another hold. Invalidation sends `{"invalidated":true,"token":"...","reason":"..."}` but keeps ownership until release.

The transient `${PI_WORKING_SESSION_SOCKET}.guard` is synchronously published before the grant and invalidated before incompatible admission returns. Its fields are `version: 1`, `token`, `pid`, `worker`, `launch`, `valid` and optional `reason`. A filesystem-freezing consumer must read this guard **after every writer is frozen**, require the exact granted token/worker/launch/PID and `valid: true`, and keep writers frozen through its sleep commit and teardown. Buffered socket notifications alone are insufficient. The guard is not archive or restore authority.

The bridge owns no archive, polling policy, leases or sleep controller. It follows the runtime's current session, and its socket/guard are removed on orderly worker shutdown.

## Completed exit

`PI_WORKING_SESSION_EXIT_PATH` enables strict final serialization to `${exitPath}.state`. The worker joins its agent, runs shutdown persistence, performs the strict native save and sends a digest-bound completion to the native launcher. Independent unfinished work or failed persistence produces no successful receipt.

An unready session cannot produce completion evidence and does not wait for readiness during quit. Launches without an exit path retain ordinary native shutdown error reporting and cleanup.

The launcher clears any prior receipt at launch and attests only its current ready worker after the final normal zero exit, with no replacement or rollback remaining. The owner-only receipt contains `version: 1`, state `path`, SHA-256 `digest`, `sessionId`, worker `pid`, `worker`, `launch`, `launcherPid` and `launcher` (the same launch nonce). Metadata commands, crashes, stale workers, incomplete finalization and mismatching artifacts produce no receipt.

An outer workspace wrapper must wait for the entire native launcher and verify this receipt, state digest/session identity and its own process/pane identities. A worker exit code or old state file alone does not establish a completed native exit.
