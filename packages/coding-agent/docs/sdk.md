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

### Complete working-session save and restore

`session.acquireWorkingSession()` reserves an awaited native cut and returns complete private state with separate invalidation and release lifetimes. `createAgentSession({ workingSession })` restores the selected leaf, all branches, full pending payloads and native loadout before extension startup, without replaying interrupted work. See [Native Working Sessions](working-session.md) for readiness, persistence hooks, mode buffers and the conditional CLI socket/final-exit contract.

Saved trust, offline policy and effective settings are applied before native resource discovery and extension factories. Global/project settings layers retain relative resource origins and global-only preferences without rewriting settings files. Required saved extension failures reject restoration.

<a id="background-commands"></a>

### Background commands

The CLI loads `builtin:background-command`. SDK hosts opt in by adding `createBackgroundCommandExtension()` to `DefaultResourceLoader.extensionFactories`, then calling `session.bindExtensions({})` to initialize resume monitoring. The tool registers active by default; explicit allowlists and saved tool selections are preserved.

`background_command` accepts `action: "start" | "status" | "cancel"`. Start requires `command`; optional `cwd` resolves from the session working directory (including `~`), and `timeout` is seconds with no default. Cancel requires a job `id`. Status with an `id` returns a readable output tail capped at 16KB/100 lines. Without an `id`, it lists at most 20 jobs newest first, with `offset`, `nextOffset`, and optional `activeOnly` filtering. Negative offsets and invalid timeouts are rejected.

Detached workers use the effective `shellPath`, `shellCommandPrefix`, shell environment, and current `PI_*` session metadata. Each writes its job record, atomic state, and unchanged raw log beneath `<sessionDir>/background-commands/<sessionId>/<jobId>/`. Paths are absolute. Jobs survive Pi exit and session disposal; resume discovers existing work without restarting it. Missing or inaccessible workers report an unknown outcome. Corrupt records do not hide healthy jobs. In-memory sessions retain job files but have no conversation to resume automatically.

Completion messages enter after the entire foreground tool batch, during idle, or after resume. They include job ID, status, exit code when available, command preview, and `logFile`. Success omits output; other outcomes include up to 2KB/20 lines. Read `logFile` for the full output. Persisted notices and terminal status results acknowledge jobs across reload/resume; one process at a time owns delivery for a shared session. After a crashed delivery owner, its filesystem lease expires (normally about 10 seconds) before another process takes over.

Cancelling the agent leaves jobs running and records completions without waking the model; new user input clears wake suppression. Cancelling the job stops its shell process tree. `waitForIdle()` does not wait for external jobs. Print/JSON invocations may exit before completion; use `bash` when the same invocation must consume the result. Session shutdown releases the completion monitor; a disposed SDK context is cleaned up on its next idle tick without stopping detached jobs.

This tool supports native local execution only, not custom `BashOperations` backends or Bash cwd hooks. It honors `pi-change-working-dir` through the synchronous `pi-change-working-dir:resolve-execution-cwd` event: the owner's valid absolute cwd becomes the base for relative `cwd` parameters. The base is captured before worker admission; later directory changes affect only later calls. Owner errors and invalid replies reject the start instead of falling back to the session cwd. An identifiable `pi-change-working-dir` tool or `/cwd` command that does not answer also rejects the start with an update-and-restart instruction. With no identifiable owner and no reply, the session cwd is used. Overriding or excluding `bash` alone does not intercept this separate tool. Permission guards must also handle `background_command` with `action: "start"`. The shipped sandbox and SSH examples block background starts while their restrictions are active; status and cancellation remain available. The plan-mode example hides the entire tool, including status and cancellation, until plan mode is disabled.

## Prompting

`prompt()` handles extension commands and expands file-based prompt templates before ordinary user messages enter the agent. For an accepted agent run, it resolves after the run finishes, including automatic retries.

A prompt sent while the session is already streaming must specify whether it should steer the current run or follow it. Calling `prompt()` without that choice rejects rather than guessing.

A steering message enters after the current assistant turn and its tool calls. A follow-up enters after the current run finishes its pending work. `steer()` and `followUp()` expose those behaviors directly and return `"queued"` if the input was queued (including after an extension transformed it), or `"handled"` if an extension consumed it.

`abort()` stops the active operation and waits for the session to become idle. `waitForIdle()` waits without aborting it.

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

Use `agent_settled` when the host needs to know that Pi will not continue automatically.

## Configuring a session

Without overrides, the factory creates a `ModelRuntime`, file-backed `SettingsManager`, persistent `SessionManager`, `DefaultResourceLoader`, and the configured default tools.

Each boundary can be supplied explicitly:

- `modelRuntime`, `model`, `thinkingLevel`, and `scopedModels` control model access and selection.
- `settingsManager` supplies merged settings or an in-memory configuration.
- `sessionManager` supplies persistent or in-memory conversation history.
- `resourceLoader` supplies extensions, skills, prompt templates, themes, and context files.
- `tools`, `noTools`, `excludeTools`, and `customTools` control the active tool set.

Use `DefaultResourceLoader` when you want standard discovery with selected overrides. Supply a custom `ResourceLoader` when the host owns resource storage and discovery completely.

`PI_CACHE_TRACE_DIR` enables temporary private native request tracing with SDK session, purpose
and reload provenance. Low-level request options accept an optional `cacheTraceContext` for
already-known owner annotations; it is never sent to the provider. Tracing does not resolve
credentials or enable warming. See [Passive cache investigation](cache-tracing.md) for privacy,
coverage ceilings, offline classification and required cleanup.

<a id="inlineextension"></a>

Inline extension factories can be supplied through `DefaultResourceLoader`. Give one an `InlineExtension` name only when it needs a stable name in diagnostics and startup output. A named inline extension with `replaceable: true` is left out when another extension registers a tool, command, or flag with a name it registers during loading, instead of both loading with a conflict. The CLI's built-in codemode, tool search, and MCP extensions are replaceable. A named entry with `builtin: true` is not an inline extension: it supplies the code of the `builtin:<name>` extension, which loads like a configured extension file. It loads by default, is listed in `pi config`, and is disabled by `-builtin:<name>` in the `extensions` setting or by `noExtensions`; `additionalExtensionPaths: ["builtin:<name>"]` loads it explicitly. It loads after project trust is resolved, so it cannot handle `project_trust`. The CLI's built-in extensions use it.

<a id="codemode-mcp"></a>

The CLI loads `codemode`, `tool_search`, and MCP as built-in extensions. SDK sessions do not; add `createCodemodeExtension()`, `createToolSearchExtension()`, and `createMcpExtension()` to the `extensionFactories` of `DefaultResourceLoader`. `codemode` and `tool_search` are registered inactive: enable them through the `defaultTools` setting (`["+codemode", "+tool_search"]` keeps the other default tools), or let the MCP extension activate them: `codemode` for servers with `codemode` exposure, `tool_search` for servers with `deferred` exposure. The MCP extension connects its servers on `session_start`, so call `session.bindExtensions()`. See [Codemode and MCP](../examples/sdk/14-codemode-mcp.ts).

For full on-demand owner instructions, add the exported `instructionGroupsExtension` factory alongside owner extensions and call `session.bindExtensions()`. It registers `discover_tools` active by default, subject to tool selection and exclusions. The CLI loads it as the replaceable `builtin:instruction-groups` extension. Discovery hides declarations until enabled without changing callable permissions; see [Instruction Groups](instruction-groups.md).

See the focused examples for [models](../examples/sdk/02-custom-model.ts), [tools](../examples/sdk/05-tools.ts), [extensions](../examples/sdk/06-extensions.ts), and [full control](../examples/sdk/12-full-control.ts).

### JSON selection with read

`read` accepts `json: { path?, fields? }` to select part of a JSON file before paging and truncation:

```typescript
import { createReadTool } from "@earendil-works/pi-coding-agent";

const read = createReadTool(process.cwd());
const result = await read.execute("summary", {
  path: "report.json",
  json: { path: "/rows", fields: ["name", "status"] },
});
```

- `path` is a JSON Pointer and defaults to the root (`""`). `/rows/0` selects the first array item. In keys, escape `~` as `~0` and `/` as `~1`.
- `fields` keeps the listed immediate keys of the selected object, or of each object in a selected array. Keys such as `"a.b"` are literal names, not paths. Missing keys are omitted; `null`, `false`, and `0` values are kept. Array order and length stay the same, so a row without any listed key becomes `{}`.
- Without `fields`, the whole selected value is returned, including arrays and scalars. `json: {}` pretty-prints the whole file.

Invalid JSON, an invalid or missing pointer target, `json` on an image, and `fields` on anything other than an object or an array of objects produce tool errors.

`offset` and `limit` count lines of the pretty-printed selection, and the usual 2000-line and 50KB limits apply. To continue, pass the same `json` options with the returned offset. A paged or truncated result can be a JSON fragment followed by a continuation notice.

The whole file is still read and parsed with `JSON.parse`, so large numbers can lose precision and the last duplicate key wins. Selection is not a query language: it has no filters or computed values.

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
| [Codemode and MCP](../examples/sdk/14-codemode-mcp.ts) | Add the `codemode`, `tool_search`, and MCP extensions |

<a id="exports"></a>

## Resources

- [Choose a Model](models.md) covers model selection and compatible endpoints; [Providers](providers.md) covers credentials and provider-specific setup.
- [Configuration](configuration.md) explains normal discovery and settings; [Settings](settings.md) lists every setting.
- [Sessions and Context](sessions.md) explains session behavior; [Session Format](session-format.md) defines persisted entries; [Message Types](message-types.md) defines shared transcript values.
- [Extensions](extensions.md), [Skills](skills.md), and [Prompt Templates](prompt-templates.md) document resources supplied through a `ResourceLoader`.
- [CLI Integration](cli-integration.md) covers print, JSON, and RPC alternatives to an in-process SDK integration.
