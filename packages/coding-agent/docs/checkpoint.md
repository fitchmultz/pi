# Working-session checkpoints

Checkpoints save native selection and accepted queues, not just a transcript. They are optional and do not replace native authentication, extensions, or the TUI.

**Current limitation:** the CLI supports intermediate recovery checkpoints, but always reports `sleepReady: false`. It does not yet prove that every asynchronous TUI/auth/extension callback and independent writer has finished. Keep compute running. `settled` describes the native agent run, not permission to destroy the process.

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

Acquisition waits for a completed turn, or final settlement after retries, compaction, and queued continuations. All awaited extension handlers and core `turn_end` subscribers finish before a turn hold. Settlement handlers finish before a settled hold, including when they temporarily expose `isIdle`. Settings writes are flushed and recorded errors reject acquisition.

A hold pauses the native loop before the next turn. Native prompt/queue mutations reject while held; the host must close its own input synchronously in `quiesce`. Cancellation, abort, reload, shutdown, and disposal invalidate a hold. Check `hold.signal`; `session.cancelCheckpoint()` releases without aborting model work. Never acquire from an awaited tool/event handler: waiting on your own completion would deadlock.

Capture does not consume queues. Release is idempotent. A capture/upload failure must release the hold and retain compute and the previous durable checkpoint. The API does not upload files, stop processes, implement durability policy, or coordinate independent processes. Async `session.subscribe()` observers remain observational, not awaited persistence hooks.

## Artifact and restore

Version 1 JSON contains:

- `selection`: native restart selection (`sessionFile`, `sessionId`, `cwd`, exact `leafId`, model, thinking level, active/known tools).
- `header` and all native `entries`, including initialized sessions before the first assistant response creates their journal.
- `queues`: full native steering/follow-up messages, including images/custom details; queue modes; next-turn context; cancellation-persistence ownership.
- `createdAt`, `boundary`, and `settled`.

The artifact is private (0600), atomically replaced, and contains sensitive conversation data. The filesystem archive must also preserve working files, Git, native settings, credentials, extension files, and referenced resources. Serialization does not preserve live tool/dialog/command callbacks, arbitrary memory, shell processes, or shutdown-only extension state.

```typescript
import { createAgentSession, readSessionCheckpoint } from "@earendil-works/pi-coding-agent";

const checkpoint = readSessionCheckpoint("/private/checkpoint.json");
const { session } = await createAgentSession({ checkpoint });
```

Restore applies the exact branch (including null) **before** constructing context. It preserves the conversation ID and requires the original filesystem layout and model/tools. An existing journal that differs from the artifact is rejected, never overwritten. A missing journal is materialized from the artifact, including pre-first-assistant state. Restore the matching filesystem archive first; never use a stale checkpoint over newer work.

Queues are installed once without rerunning input handlers, prompt expansion, model calls, or tools. Startup waits for explicit user input; this avoids silently replaying uncertain external effects after unexpected failure. Steering/follow-up user texts appear in the native pending display; custom/next-turn payloads remain in native queues. `getCheckpointQueues()` provides a non-consuming snapshot; `restoreCheckpointQueues()` rejects duplicate installation or nonempty/busy destinations.

Lower-level hosts can use `openSessionCheckpoint()` before session creation and `restoreSessionCheckpoint()` afterward. Prefer the `checkpoint` factory option to avoid ordinary new-session metadata changing a null leaf.

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
{"ok":true,"token":"...","path":"/private/checkpoint.json","boundary":"turn","settled":false,"sleepReady":false,"selection":{}}
```

Release on the same connection:

```json
{"action":"release","token":"..."}
```

Closing the connection cancels pending acquisition or releases its hold. The caller owns the wait timeout. Errors return `{ok:false,message}`; invalidated holds additionally return `invalidated:true` and their token. There is no upload acknowledgement or implicit sleep operation.

The endpoint follows the runtime's current session after replacement. Known live selectors/overlays/custom editors, mode-held input, drafts, native preflight, extension commands, and independent user Bash prevent capture. Terminal ingress is paused rather than discarded; a decoder key already in flight invalidates the cut before dispatch. Drafts, including clipboard-image paths, are deliberately not claimed as saved: retain compute until handled. This endpoint is not an account-level security boundary; see [Security](security.md).

See [SDK](sdk.md), [Sessions](sessions.md), and [Session Format](session-format.md).
