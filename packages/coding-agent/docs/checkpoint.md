# Working-session checkpoints

Checkpoints save native selection and accepted queues, not just a transcript. They are optional and do not replace native authentication, extensions, or the TUI.

The native TUI reports `sleepReady: true` for a fully settled, resumable working session with ingress held. A completed task or an assistant's textual question qualifies; a live question-tool dialog does not. **This is Pi's boundary, not a filesystem freeze:** the archive owner must separately quiesce services, freeze namespace writers, capture and verify the private archive, and commit it before stopping compute.

## SDK

```typescript
import { writeSessionCheckpoint } from "@earendil-works/pi-coding-agent";

const hold = await session.acquireCheckpoint({
  boundary: "turn", // or "settled" (default)
  signal: AbortSignal.timeout(30_000),
  quiesce: () => {
    // Synchronously close your host's input and reject unsupported live UI.
    // Return an idempotent input-release callback.
    return releaseInput;
  },
});
try {
  writeSessionCheckpoint("/private/checkpoint.json", hold.checkpoint);
  // Coordinate other writers and seal a filesystem archive while held.
  // Do not continue capture if hold.signal becomes aborted.
} finally {
  hold.release();
}
```

Acquisition waits for a completed turn, or final settlement after retries, compaction, and queued continuations. A `turn` request made at qualified settlement returns the actual `boundary: "settled"`; it does not force an intermediate receipt. Active-turn holds remain `boundary: "turn"` and `sleepReady: false`. Explicit `settled` requests wait for settlement.

All awaited extension handlers and core `turn_end` subscribers finish before a turn hold. Settlement handlers finish before a settled hold, including when they temporarily expose `isIdle`. Native notification handlers, extension event-bus callbacks and `pi.exec` operations also own their pending activity. Settings writes are flushed and recorded errors reject acquisition. Native catalog/auth operations and their underlying file locks are joined, including cancellation cleanup; new operations invalidate the hold before starting. Catalog refresh failures may retain the previous native cached catalog, exactly as normal Pi startup does. There is no separate host model store.

A hold pauses the native loop before the next turn. The host must close its own input synchronously in `quiesce`. SDK hosts can supply `canQuiesce` to defer acquisition and call `notifyCheckpointStateChanged()` when their pending UI work finishes. Without `quiesce`, the SDK never reports sleep readiness. Native TUI ingress pauses rather than discards input; already-decoded input invalidates the hold before dispatch, then applies normally, including steering and follow-ups. Direct SDK mutation violations invalidate and throw explicitly. Cancellation, abort, reload, shutdown, and disposal invalidate a hold. Check `hold.signal`; `session.cancelCheckpoint()` releases without aborting model work. Never acquire from an awaited tool/event handler: waiting on your own completion would deadlock.

Capture does not consume queues. Release is idempotent. A capture/upload failure must release the hold and retain compute and the previous durable checkpoint. The API does not upload files, stop processes, implement durability policy, or coordinate independent processes. Async `session.subscribe()` observers remain observational, not awaited persistence hooks.

## Artifact and restore

Version 1 JSON contains:

- `selection`: native restart selection (`sessionFile`, `sessionId`, `cwd`, exact `leafId`, model, thinking level, active/known tools).
- `header` and all native `entries`, including initialized sessions before the first assistant response creates their journal.
- `queues`: full native steering/follow-up messages, including images/custom details; queue modes; next-turn context; cancellation-persistence ownership.
- `scopedModels`: session-only model cycling selection, including order and thinking levels (optional in older v1 artifacts).
- `createdAt`, `boundary`, and `settled`.

The artifact is private (0600), atomically replaced, and contains sensitive conversation data. The filesystem archive must also preserve working files, Git, native settings, credentials, extension files, and referenced resources. Serialization does not preserve live tool/dialog/command callbacks, arbitrary memory, shell processes, or shutdown-only extension state. Native settings/authentication and extension files remain in their original locations and must be included in the archive. A selected provider's runtime-only API key keeps sleep readiness false; persist authentication through native login first.

```typescript
import { createAgentSession, readSessionCheckpoint } from "@earendil-works/pi-coding-agent";

const checkpoint = readSessionCheckpoint("/private/checkpoint.json");
const { session } = await createAgentSession({ checkpoint });
```

Restore applies the exact branch (including null) **before** constructing context. It preserves the conversation ID and requires the original filesystem layout and model/tools. An existing journal that differs from the artifact is rejected, never overwritten. A missing journal is materialized from the artifact, including pre-first-assistant state. Restore the matching filesystem archive first; never use a stale checkpoint over newer work.

Queues are installed once without rerunning input handlers, prompt expansion, model calls, or tools. Startup waits for explicit user input; this avoids silently replaying uncertain external effects after unexpected failure. Steering/follow-up user texts appear in the native pending display; custom/next-turn payloads remain in native queues. `getCheckpointQueues()` provides a non-consuming snapshot; `restoreCheckpointQueues()` rejects duplicate installation or nonempty/busy destinations.

Lower-level hosts can use `openSessionCheckpoint()` before session creation and `restoreSessionCheckpoint()` afterward. Prefer the `checkpoint` factory option to avoid ordinary new-session metadata changing a null leaf.

## Supported extension persistence

Existing extensions that await their work and reconstruct from native entries/tool details or persisted files need no new hook. There is no extension install allowlist. Arbitrary memory-only tasks, detached promises, sockets, timers, or shutdown-only state are not serialized. Such extensions must keep compute alive, or explicitly implement a persistence barrier. A registered `session_shutdown` handler without a checkpoint barrier conservatively produces `sleepReady: false` (and a named `sleepBlockers` reason), without disabling the extension or running shutdown during save.

The optional additive `session_checkpoint` event runs while ingress and the native loop are held, before settings/catalog flush and artifact publication. Await file persistence and use `pi.appendEntry()` for native state. Return `{ sleepReady: true }` only when all extension state is reconstructible and owned background callbacks remain quiescent until `event.signal` aborts. Return `{ sleepReady: false, reason: "..." }` for unsupported live memory. A thrown error rejects acquisition. Do not start prompts, tools, dialogs, or acquire another checkpoint from the hook.

```typescript
pi.on("session_checkpoint", async (event) => {
  if (pendingMemoryOnlyTask) return { sleepReady: false, reason: "Task callback is live" };
  await persistExtensionFiles();
  pi.appendEntry("my-state", serializableState);
  // If a background source remains connected, it must call event.invalidate()
  // BEFORE accepting work or writing. Resume paused ingress on event.signal abort.
  return { sleepReady: true };
});
```

Pi owns native command, shortcut, notification, autocomplete, and exec dispatch until their returned promises finish. It cannot discover a detached arbitrary JavaScript promise. Extensions with such work must return a negative barrier result or quiesce/join it themselves; an unreported memory-only extension is outside the supported contract. Captured native UI setters and native extension API write violations invalidate a held receipt, rather than silently changing its state. Cosmetic rendering, syntax highlighting, version notices, and git/theme observations are reconstructible presentation, not working-session persistence.

Native restart control implements this barrier: its idle socket is reconstructible, a pending restart keeps compute alive, and a new restart invalidates an existing receipt before acceptance.

## CLI control over SSH/tmux

Start the ordinary native TUI with an optional owner-private Unix endpoint:

```bash
mkdir -m 700 /private/pi-control
PI_CHECKPOINT_SOCKET=/private/pi-control/socket pi
# Cold launch, after restoring the matching filesystem:
PI_CHECKPOINT_SOCKET=/private/pi-control/socket pi --checkpoint /private/checkpoint.json
```

`--checkpoint` cannot combine with startup prompts or session/model/tool selection overrides. Resource/discovery flags and native trust/auth behavior remain available. Managed restarts do not replay the original `--checkpoint` argument.

Connect to the Unix socket and send newline-delimited JSON. Keep the same connection open through capture:

```json
{"action":"acquire","path":"/private/checkpoint.json","boundary":"turn"}
```

Success is sent only after the artifact is written while held:

```json
{"ok":true,"token":"...","path":"/private/checkpoint.json","boundary":"settled","settled":true,"sleepReady":true,"sleepBlockers":[],"selection":{}}
```

Use the actual receipt boundary, not the requested one. Periodic `turn` requests obtain intermediate recovery points while active and positive settled receipts once qualified; the host need not implement idle detection. `settled: true` alone is insufficient when `sleepReady` is false. Readiness is connection/hold-scoped, not a reusable permission stored in the artifact.

Release on the same connection:

```json
{"action":"release","token":"..."}
```

Closing the connection cancels pending acquisition or releases its hold. The caller owns the wait timeout. Errors return `{ok:false,message}`; invalidated holds additionally return `invalidated:true` and their token. There is no upload acknowledgement or implicit sleep operation.

The endpoint follows the runtime's current session after replacement. Live selectors/overlays/custom editors, mode-held input, drafts, native preflight, extension commands, and independent user Bash defer capture. Native selector callbacks remain owned even after dismissal; login completion owns its detached catalog/model-selection continuation; keybindings, clipboard reads and external-editor work remain owned until completion. Terminal ingress is paused rather than discarded; a decoder key already in flight invalidates the cut before dispatch. Drafts, including clipboard-image paths, are deliberately not claimed as saved: retain compute until handled. This endpoint is not an account-level security boundary; see [Security](security.md).

See [SDK](sdk.md), [Sessions](sessions.md), and [Session Format](session-format.md).
