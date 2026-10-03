# Managed restarts

The bundled Node CLI runs Pi inside a worker, with a small launcher outside the agent process. Restart replaces the worker and opens the **same saved session file**. It does not replay startup prompts, attachments, completed commands, or provider requests.

Use `/reload` for changed extension source and resources in the current process. Use restart for core/runtime changes or a clean process.

## Request a restart

From a Pi shell tool:

```bash
pi restart --message "Verify the updated tool, then continue the task"
```

The response says **Restart queued**, not ready or successfully activated. Pi waits for final idle: no streaming, running tools, automatic retry/compaction, queued steering/follow-up messages, or unfinished `agent_settled` handlers and their deferred actions. It runs `session_shutdown` handlers, exits gracefully, then starts the replacement.

In the TUI, `/restart` does the same. `/restart <text>` supplies a continuation. Without text, the replacement waits for input. Supplied text is sent once, labelled `[Restart continuation]`.

Requests require a saved session. Ephemeral sessions, stale session IDs, invalid runtime/extension paths, unsent editor drafts, and pending input that would be lost are refused. Drafts or pending input arriving after queueing cancel the restart rather than being discarded. An external editor or blocking dialog postpones restart; a returned draft cancels it. Interrupting the run, retry, or compaction cancels a pending restart. Normal quit and termination signals never request a replacement.

`pi restart --help` lists options, examples and exit codes. Exit 0 means queued (or help); exit 1 means invalid options, unavailable control endpoint, or a refused request. Outside a managed interactive Pi shell, the command fails with a clear error.

## Stage changes without overwriting the working version

```bash
pi restart -e /staged/my-tool-v2.ts -e /path/to/keep.ts \
  --message "Confirm the updated tool and continue"
```

Supplying `-e` / `--extension` **replaces the explicit CLI extension list**. Include every explicit extension you want to keep. Omitting it preserves that list. Local paths resolve from the requesting shell's working directory; `builtin:<name>` is also accepted. Discovery, tool-selection and trust flags are retained; restart does not enable discovery or silently approve a project.

For runtime changes:

```bash
pi restart --runtime /staged/pi-coding-agent \
  --message "Validate the new runtime and continue"
```

The package directory must contain `dist/bundle/cli-worker.js`. `--runtime` pins that exact worker for later restarts. Another `--runtime` changes the pin; a full CLI launch returns to following the original invocation path.

Without a pin, each restart re-resolves the original invocation path, including the npm-global package symlink. A concrete release path or source entrypoint stays at that location. There is no managed-installer version-pointer protocol.

**Keep the working runtime, dependencies and extension files intact.** Activate separate staged paths. Rollback selects the previous worker and arguments; it cannot undo file edits, restore Git state, or reverse external side effects.

## Startup recovery

Readiness is signalled only after TUI initialization. If the selected worker cannot start, exits before readiness (even with exit 0), or is not ready within 60 seconds, the launcher starts the **exact previous worker and arguments once**, resuming the same saved session with the previous explicit extensions and pin policy. The startup failure is shown as a warning; when a message was supplied, the labelled continuation also includes it. Without a message, no model turn starts. If recovery also fails, Pi stops; it never loops.

Readiness is not proof that every provider or tool works. Validate candidates first. Failures after readiness are not automatically rolled back or replayed, because work may already have had side effects.

### Upgrading sessions started by the 0.99 fork

Sessions started by the 0.99 fork launcher must **quit and relaunch** using `pi -c` or `pi --session <file>` to use the new runtime. Do not `/restart` across the cutover: the new worker rejects the legacy handoff before opening a session, and the old launcher rolls back to the old runtime. In fullscreen mode the old TUI can hide that error. There is no legacy-schema conversion or compatibility layer.

Session history remains the authority. Restart uses the complete [native working-session format](working-session.md) to preserve the selected leaf, all branches, effective settings and current loadout. Original CLI options are retained except session-selection flags, consumed startup prompts/attachments, and `--model`/`--provider`/`--thinking`. With `--api-key`, the launch model is kept because the key applies to it; the key is never serialized. Extensions persist their own state with ordinary session entries and shutdown handlers. Restart still waits for runnable queues to drain and refuses pending next-turn context. It does not transfer arbitrary callback memory, migrate the runtime or replay completed effects.

The captured settings are restored before discovery and extension factories. To adopt settings-file edits, use `/reload`. Each restart creates a private state file that remains available through startup rollback; the launcher removes it after a replacement becomes ready or the launch ends. A user-supplied `--working-session` file remains untouched.

## Scope and development

Print, JSON and RPC modes do not expose the interactive control endpoint. SDK hosts and standalone binaries retain their existing lifecycle. Managed control remains available with `-ne`, which still disables ordinary extension discovery.

While managed control is active, restart guidance is projected into each request's leading system message. It remains available across idle or deferred custom-message wakeups, tool batches, reloads and saved-session resume; it does not depend on a new user prompt. Forced user-run prompts still receive the guidance once, without persisting or restoring the forced text on later runs. This does not change the user-only `before_agent_start` event or initialize the full native base prompt for a fresh custom-message run.

The local socket lives inside a private temporary directory (a named pipe on Windows). It is recreated on reload/session replacement and removed on shutdown. Long Unix socket paths fall back to a short temporary root: the Node runtime's sibling `tmp` directory on Android/Termux, `/tmp` elsewhere. If control cannot initialize on a fresh launch, Pi warns and remains usable without restart; a replacement launch fails so its parent can roll back. It is not a security boundary against other code running as the same user. Extensions remain trusted code; see [Security](security.md).

The launcher stays loaded across worker replacements. Launcher changes require a full CLI launch. Source development uses `src/cli-launcher.ts`; `src/cli.ts` remains the ordinary worker entrypoint. The bundle emits these as `dist/bundle/cli.js` and `dist/bundle/cli-worker.js`. The installer helper `getRestartRuntimeWorker` remains exported from `dist/cli/launcher.js`.

## Validation

The source-level guidance regression needs no build or installed CLI. From the repository root:

```bash
./test.sh -- bash -c 'cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/restart-guidance.test.ts --maxWorkers=1'
```

It uses the actual restart factory, native SDK harness, fork IPC and private control socket, with a faux provider. GLM, Responses and Codex payloads are captured before transport to verify unchanged leading instructions and submitted prefixes; this is not a measured provider cache-hit guarantee. It also checks forced-run scope and unrelated system content/tool updates. It does not replace the process-replacement terminal smoke test.

After building the runtime packages, from `packages/coding-agent`:

```bash
node ../../node_modules/vitest/dist/cli.js --run \
  test/restart-launcher.test.ts test/restart-tui.test.ts --maxWorkers=1
```

The terminal test requires tmux, uses a private socket and isolated HOME, and makes no network or paid provider calls. Set `PI_TEST_CLI=/installed/release/dist/bundle/cli.js` to test an installed release. Tests verify actual process replacement, same-session resume, continuation exactly once, no replay of completed side effects, explicit extension replacement, and one-shot startup rollback.
