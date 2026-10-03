# Background commands

`background_command` starts detached local shell jobs, reports their status and cancels them. Jobs and raw logs survive Pi exit/restart. Resume discovers existing work; it never restarts the command.

The CLI loads `builtin:background-command`. SDK hosts opt in with `createBackgroundCommandExtension()` in `DefaultResourceLoader.extensionFactories`, then call `session.bindExtensions({})`. The tool is active by default, subject to explicit allowlists, exclusions and saved selections. See [SDK](sdk.md#background-commands).

## Start, inspect and cancel

Use it for long tests, builds and watches; do not add `&` or repeatedly poll for completion.

```json
{"action":"start","command":"npm run check","timeout":600}
{"action":"status","activeOnly":true}
{"action":"status","id":"<job-id>"}
{"action":"cancel","id":"<job-id>"}
```

| Parameter | Behavior |
| --- | --- |
| `action` | Required: `start`, `status` or `cancel` |
| `command` | Required nonempty shell command for `start` |
| `cwd` | Start directory: absolute, `~` or relative to the effective shell directory |
| `timeout` | Start timeout in seconds; no default. Must be finite and positive, at most 2147483.647 |
| `id` | Job ID from this session; required for `cancel`, optional for `status` |
| `activeOnly` | Status lists only: include starting/running jobs; default `false` |
| `offset` | Nonnegative integer offset after filtering; default `0` |

Status with an ID returns a readable output tail capped at 16KB/100 lines. Without an ID, it lists at most 20 jobs newest first, with `total` and `nextOffset`. Read the returned absolute `logFile` for full output. Status is a snapshot, not a wait.

Jobs report `starting`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out` or `unknown`. Missing or inaccessible workers and corrupt records report an unknown outcome without hiding healthy jobs or rerunning commands. Cancellation can return `cancelRequested: true` while the worker is still stopping.

## Completion and lifetime

Completion notices enter after the entire foreground tool batch, during idle or after resume. They include the job ID, status, exit code when available, command preview and `logFile`. Success omits output; other outcomes include up to 2KB/20 lines. Do independent work or end the turn while waiting.

Persisted notices and terminal status results acknowledge jobs across reload/resume. One process at a time owns delivery for a shared session. After a delivery-owner crash, its filesystem lease normally expires in about 10 seconds before another process takes over.

Cancelling the agent leaves jobs running and records completions without waking the model. New user input clears wake suppression. Cancelling the job stops its shell process tree. `waitForIdle()` does not wait for detached jobs. Session shutdown releases the completion monitor; a disposed SDK context is cleaned up on its next idle tick without stopping jobs.

Print/JSON invocations can exit before completion. Use `bash` when the same invocation must wait for and report the result. Otherwise report the job as pending with its ID and log path, and resume the saved session later. An in-memory session retains job files but has no conversation to resume automatically.

## Storage and execution policy

Each job stores its record, atomic state and unchanged raw log under:

```text
<sessionDir>/background-commands/<sessionId>/<jobId>/
```

The detached worker executes the shell and writes job files, never the session journal. It uses effective `shellPath`, `shellCommandPrefix`, shell environment and current [session metadata](environment-variables.md#shell-tool-session-environment). Jobs require live compute and therefore block native working-session sleep readiness while unfinished; see [Native working sessions](working-session.md).

This is a separate native local execution tool. It does not use custom `BashOperations` backends or Bash cwd hooks. Overriding or excluding `bash` alone does not intercept it. Permission guards must also handle `background_command` with `action: "start"`; see [Security](security.md). The sandbox and SSH examples block starts while restrictions are active, leaving status/cancellation available. The plan-mode example hides the entire tool until plan mode is disabled.

For `pi-change-working-dir`, the synchronous `pi-change-working-dir:resolve-execution-cwd` event supplies the base for relative `cwd`. It is captured before worker admission; later directory changes affect later calls only. Owner errors or invalid replies refuse the start, as does an identifiable owner tool or `/cwd` command that fails to answer. Update that extension and restart rather than silently falling back. With no identifiable owner and no reply, the session cwd is used.
