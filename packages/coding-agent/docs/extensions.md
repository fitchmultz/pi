# Extensions

Extensions are TypeScript modules that add executable behavior to Pi. Use one when a workflow needs tools, commands, event handlers, model providers, session state, or terminal UI rather than instructions alone.

An extension runs inside the Pi process with the same operating-system permissions. It can inspect prompts, tool calls, files, credentials, and session history, so load extensions only from sources you trust.

Typical extensions add an agent tool, protect paths, confirm dangerous commands, react to session events, modify context, expose a command, or display persistent status.

<a id="quick-start"></a>
<a id="writing-an-extension"></a>
<a id="create-an-extension"></a>

## Create and load an extension

An extension exports a default factory that receives `ExtensionAPI`. The factory registers capabilities for the current extension runtime.

Create `~/.pi/agent/extensions/hello.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

Start Pi and run `/hello`. During development, load a file directly:

```bash
pi --extension ./hello.ts
```

Pi uses `jiti`, so local TypeScript extensions do not need a separate compilation step. Use [Pi packages](packages.md) for distributed extensions and dependencies.

<a id="extension-locations"></a>
<a id="available-imports"></a>
<a id="choose-where-it-loads"></a>

## Add it to Pi

Place the extension in your user or project extensions directory. Pi loads direct TypeScript or JavaScript files and subdirectories containing an `index.ts` or `index.js` entry point.

Use a single file for a small extension and a directory for a multi-file implementation. Put npm dependencies in a nearby `package.json`. See [Configuration](configuration.md) for conventional locations and [Settings](settings.md#resources) for additional paths.

`/reload` refreshes settings and resources and reinitializes cached factories. Code and dependency updates require a full process restart; see [Managed Restarts](restart.md). Path and enable/disable settings still apply, and new entrypoints can load. After `await ctx.reload()`, return without reusing old runtime state. Only personal and explicit command-line extensions can participate in the `project_trust` event that runs before project extensions load.

<a id="understand-the-lifecycle"></a>

## Respect the runtime lifecycle

The factory can be synchronous or asynchronous. Pi waits for an asynchronous factory before startup continues, allowing it to fetch configuration or register providers needed during startup.

Do not start processes, sockets, watchers, or timers in the factory because some invocations load extensions without starting a session.
Start long-lived resources from `session_start` or from the command or tool that needs them.
Close session-scoped resources from an idempotent `session_shutdown` handler.

A run proceeds from input and `before_agent_start`, through model, message, and tool events, to `agent_end`.
Automatic retries, recovery, compaction, or queued work can continue afterward.
<a id="agent_start--agent_end--agent_before_settle--agent_settled"></a>

`agent_before_settle` is the final actionable boundary: it can append entries and request one continuation.
`agent_settled` is final and notification-only; use it when an integration needs to know Pi will not continue automatically.

<a id="extensionapi-methods"></a>

## Choose an integration point

| Capability | Main API |
|---|---|
| Observe or modify lifecycle behavior | `pi.on()` |
| Add a model-callable operation | `pi.registerTool()` |
| Discover and activate registered tools | `pi.registerToolSearch()` |
| Add a `/` command | `pi.registerCommand()` |
| Add a shortcut or CLI flag | `pi.registerShortcut()` or `pi.registerFlag()` |
| Send user or custom messages | `pi.sendUserMessage()` or `pi.sendMessage()` |
| Persist non-context session data | `pi.appendEntry()` |
| Record model-attributed external usage | `pi.recordUsage()` |
| Change active tools, model, or thinking level | Session control methods on `pi` |
| Add a model provider | `pi.registerProvider()` |
| Add terminal rendering | Renderer registration and `ctx.ui` |
| Communicate with another extension | `pi.events` |

Use the exported declarations in [`extensions/types.ts`](../src/core/extensions/types.ts) for exact event, context, tool, and result types.

## Follow the extension contracts

<a id="events"></a>
<a id="work-with-events"></a>

### Events and concurrency

Handlers run in extension load and registration order. `pi.on()` returns a function that unsubscribes that registration; changes do not affect a dispatch already in progress.
Some events notify; others transform data, replace results, or cancel an operation.
Use each event’s declared result type rather than assuming every return value has an effect.

Events cover resource discovery, sessions, agent and message lifecycle, providers, tools, and raw input.

`before_agent_start` exposes both the current prompt and its structured `systemPromptOptions`. Prefer changing prompt sections, selected tools, or guidelines so Pi can append a transcript delta. Returning `systemPrompt`, or setting `forceSystemPrompt`, replaces the whole prompt for that run while the transcript continues recording the structured sections. Providers receive the forced text as their leading system prompt. It survives tool-loop turns and fresh context windows within that run, ends at settlement, and is regenerated on the next run. Later section edits do not amend a forced complete prompt. This event also runs for idle custom-message wakeups, with `event.prompt === ""`.

`message_end` can replace a finalized message while preserving its role. `tool_call` can mutate input or block execution. `tool_result` handlers compose, with each handler seeing prior changes.

Shell guards must check both `bash` and `background_command` starts. Use `isToolCallEventType()` to match native, unnamespaced tools. A Bash override or `user_bash` handler does not intercept background jobs: detached workers cannot serialize a custom execution backend. The sandbox and SSH examples explicitly block unsupported starts while active, leaving status and cancellation available. Tool exclusions are literal: exclude both IDs to disable both shell paths.

<a id="context_with_system"></a>

`context` transforms conversation messages without prompt and tool system messages; Pi restores that state afterward. Use `context_with_system` only when a request-local transformation must own the complete transcript, and keep a system message at index zero.

`turn_end` and `agent_before_settle` are actionable boundaries. Their handlers can chain proposed `custom`, `custom_message`, `context_edit`, or `compaction` entries and return `continue: true` for one next model request. Guard continuation conditions because an unconditional continuation can loop. Use the exported event declarations for the complete validation and ordering contract.

<a id="cache_warming_decision"></a>

`cache_warming_decision` can override an idle prompt-cache refresh with `{ action: "warm" }` or `{ action: "stop" }`. The last handler that returns an action wins.

Tool calls from one assistant message can run in parallel.
Do not assume a sibling call or result exists when another tool event runs.
`ctx.signal` covers admitted prompt preparation through `agent_before_settle`, including retries and continuations. Capture it for nested work. It is absent while idle, in pre-admission `input`, and in notification-only `agent_settled`. Abort signals cooperative work immediately but still joins awaited handlers; it cannot forcibly stop a JavaScript promise.

A `user_bash` handler that returns `undefined` passes the command to the next handler and then to local execution if no handler handles it. Returning `operations` or `result` stops propagation. A handler failure blocks the command rather than falling through to local execution.

### Context boundaries and persistence

`session_before_auto_compact` runs before automatic threshold/overflow summary preparation and authentication. `event.pendingMessages` contains provider-bound inputs not yet in `branchEntries`; `reason`, `willRetry`, and `signal` describe the trigger. Return `{ newContext: { handoff } }` to start a native `context_window` instead of a summary. The last handler result wins; one extension should own this policy. Manual `/compact` does not fire this hook. See [Compaction](compaction.md).

`pi.registerContextWindowHook((event, ctx) => drafts)` synchronously shapes every fresh window after its marker and final retained tool receipts are selected. `event.contextEntries` contains the projected messages and their journal provenance; `event.pendingMessages` contains provider-bound inputs not yet journaled. Return only `ContextEditEntryDraft[]` or `undefined`. Each hook sees preceding hooks' edits. Use projected content for excerpts and `sourceEntry.id` as the edit target; original entries remain in history.

Pi validates each hook's entire draft batch before appending its edits, then refreshes canonical context before provider dispatch. Promises, invalid drafts, and thrown errors stop the operation; the window marker and earlier hooks' accepted edits may already be persisted. Hooks cannot request another window or continuation. This synchronous boundary also sees receipts completed during an awaited automatic-compaction handler.

`session_checkpoint` is the optional awaited persistence barrier for [working-session checkpoints](checkpoint.md). Use its signal and invalidation callback to keep owned background work quiescent while a receipt is held. It does not run shutdown just to save.

### Retry notifications

`auto_retry_start` fires before each native retry's backoff with 1-based `attempt`, `maxAttempts` excluding the initial request, `delayMs`, and `errorMessage`. `auto_retry_end` reports `success`, `attempt`, and optional `finalError`, including cancellation/exhaustion. Handlers are awaited before subscribers; start handlers and backoff finish before the retry request. `ctx.abort()` cancels pending retries. Returns do not alter retry policy.

Summary calls have separate awaited `summarization_retry_scheduled`, `summarization_retry_attempt_start`, and `summarization_retry_finished` events. Attempt-start follows backoff and identifies `source: "compaction" | "branchSummary"` plus compaction `reason`. Cancellation in either pre-request handler prevents the retry. Finished runs once after a call that scheduled retries, before that call returns; it alone does not report success. Split-turn summaries may make two calls with separate sequences. Extension-owned summaries do not emit these events automatically.

<a id="custom-tools"></a>
<a id="register-tools"></a>

### Tools

A custom tool defines a name, model-facing description, TypeBox parameter schema, and `execute()` function.
Its result requires model-facing `content` and a `details` field for rendering or state reconstruction.
Use `details: undefined` when there are no structured details. If the tool makes nested model calls, include their `usage` in the result so session totals remain accurate.

Throw from `execute()` to produce a failed tool result.
Returning an object does not mark it as an error.
Return `terminate: true` only when the agent should skip its automatic follow-up after every completed tool in that batch agrees to terminate.

Use sequential execution when tools share mutable in-memory state.
File-mutating tools should wrap the complete read-modify-write operation with `withFileMutationQueue()` and use `publishLocalFile()` for native local publication. Both are exported from the SDK; see [file and shell operations](sdk.md#file-and-shell-operations).
Truncate large model-facing results and tell the model where to read the complete output.

See [`hello.ts`](../examples/extensions/hello.ts), [`todo.ts`](../examples/extensions/todo.ts), [`dynamic-tools.ts`](../examples/extensions/dynamic-tools.ts), and [`truncated-tool.ts`](../examples/extensions/truncated-tool.ts).

### Activate tools dynamically

Register tools first, then select them using `pi.setActiveTools(ids)`. `getAllTools()` supplies each public `id`, leaf `name`, optional `namespace` and `toolSearch`, description, schema, guidelines, and source. Unnamespaced IDs equal their name; namespaced IDs are opaque. The setter replaces the whole selection, including clearing it with `[]`; unknown IDs are ignored and registration collisions reject.

For exact identities, use `getActiveToolReferences()` and `setActiveToolReferences([{ name, namespace? }])`. Bare names select only unnamespaced tools. Both selection paths obey allowlists and exclusions. Events preserve namespace and leaf name separately; built-in type guards match only unnamespaced tools.

### Tool discovery

`pi.registerToolSearch(definition)` uses ordinary tool validation, hooks, cancellation, and rendering. Its callback owns registration and search policy: activate matches before returning normal content/details plus `tools: ToolReference[]`. Pi resolves references against the active permitted registry and persists declaration snapshots. Unknown, inactive, or denied references fail without publishing declarations; returned objects cannot override schemas.

The sole active search callback becomes native client `tool_search` on capable Responses routes, with results under the original call ID. Multiple callbacks and unsupported routes remain ordinary named functions. Repeated matches are valid; native search results do not also produce duplicate tool-addition messages.

Pi records the initial prompt/tools and subsequent declaration changes in the transcript. Providers unable to represent a transition receive a complete checkpoint, which can invalidate the cached prefix. See [native asynchronous tools](sdk.md#native-asynchronous-tools-and-steering) for `async`, `resume`, detached results, and live steering.

<a id="extensioncontext"></a>
<a id="extensioncommandcontext"></a>
<a id="use-extension-context"></a>

### Context and session changes

`ExtensionContext` provides the working directory, mode, UI, session manager, model runtime, abort signal, context usage, and controls for compaction and shutdown.
Use `ctx.modelRegistry.streamSimple()` for provider-neutral nested model calls. `ctx.getCompactionSettings()` returns effective per-model settings; `ctx.getContextUsage()` reports measured or estimated context, including its `source`. See [SDK context usage](sdk.md#context-usage).

Read native activity without consuming it:

| Method | Meaning |
|---|---|
| `isIdle()` | False during admitted preparation, model runs, summaries, retries, continuations, or shutdown |
| `hasPendingMessages()` | Queued user/custom steering and follow-ups; excludes `nextTurn` asides |
| `hasPendingSteeringMessages()` | Steering only; not follow-ups or asides |
| `getPendingInputCount()` | Inputs still preparing or held by the mode, including remaining CLI startup prompts; excludes dispatched extension commands |
| `getPendingNextTurnCount()` | Unpersisted next-turn custom asides; retained across reload and `clearQueue()` |
| `isBashRunning()` | Unfinished user Bash, including async interception, execution, and recording |
| `getPendingToolCalls()` | Original native tool obligations, including detached external work |

User Bash and pending pre-admission input are separate from agent idle. `waitForIdle()` joins preparation and awaited settlement handlers; during shutdown it can resolve while `isIdle()` remains false.

Command handlers receive `ExtensionCommandContext`, which adds operations for waiting until idle, reloading, tree navigation, and session replacement.
These operations are command-only because calling them from lifecycle handlers can deadlock the runtime.

Session replacement invalidates the old context. Capture only plain data before switching, then use the fresh context supplied to `withSession` for session-bound work.

<a id="state-management"></a>
<a id="persist-state"></a>

### State

Choose storage based on how state participates in the conversation:

| State | Storage |
|---|---|
| Tool state that follows the active branch | Tool-result `details` |
| Durable data excluded from model context | `pi.appendEntry()` |
| Custom content stored and sent to the model | `pi.sendMessage()` |
| Data outside one session | External storage |

`pi.sendMessage(..., { persistOnCancel: true })` preserves undelivered streamed steering/follow-up customs once in history before settlement, without requesting another turn. `clearQueue()` also preserves opted-in messages, deferring append until a safe turn boundary while streaming. The default is false; `nextTurn` remains deferred. See [SDK prompting](sdk.md#prompting).

`pi.recordUsage({ id, kind, provider, model, usage, note? })` synchronously journals external usage without adding model context or triggering work. Use a stable namespaced contribution ID and do not also return that usage in a tool result. Identical repeats are no-ops across the journal; conflicts throw. Required strings must be nonempty and token/cost values finite and non-negative. An I/O error retains accepted usage; repeat the same contribution to retry persistence without recounting. See [UsageEntry](session-format.md#usageentry).

`ctx.sessionManager.getEntriesRevision()` supports caches over all entries; leaf-only navigation does not change that revision. Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`.
Do not rebuild it from every file entry because abandoned branches represent alternative histories.
Register an entry or message renderer when custom stored content should appear in the transcript.

<a id="custom-ui"></a>
<a id="mode-behavior"></a>
<a id="interact-with-the-user"></a>
<a id="account-for-each-mode"></a>

### UI and modes

`ctx.ui` provides dialogs, notifications, status text, widgets, titles, editor access, and custom components.
Use `ctx.ui.custom()` only when the interaction needs its own rendering and input.
See [Terminal UI](tui.md) for component, focus, overlay, theme, and performance guidance.

Extensions load in interactive, RPC, JSON, and print modes.
Interactive mode provides the complete terminal UI.
Pipe-based RPC forwards supported dialogs and notifications through the [RPC Extension UI protocol](rpc-extension-ui.md). PTY-backed RPC can [attach the TUI](rpc-commands.md#attach_tui) for a pending custom component. JSON and print modes have no UI.
Guard terminal-only behavior with `ctx.mode === "tui"` and use `ctx.hasUI` for interactions supported by interactive and RPC clients.

Keep tool and event behavior independent from rendering so non-interactive modes remain functional.

<a id="error-handling"></a>
<a id="handle-errors-and-shutdown"></a>

### Errors and cleanup

Pi reports handler errors and continues where possible. A `tool_call` handler failure blocks the tool as a fail-safe; a tool execution failure becomes an error result for the model.

Release resources in `session_shutdown` even when normal operation attempted cleanup.
Keep cleanup idempotent because cancellation, reload, session replacement, and process exit can converge on the same path.
Use `ctx.shutdown()` to request an orderly process shutdown.

<a id="examples-reference"></a>
<a id="use-examples-as-the-implementation-reference"></a>

## Examples and reference

The checked [extension examples](../examples/extensions/) cover tools, lifecycle events, commands, flags, shortcuts, state, rendering, providers, OAuth, remote execution, and terminal components.
Start with the smallest example matching your integration point.

Use [Custom Providers](custom-provider.md) for model-service integrations, [Terminal UI](tui.md) for custom components, and [Pi Packages](packages.md) to install or distribute extensions with other resources.
