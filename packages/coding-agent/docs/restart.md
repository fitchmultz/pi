# Managed Restarts

The Node CLI can restart its agent process and resume the same saved session. A small launcher stays outside the agent process, so applying extension or runtime code changes does not require the user to restart Pi manually.

By default, each restart loads the release selected by the original CLI invocation: for example, a changed npm package symlink or an installer-managed `current-version` pointer. Source/worktree entrypoints and a release's concrete `dist/bundle/cli.js` stay at their original location.

The standard installer identifies its release `.bin/pi` entrypoint through `PI_MANAGED_INSTALL_ROOT`. Running that same entrypoint from a managed Pi shell also follows `current-version` on restart. To stay on a specific release, use `--runtime <package-dir>` or launch its concrete `dist/bundle/cli.js`.

This is different from `/reload`, which applies extension code and resources in the existing process. Use restart for core runtime changes or when a clean process is required.

## Request a Restart

From a Pi shell tool:

```bash
pi restart --message "Verify the updated tool, then continue the task"
```

The command acknowledges **queueing**, not successful activation. Pi waits for final idle, including sibling tools, automatic retries, compaction and queued continuations. It shuts down gracefully, starts a fresh worker, restores the session, and submits the supplied text as a clearly labelled restart continuation.

Without `--message`, the replacement opens the session and waits for input. In the TUI, `/restart` does the same; `/restart <text>` also supplies a continuation.

If an external editor is open, Pi waits for it to return before restarting. Returned draft text stays in the editor and cancels the queued restart; an empty result allows it to continue.

Restarts require a saved session. Requests reject ephemeral sessions, stale session IDs, missing candidate files, and unhandled editor drafts or next-turn messages. If new draft text arrives before the restart boundary, Pi cancels rather than discarding it. Interrupting the agent run, cancelling retry backoff, or exhausting retries cancels a pending restart. Normal quit and termination signals do not restart Pi, including when shutdown preparation is already in progress.

## Stage Changes Without Overwriting the Working Version

For an extension update, write a new version to a separate path, validate it, then select it:

```bash
pi restart \
  -e /path/to/fast-mode.ts \
  -e /path/to/my-tool-v2.ts \
  --message "Confirm my-tool reports version 2 and continue"
```

Supplying one or more `-e` / `--extension` options **replaces the explicit CLI extension list**. Include each extension you want to keep. Omitting `-e` preserves that list. Existing discovery flags such as `-ne`, `-ns`, `-np`, and `-nc` are retained; restart does not silently enable discovery or change global settings. Original CLI trust overrides are retained and normal project-trust resolution runs again; the prior session's trust state does not become an implicit `--approve`.

For Pi runtime changes, build a separate coding-agent package directory:

```bash
pi restart \
  --runtime /path/to/validated-worktree/packages/coding-agent \
  --message "Check the updated runtime and continue"
```

The directory must contain the built `dist/bundle/cli-worker.js`. Runtime and extension options can be combined. Paths resolve from the requesting shell's working directory. `--runtime` selects that exact worker for this restart and later ordinary restarts, even if the original installation selector moves. Another `--runtime` changes the pin; a full CLI launch returns to the original installation selector. Omit `--runtime` when an installer has already selected the desired release and you want to keep following that selector.

**Keep the previous runtime, dependencies and extension files intact.** Rollback selects the previous launch configuration; it does not undo file edits, restore Git state, or reverse external side effects. An in-place overwrite of the only working version cannot be rolled back by restarting the same files.

## Recovery and Session State

Every ordinary managed restart uses a final native v1 file checkpoint. Pi stops input, awaits all `session_shutdown` handlers, cancels and joins native work and host callbacks, flushes settings/auth/catalog persistence, then captures the final entries, exact branch (including null), model, scope, restrictions and remaining accepted queues. Later shutdown receipts are included. The private capture is published as an immutable original file while its native signal remains valid, before the capture hold is released. Managed restart never writes `completedExit`.

Only then does Pi send the handoff and exit successfully. The launcher starts the replacement after that exit. The worker selects the cold file before opening a journal or loading recovery extensions, restores queues once, and finishes initialization before admitting input or a continuation. Earlier startup prompts, file attachments, completed tools and provider requests are not replayed. Remaining CLI startup prompts run before the restart.

Newly installed extension tools start enabled unless registry restrictions, `defaultActive: false`, or startup/discovery handlers disable them; previously known inactive tools stay inactive. Registry allow/exclude restrictions and built-in default suppression survive restart, including when they came only from a cold `--checkpoint` restore rather than CLI flags. The session journal remains the conversation authority; extensions must persist their own state through ordinary shutdown.

Stored credentials are unchanged. A CLI `--api-key` is forwarded only while its original provider is still selected; after a provider change, Pi uses normal credential resolution rather than sending that key to a different provider.

Capture or final-cleanup failure prints `Managed restart checkpoint failed: ...` and exits nonzero without starting a replacement. A signal or user quit during preparation cancels the restart. The ref'ed 30-second native cleanup budget includes any offline program; cancellation joins that child, with the native five-second force-kill grace. Retained files are private recovery evidence, not successful activation or permission to overwrite newer work.

A replacement becomes ready after runtime creation and TUI initialization. If the selected worker is missing, fails, or takes more than 60 seconds to reach readiness, the launcher tries the exact previous worker and explicit extension list once, against the same checkpoint, even if the selector moved again. It also restores the previous selection policy: later ordinary restarts follow the original selector unless an earlier explicit `--runtime` was active. A supplied continuation includes the startup failure notice so the agent can diagnose it. If recovery also fails, Pi stops instead of entering a restart loop.

Readiness is not proof that every tool or provider works. Validate candidates before requesting activation. Failures **after readiness** are not automatically replayed or rolled back: doing so could duplicate work whose side effects already occurred.

The control endpoint is local and session-scoped. On Unix it lives inside a private temporary directory. It is replaced on resource reload/session replacement and removed during shutdown. It is not a permission boundary within the user's account, and staged extensions remain full-trust code. See [Security](security.md).

## Explicit Offline Transformation

For a one-time stopped-copy migration, request a trusted **absolute Node program**:

```bash
pi restart --checkpoint-transform /private/activate-storage.mjs
```

This option is explicit; ordinary restarts never run a converter. Pi invokes the program with no shell, in the captured session cwd:

```text
<current Node executable> <program> transform <original-checkpoint> <candidate-checkpoint>
<current Node executable> <program> rollback  <original-checkpoint> <candidate-checkpoint>
```

`transform` runs exactly once after final capture, while the outgoing writer is quiesced, outside the replacement's 60-second readiness deadline. It must produce the candidate checkpoint and a separate converted journal using the existing offline converter. Only `header`, `entries`, and `selection.sessionFile` may change. UUID, cwd, null/off-tip leaf, exact queues/images/modes/cancellation ownership, scope, tools, restrictions and other working state must remain identical. Native strict, normalized record comparison verifies both existing journals without writable-manager repair; the original checkpoint digest and journal must remain unchanged. Pi synchronizes the published files before sending the handoff.

Exit zero only after all conversion, validation and any prepared extension-artifact pointer publication finishes. Keep stdout empty and stderr concise; there is no stdout protocol. Do not spawn detached work, execute tools/providers/browser actions, edit settings/authentication, or overwrite original journals/artifacts. The program is full-trust offline code, not sandboxed by this option. Use private distinct outputs and retain conversion/identity receipts.

`rollback` runs only on the launcher's single startup-failure fallback, **before** recovery extensions load. It restores only the helper's previously prepared extension artifacts/pointers. It must not convert again, rewrite the original capture, or undo admitted operations. Pi selects the immutable original file and original locator for recovery. A rollback failure stops recovery. Without a transform, fallback selects the same original capture without running a program.

Use the public `readSessionCheckpointState`, `writeCheckpointFile`, and `validateSessionCheckpointFile` APIs described in [Checkpoints](checkpoint.md#offline-file-consumers). The parent activation owner prepares the real helper against exact staged builds and backups. Pi retains original and candidate files under a private `pi-restart-checkpoint-*` directory and reports the original path on transform failure. Preserve those files until activation/recovery and archive verification are complete.

## Scope and First Startup

Managed restart is provided by the bundled Node CLI. Print, JSON and RPC modes and one-shot startup benchmarks do not expose the interactive restart endpoint; SDK hosts and standalone binaries retain their existing lifecycle behavior.

The launcher itself remains loaded across worker replacements. Changes to launcher code take effect on the next full CLI launch. It intentionally stays small and outside ordinary agent/runtime updates.

An already-running older worker does not acquire final file capture or `--checkpoint-transform` merely because files were updated. Its selection-only restart can bootstrap an updated worker only when its actual accepted queues, pending input, next-turn messages and drafts are empty; the old handoff cannot transfer them. Do not infer queue contents from JSONL or clear them to manufacture eligibility.

Older managed launchers that forward the complete nested `checkpoint` object can remain loaded: updated workers carry original/candidate references and the prepared rollback program inside that object, retaining the original outer selection for the launcher's fallback arguments. No launcher update is required for that transport. Unmanaged older processes need a full updated CLI launch.

For source development, `src/cli-launcher.ts` is the managed entrypoint and `src/cli.ts` is the worker. The bundle emits these as `dist/bundle/cli.js` and `dist/bundle/cli-worker.js`, respectively.

## Validation

From `packages/coding-agent`, after building the runtime packages:

```bash
node ../../node_modules/vitest/dist/cli.js --run \
  test/restart-launcher.test.ts \
  test/suite/restart-control.test.ts \
  test/restart-tui.test.ts
```

The terminal tests require tmux and use a private server, isolated configuration and a faux provider. They make no network or paid model requests. They verify the replacement worker's process, loaded version and package directory, restored session and tool selection, single execution of completed work, and recovery from a failed candidate.
