# SDK

`@earendil-works/pi-coding-agent` embeds Pi in a Node.js or Bun process. It provides direct TypeScript access to the agent, sessions, tools, models, and resources used by the command-line application.

Use the SDK for in-process TypeScript integration. For a language-independent or isolated subprocess, see [CLI Integration](cli-integration.md).

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

try {
  await session.prompt("What files are in the current directory?");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose();
}
```

This uses the working directory, discovered resources, stored settings, and configured credentials. `prompt()` resolves when the run finishes.

The [complete minimal example](../examples/sdk/01-minimal.ts) also streams text events. All [SDK examples](../examples/sdk/) are typechecked with the repository.

<a id="session-management"></a>

## Session lifecycle

`createAgentSession()` creates an `AgentSession`. The session owns one conversation, its model and tools, queued messages, compaction state, and extension runtime.

Read current state through `session.messages`, `session.model`, `session.thinkingLevel`, `session.systemPrompt`, and `session.getActiveToolNames()`.

`session.systemPrompt` is read-only and returns the current effective system prompt, including changes that have not yet been sent to the model. Tool changes are declared to the model before the next request.

<a id="sessionmanager-api"></a>

### Session storage

Sessions are persistent by default. `SessionManager` owns the persisted or in-memory entry tree and tracks its active leaf. Branching changes that leaf without deleting abandoned branches. When Pi reconstructs model context, the manager selects the active branch and applies compaction.

`SessionManager` is authoritative for finalized model context. Restore external history by constructing the session with a manager containing those entries. Assigning `session.agent.state.messages` does not replace persisted context.

Use an in-memory manager when the host does not want session files:

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
```

See the checked [sessions example](../examples/sdk/11-sessions.ts) for creating, opening, continuing, listing, and forking sessions. [Session File Format](session-format.md) defines the persisted JSONL contract, and [Message Types](message-types.md) defines transcript values. For exact methods and signatures, use the exported TypeScript declarations or [`session-manager.ts`](../src/core/session-manager.ts).

`cwd` selects the workspace used for project resource discovery, context files, session grouping, and built-in tool paths. Pass it explicitly when the target differs from `process.cwd()`.

`session.dispose()` aborts active work, invalidates extension contexts, disconnects from the agent, and removes event listeners. Call it when the session is no longer needed.

`AgentSessionRuntime` adds `newSession()`, `switchSession()`, `fork()`, and `importFromJsonl()`. Each operation replaces the active `AgentSession` and recreates services for the target working directory.

After a runtime replacement, subscriptions belong to the old `AgentSession` and must be rebound. See the [session runtime example](../examples/sdk/13-session-runtime.ts).

## Prompting

`prompt()` handles extension commands and expands file-based prompt templates before ordinary user messages enter the agent. For an accepted agent run, it resolves after the run finishes, including automatic retries.

A prompt sent while the session is already streaming must specify whether it should steer the current run or follow it. Calling `prompt()` without that choice rejects rather than guessing.

Steering uses live input on supported Responses WebSocket routes and otherwise queues for the next turn. A follow-up enters after the current run finishes its pending work. `steer()` and `followUp()` expose those behaviors directly.

After extension commands and input interception, an idle session reserves the prompt before authentication, compaction, and `before_agent_start`. During preparation, `isStreaming` is true and `isIdle` is false; overlapping prompts obey the same queue/rejection rules. `PromptOptions.preflightResult` reports acceptance, queueing, handling, or rejection before `prompt()` resolves. Later provider failures use normal message events.

`abort()` signals admitted preparation and joins awaited work. A cancelled preflight rejects with `AbortError` without starting a model run. Failed preflight releases its reservation without emitting `agent_settled`; unconsumed queues and next-turn asides remain. Pre-admission `input` handlers are outside run cancellation.

`waitForIdle()` joins preparation, the full run, automatic continuations, and awaited settlement handlers. A deferred action can join child runs without waiting for its own enclosing drain; other callers still wait for later actions. A started run emits `agent_settled` once. During shutdown, waiting can finish while new-run admission remains closed.

### Pending input

| Session state | Counts |
|---|---|
| `hasPendingMessages` | Queued user/custom steering and follow-ups |
| `pendingMessageCount` | Pending user texts for display |
| `pendingNextTurnCount` | Unpersisted next-turn asides, excluded from the first two |
| `pendingInputCount` | Submitted input still in preflight or held by the bound mode; excludes dispatched extension commands |

SDK hosts can supply `getQueuedInputCount` through `bindExtensions()` for their own input queue. These observations do not consume input or change idle semantics.

`sendCustomMessage(message, { deliverAs: "steer", persistOnCancel: true })` opts undelivered streamed customs into once-only persistence before settlement, without requesting another turn. `clearQueue()` preserves opted-in messages, deferring append until a safe boundary while streaming, and returns queued user texts only. The default remains false; `nextTurn` asides survive queue clearing and reload.

### Background commands

The built-in `background_command` tool starts long shell commands without blocking a tool batch. For example, `{ action: "start", command: "gh pr checks --watch --fail-fast" }` returns a job ID and `logFile`. Completion carries the real exit status and a readable tail bounded to 16KB/100 lines. Use `read` for the complete raw log. `status` accepts a job `id`, or lists up to 20 jobs with `offset` and optional `activeOnly`. `cancel` requires an `id` and stops the native shell process tree; a pending cancellation is reported explicitly.

Jobs use the session's effective shell path, command prefix, environment, and native Bash cwd hooks. An optional `cwd` resolves relative to that selected directory. Each detached worker writes its job record, atomic state, and raw output beneath `<sessionDir>/background-commands/<sessionId>/<jobId>/`. Workers survive session disposal and Pi exit. Resume discovers existing work without replaying commands; a vanished or inaccessible worker reports an unknown outcome. Unreadable job records appear as bounded diagnostics without suppressing healthy jobs. In-memory sessions also retain job files, but have no saved conversation to resume automatically. Without a session directory, jobs use `PI_CODING_AGENT_SESSION_DIR`, the `sessionDir` setting, or `<agentDir>/sessions/` (in that order), still partitioned by the actual session ID. `--no-session --session-dir <path>` and `SessionManager.inMemory(cwd, { sessionDir })` select artifact storage without saving a conversation. Job and log paths are absolute, including with relative SDK session directories.

`AgentSession` owns notifications without requiring `bindExtensions()`. Completed jobs enter after the foreground tool batch or during idle, giving queued input and user Bash priority. Terminal status results and completion entries acknowledge jobs across reload/resume. Cancelling the agent leaves commands running and preserves their results without waking the model; a new admitted run clears that suppression. `background_command cancel` instead cancels the command itself.

`waitForIdle()` does not wait for external jobs. Print/JSON invocations can exit before completion; use synchronous `bash` when that invocation must consume the result. Checkpoint holds pause native notification writes, and checkpoint restore waits for explicit input. The host still owns external process quiescence.

Standalone `createBackgroundCommandTool(cwd, { sessionManager, ...shellOptions })` requires an explicit owner (or native execution context). `createCodingTools` and `createAllTools` accept that owner under `background_command`; automatic notifications belong to `AgentSession`. Hosts that collect startup input asynchronously can set `deferBackgroundCommandNotifications: true`, then bind their `getQueuedInputCount` before admitting prompts. Native CLI modes do this themselves.

Background workers use the running Pi code, independently of the `PI_PACKAGE_DIR` asset override. They support native local shell execution, not custom `BashOperations` backends. Shell permission guards and Bash overrides must also handle `background_command` with `action: "start"`; overriding or excluding `bash` alone does not intercept or disable this separate tool. The shipped sandbox and SSH examples block background starts while their custom backend is active; status and cancellation remain available.

New sessions include this tool by default. Existing saved selections and explicit allowlists are preserved. SDK hosts can enable it with `session.setActiveToolsByName([...session.getActiveToolNames(), "background_command"])` when the permitted registry includes it.

### Native asynchronous tools and steering

Set `async: true` on a `ToolDefinition` for capable Responses routes. Execution begins only after an authoritative completed async call, argument preparation, validation, and `tool_call` hooks. The journal records the original provider item and admitted arguments before side effects. `executionMode` still controls local sequential/parallel execution.

`tool_execution_start` begins preflight; `tool_execution_prepared` provides admitted arguments. Final results preserve original call IDs and may arrive after later assistant messages. `elapsedMs` measures executor time, excluding validation and hooks; blocked calls omit it.

A durable tool can implement `resume(toolCallId, params, signal, onUpdate, ctx)`. For a journaled started call without a result, Pi uses its saved admitted arguments without repeating preflight or `execute`. Return the actual result, or `undefined` when recovery is unavailable; missing recovery becomes an unknown/interrupted outcome.

Only an aborted native async invocation whose external owner retains durable work may return `{ ...result, pending: true }`. Pi emits `tool_execution_detached` without a final result. Local settlement may follow while external work remains. `session.getPendingToolCalls()` and `ctx.getPendingToolCalls()` expose `{ toolCallId, toolName, namespace?, state: "pending" | "started" | "detached" }`; the next prompt or continuation reattaches journaled started calls. Ordinary background launch-handle results are unchanged. Detect host support by method presence and model support separately through `compat.supportsAsyncTools`.

Live steering reports `queued`, `accepted`, `pending`, `applied`, `failed`, or `unknown`. Acceptance does not prove application. Input waiting for tools continues on the same connection with the original results. Disconnect recovery reconstructs known items, results, and one logical input from local history; unobserved remote application stays unknown. Images are normalized before delivery.

Automatic successors have separate assistant lifecycles and usage. `message_start.continuationInput` snapshots the user inputs and submitted results added to the preceding response: absent on the first response, empty for a known empty delta. They already have message events; do not append them twice. `message_checkpoint` is an execution snapshot of the same response, not another billable response. See [JSON events](json.md) and [session persistence](session-format.md#sessionmessageentry).

Routes with `compat.supportsReasoningEffortUpdates` retain initial effort, persist `providerThinkingLevel`, and insert coalesced positional updates. Omitted Astra effort is recorded as `medium`. Automatic provider compaction, truncation, and nonstandard reasoning modes do not use this path; explicit opaque compaction items are replayed unchanged.

### Fresh context windows

`session.newContext({ handoff? })` preserves the complete journal while replacing model context with the current prompt/tools and an optional handoff. During a run, it applies at request preparation after native tool obligations drain; it never drops a still-pending call to force a boundary. `context_window_started` tells active-context UIs to rebuild. This differs from summary compaction, which retains selected conversation and tool dependencies. Extensions can claim automatic compaction with the same primitive through `session_before_auto_compact`; see [Compaction](compaction.md).

### Working-session checkpoints

`acquireCheckpoint({ boundary, signal?, quiesce? })` holds native activity after awaited persistence and callbacks. Release in `finally`; check the hold's abort signal throughout capture. `createAgentSession({ checkpoint: readSessionCheckpoint(path) })` restores exact selection, tool restrictions, and pending queues without running them. Bind extensions before prompting so startup can reconstruct dynamic tools and validate the saved selection. An absent saved model preserves no selection.

The hold's `sleepReady` and `sleepBlockers` describe the native session only. The archive owner still coordinates other writers and preserves the matching files. See [Working-session checkpoints](checkpoint.md).

### User Bash

`executeBash(command, onChunk?, options?)` owns interception, selected local/custom operations, and result recording for interactive `!`/`!!`, RPC `bash`, and SDK callers. A replacement result is recorded once and sent to `onChunk`; normal execution also emits `bash_execution_update`.

`isBashRunning` stays true through asynchronous interception and every concurrent call's completion. `abortBash()` signals all calls; cancellation during interception prevents later shell execution but still waits for that handler. User Bash remains separate from agent idle.

## Subscribing to events

Subscribe before prompting when the host needs streamed output:

```typescript
const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("Explain this repository");
} finally {
  unsubscribe();
}
```

Session events report message updates, tool execution, queues, compaction, retries, and run lifecycle changes.

`message_end` contains the authoritative completed message. `agent_end` marks the end of one low-level agent run, but automatic recovery or queued work can still follow.

Use `agent_settled` when the host needs to know the local run will not continue automatically. Its optional `pendingToolCalls` identifies detached external obligations.

## Configuring a session

Without overrides, the factory creates a `ModelRuntime`, file-backed `SettingsManager`, persistent `SessionManager`, `DefaultResourceLoader`, and the configured default tools.

Each boundary can be supplied explicitly:

- `modelRuntime`, `model`, `thinkingLevel`, and `scopedModels` control model access and selection.
- `settingsManager` supplies merged settings or an in-memory configuration.
- `sessionManager` supplies persistent or in-memory conversation history.
- `resourceLoader` supplies extensions, skills, prompt templates, themes, and context files.
- `tools`, `noTools`, `excludeTools`, and `customTools` control the active tool set.

Use `DefaultResourceLoader` when you want standard discovery with selected overrides. Supply a custom `ResourceLoader` when the host owns resource storage and discovery completely.

<a id="inlineextension"></a>

Inline extension factories can be supplied through `DefaultResourceLoader`. Give one an `InlineExtension` name only when it needs a stable name in diagnostics and startup output.

See the focused examples for [models](../examples/sdk/02-custom-model.ts), [tools](../examples/sdk/05-tools.ts), [extensions](../examples/sdk/06-extensions.ts), and [full control](../examples/sdk/12-full-control.ts).

### Model availability

Use `modelRuntime.getModel(provider, id)` to include configured overrides. `getAvailable()` returns healthy providers; a failed provider check does not silently replace an existing saved/default or explicitly scoped model. `getAuthCheckError(providerId)` and `getError()` expose diagnostics without inventing auth or subscription metadata. Direct provider availability/auth calls still reject on failure. A successful refresh clears its diagnostic. Cancellation and credential-store failures reject aggregate refresh without replacing the previous snapshot.

For factory-registered providers needed before selection, create services with `createAgentSessionServices()` before `createAgentSessionFromServices()`. See [ambient authentication](custom-provider.md#ambient-authentication). RPC can inspect a pre-login session and run non-model extension commands; model prompts still require selection, and print/JSON require one at startup.

### Context usage

`getContextUsage()` is synchronous. It preserves matching measured usage, including opaque reasoning, and estimates changes to prompt/tools and trailing input relative to that total. It does not count earlier output again. Model/provider/API changes, edits, and context boundaries invalidate inapplicable measurements; ending a request-only forced prompt preserves idle usage.

`source` is `reported`, `estimated`, or `unknown`; tokens may be null after compaction. Estimates are not exact provider counts. A resumed session without a captured request prefix uses the larger of matching reported usage and visible-context estimates. Extensions should use `ctx.getCompactionSettings()` for current effective per-model thresholds rather than rereading files.

### Settings and reload

`SettingsManager.create(cwd, agentDir?)` loads file-backed settings. `applyOverrides()` changes effective values only. Unrelated setters retain temporary overrides; explicit setters replace their own fields, subject to project precedence. Reload/trust changes discard overrides; initial `inMemory()` values survive reload.

`DefaultResourceLoader.reload()` reloads settings too. Load resources before applying temporary overrides and pass that loader into `createAgentSession()` to avoid its implicit reload. `flush()` joins queued writes; `flush({ requireSuccessfulPersistence: true })` also rejects unresolved dirty fields/load failures, even after diagnostics are drained.

`session.reload()` reinitializes cached extension factories and refreshes resource paths/settings. Restart the host to apply code or dependency updates; another session or working directory does not clear native module caches.

### Tool identity and discovery

`tools` and `excludeTools` accept bare names for unnamespaced tools or exact `{ name, namespace? }` references. Bare names never select a same-name namespaced tool. `getActiveToolNames()` returns opaque public IDs from `getAllTools()[].id`; pass them unchanged to `setActiveToolsByName()`. Selection replaces the full loadout, including `[]`, without widening permissions. Exact-reference getters/setters and extension discovery use the same registry. See [tool discovery](extensions.md#tool-discovery).

### JSON selection with read

`read` accepts `json: { path?, fields? }` before paging and truncation:

```typescript
import { createReadTool } from "@earendil-works/pi-coding-agent";

const read = createReadTool(process.cwd());
const result = await read.execute("summary", {
  path: "report.json",
  json: { path: "/rows", fields: ["name", "status"] },
});
```

`path` is a JSON Pointer, defaulting to the root (`""`). Escape `~` as `~0` and `/` as `~1`. `fields` keeps literal immediate keys on an object or each object in an array. Missing keys are omitted; false/zero/null values, array order, and row count remain. Omit fields to select any value; `json: {}` pretty-prints the root.

Invalid JSON/pointers, missing selected paths, image selection, or non-object rows with `fields` fail. `offset` and `limit` count pretty-printed lines; the 2000-line/50KB caps still apply. Continue with the same JSON options and returned offset. Output may be a fragment plus a notice. The whole file is still parsed with normal `JSON.parse` precision and duplicate-key semantics; this is not a query language.

### File and shell operations

Queue a complete read-modify-write operation with `withFileMutationQueue(absolutePath, callback)`. Symlink aliases, dangling final links, and missing parents resolve through the nearest existing ancestor so supported aliases share a queue.

`publishLocalFile(absolutePath, stringOrBytes, signal?)` stages beside the target and replaces it by rename. Its parent must exist; it does not own a queue. The SDK exports the same helper as `@earendil-works/pi-agent-core/node`. Default local `write`, `edit`, and `NodeExecutionEnv` use it. Failures before rename preserve existing bytes; once submitted, the actual rename result wins over cancellation.

Publication follows existing/dangling final symlinks, checks target write access, and preserves ordinary mode and numeric owner/group or fails before replacement. A writable parent is also required. Hardlinks and open handles keep the old file. ACLs, extended attributes, other platform metadata, and power-loss durability are not guaranteed. Custom backends retain their own semantics.

Custom `BashOperations` and `PowerShellOperations` producers must call `onData(data, source)` with unchanged Buffer bytes and `stdout`/`stderr` identity, then `onEnd(source)` once after each pipe's final data, including errors. Stop callbacks before resolving/rejecting `exec`; cancellation alone is not EOF. Each pipe is decoded independently so interleaved output preserves split UTF-8. Cross-pipe ordering is not guaranteed. Wrappers forwarding options unchanged need no adaptation.

`pi.registerBashCwdHook((cwd) => nextCwd)` changes cwd before built-in Bash and background-command preflight and native user Bash operations. Synchronous hooks chain in extension load/registration order and are replaced on reload/session replacement; errors stop execution. This does not change session headers, project resources, other tools, overridden Bash tools, or factory spawn hooks. Detect support by method presence.

## Examples

| Example | Purpose |
|---|---|
| [Minimal](../examples/sdk/01-minimal.ts) | Create, prompt, observe, and dispose a session |
| [Custom model](../examples/sdk/02-custom-model.ts) | Select a model and thinking level |
| [System prompt](../examples/sdk/03-custom-prompt.ts) | Replace or append to the system prompt |
| [Skills](../examples/sdk/04-skills.ts) | Discover, filter, and add skills |
| [Tools](../examples/sdk/05-tools.ts) | Select built-in tools and their working directory |
| [Extensions](../examples/sdk/06-extensions.ts) | Load file-based and inline extensions |
| [Context files](../examples/sdk/07-context-files.ts) | Add or replace project instructions |
| [Prompt templates](../examples/sdk/08-prompt-templates.ts) | Add file-style prompt templates |
| [Credentials](../examples/sdk/09-api-keys-and-oauth.ts) | Configure credential and model storage |
| [Settings](../examples/sdk/10-settings.ts) | Supply file-backed or in-memory settings |
| [Sessions](../examples/sdk/11-sessions.ts) | Control session persistence and restoration |
| [Full control](../examples/sdk/12-full-control.ts) | Replace default discovery and state services |
| [Session runtime](../examples/sdk/13-session-runtime.ts) | Replace the active session safely |

<a id="exports"></a>

## Resources

- [Choose a Model](models.md) covers model selection and compatible endpoints; [Provider Authentication](providers.md) covers credentials and cloud-provider setup.
- [Configuration](configuration.md) explains normal discovery and settings; [Settings](settings.md) lists every setting.
- [Sessions and Context](sessions.md) explains session behavior; [Session Format](session-format.md) defines persisted entries; [Message Types](message-types.md) defines shared transcript values.
- [Extensions](extensions.md), [Skills](skills.md), and [Prompt Templates](prompt-templates.md) document resources supplied through a `ResourceLoader`.
- [CLI Integration](cli-integration.md) covers print, JSON, and RPC alternatives to an in-process SDK integration.
