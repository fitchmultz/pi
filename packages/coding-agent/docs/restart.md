# Managed Restarts

The Node CLI can restart its agent process and resume the same saved session. A small launcher stays outside the agent process, so applying extension or runtime code changes does not require the user to restart Pi manually.

This is different from `/reload`, which refreshes resources but retains cached extension code.

## Request a Restart

From a Pi shell tool:

```bash
pi restart --message "Verify the updated tool, then continue the task"
```

The command acknowledges **queueing**, not successful activation. Pi waits for final idle, including sibling tools, automatic retries, compaction and queued continuations. It shuts down gracefully, starts a fresh worker, restores the session, and submits the supplied text as a clearly labelled restart continuation.

Without `--message`, the replacement opens the session and waits for input. In the TUI, `/restart` does the same; `/restart <text>` also supplies a continuation.

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

The directory must contain the built `dist/bundle/cli-worker.js`. Runtime and extension options can be combined. Paths resolve from the requesting shell's working directory.

**Keep the previous runtime, dependencies and extension files intact.** Rollback selects the previous launch configuration; it does not undo file edits, restore Git state, or reverse external side effects. An in-place overwrite of the only working version cannot be rolled back by restarting the same files.

## Recovery and Session State

The launcher starts the replacement only after the outgoing worker exits successfully. It passes the exact session file, current working directory, branch, model, thinking level and tool selection. Earlier startup prompts and file attachments are not replayed. The session journal remains the source of conversation history; in-memory extension state must still be persisted by the extension. Remaining CLI startup prompts are counted as pending input and run before the restart.

Stored credentials are unchanged. A CLI `--api-key` is forwarded only while its original provider is still selected; after a provider change, Pi uses normal credential resolution rather than sending that key to a different provider.

A replacement becomes ready after runtime creation and TUI initialization. If it fails or takes more than 60 seconds to reach readiness, the launcher tries the previous runtime and explicit extension list once, against the same checkpoint. A supplied continuation includes the startup failure notice so the agent can diagnose it. If recovery also fails, Pi stops instead of entering a restart loop.

Readiness is not proof that every tool or provider works. Validate candidates before requesting activation. Failures **after readiness** are not automatically replayed or rolled back: doing so could duplicate work whose side effects already occurred.

The control endpoint is local and session-scoped. On Unix it lives inside a private temporary directory. It is replaced on resource reload/session replacement and removed during shutdown. It is not a permission boundary within the user's account, and staged extensions remain full-trust code. See [Security](security.md).

## Scope and First Startup

Managed restart is provided by the bundled Node CLI. Print, JSON and RPC modes do not expose the interactive restart endpoint; SDK hosts and standalone binaries retain their existing lifecycle behavior.

The launcher itself remains loaded across worker replacements. Changes to launcher code take effect on the next full CLI launch. It intentionally stays small and outside ordinary agent/runtime updates.

An already-running older Pi process does not acquire this feature merely because files were updated. Start the updated CLI once with `--session <saved-session-file>` to establish the launcher. Subsequent worker/runtime updates can use the managed path.

For source development, `src/cli-launcher.ts` is the managed entrypoint and `src/cli.ts` is the worker. The bundle emits these as `dist/bundle/cli.js` and `dist/bundle/cli-worker.js`, respectively.

## Validation

From `packages/coding-agent`, after building the runtime packages:

```bash
node ../../node_modules/vitest/dist/cli.js --run \
  test/restart-launcher.test.ts \
  test/suite/restart-control.test.ts \
  test/restart-tui.test.ts
```

The terminal tests require tmux and use a private server, isolated configuration and a faux provider. They make no network or paid model requests. They verify that an updated tool runs in a new process in the same session, that a failed candidate recovers, and that completed tool calls and the original startup prompt are not replayed.
