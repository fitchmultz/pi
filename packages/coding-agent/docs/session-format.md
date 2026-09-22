# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

## File Location

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
```

By default, `<session-id>` is a UUID. Callers can supply a custom ID through the SDK or `--session-id`. For `<path>`, Pi removes the leading path separator and replaces `/`, `\\`, and `:` with `-`.

## Deleting Sessions

Sessions can be removed by deleting their `.jsonl` files under `~/.pi/agent/sessions/`.

Pi also supports deleting sessions interactively from `/resume` (select a session and press `Ctrl+D`, then confirm). When available, pi uses the `trash` CLI to avoid permanent deletion.

## Session Version

Sessions have a version field in the header:

- **Version 1**: Linear entry sequence (legacy, auto-migrated on load)
- **Version 2**: Tree structure with `id`/`parentId` linking
- **Version 3**: Renamed `hookMessage` role to `custom` (extensions unification)

Existing sessions are automatically migrated to the current version (v3) when loaded.

## Source Files

Source on GitHub ([pi](https://github.com/earendil-works/pi)):
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - Session entry types and SessionManager
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts) - Extended message types (BashExecutionMessage, CustomMessage, etc.)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) - Base message types (UserMessage, AssistantMessage, ToolResultMessage)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) - AgentMessage union type

For TypeScript definitions in your project, inspect `node_modules/@earendil-works/pi-coding-agent/dist/` and `node_modules/@earendil-works/pi-ai/dist/`.

## Message Types

Session entries contain `AgentMessage` objects. Understanding these types is essential for parsing sessions and writing extensions.

### Content Blocks

Messages contain arrays of typed content blocks:

```typescript
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

interface ToolCall {
  type: "toolCall";
  kind?: "toolSearch"; // native client search; omitted for ordinary functions
  id: string;
  name: string;
  arguments: JsonObject;
  thoughtSignature?: string;
  namespace?: string;
  async?: boolean;
  streaming?: boolean; // hosted call admitted while its response remains active
  responsesItem?: ResponseFunctionToolCall | ResponseCustomToolCall | ResponseToolSearchCall;
  executionStarted?: boolean;
  executionArguments?: JsonObject;
  executionDetached?: boolean;
}
```

### Base Message Types (from pi-ai)

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: Array<{ name: string; namespace?: string }>;
  replace?: boolean;  // discard earlier system messages; this one is the complete prompt and tool state
  timestamp: number;  // Unix ms
}

interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  responsesOutput?: (BetaResponseInputItem | BetaResponseOutputItem)[];
  responsesContent?: (TextContent | ThinkingContent | ToolCall)[];
  needsContinuation?: boolean;
  providerError?: {
    code?: string;
    type?: string;
    status?: number;
    requestId?: string;
    responseId?: string;
  };
  usage: Usage;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  deferred?: DeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  namespace?: string;
  toolCallKind?: "toolSearch";
  toolsAdded?: Tool[]; // core-resolved search declarations, including [] for empty native results
  content: (TextContent | ImageContent)[];
  details?: any;      // Tool-specific metadata
  usage?: Usage;      // Nested LLM work performed by the tool
  elapsedMs?: number; // Native executor time, excluding queueing and preflight
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

`"pending"` marks an in-progress response in streaming events and durable `checkpoint: true` assistant snapshots. A completed provider response is stored in an ordinary message entry with a terminal stop reason. `"deferred"` is a terminal reason for a provider response that will complete later; its `deferred` handle contains the provider data needed to retrieve that response.

### Provider Request Diagnostics

Codex, OpenAI Responses, and Azure Responses save a `provider_request` diagnostic on successful and failed assistant messages. Its `details` contain only allowlisted scalar values: transport, byte counts, socket/recovery facts, service tiers, and timings. These measurements are not model input and do not produce normal transcript notices.

- `timingOrigin: "adapter_start"` means timing starts inside the provider adapter, after earlier model/runtime preparation. Timings use a monotonic clock, not the diagnostic's wall-clock `timestamp`.
- `prepareMs`, `requestReadyMs`, `lastAttemptStartMs`, `headersMs`, `connectStartMs`, `websocketSendMs`, event timings, and `finishedMs` are offsets from that start. `onPayloadMs` and `connectMs` are durations; `socketAgeMs` and `lastApplicationEventAgeMs` are ages. `onPayloadMs` includes the adapter's payload hook, including chained `before_provider_request` handlers, not every extension hook.
- `headersMs` records when fetch or the SDK supplies an HTTP response, before `onResponse`. First-application-event and first-content-delta times record adapter-consumed events, including reasoning and tool-input deltas, not packet arrival or pure provider time to first token. `terminalEventMs` records a provider terminal event; `finishedMs` records the adapter's final success/error boundary, before later agent hooks or session persistence.
- Attempt counters cover only this adapter invocation. SSE counts fetch/SDK calls, not redirects or individual network operations. Recovery keeps the first event timings and the latest observed connect, close, send, and attempt fields; these fields can refer to different attempts. Separate agent retries create separate assistant messages. Missing fields mean that boundary was not observed.
- Codex `fullBodyBytes` counts the post-hook full JSON body. `websocketSendBytes` counts the UTF-8 string passed to `send`, after full/delta selection, including `response.create`; it is not WebSocket framing or proof of network delivery. `sseSendBytes` counts the fetch body after optional compression. The transport-failure diagnostic also uses `fullBodyBytes`, replacing the misleading `requestBytes` name.
- `requestedServiceTier` comes from the post-hook request. `returnedServiceTier` preserves a recognized raw terminal-response tier before pricing rules run. The recognized `fast` and `priority` values stay distinct. Missing, null, or unrecognized tiers are `unknown`; requested priority does not prove delivered priority. Pricing is unchanged.
- Close code/cleanliness and local timeout facts are independent of error classification. They include a synchronous close after a generic error, but do not wait for a late close or change retry, fallback, or timeout policy.

### Extended Message Types (from pi-coding-agent)

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: any;                 // Extension-specific metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;         // Previous leaf whose abandoned path was summarized
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

### AgentMessage Union

```typescript
type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

## Entry Base

All entries (except `SessionHeader`) extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // Usually an 8-char hex ID; may fall back to a full UUID
  parentId: string | null;  // Parent entry ID (null for a root entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Metadata only, not part of the tree (no `id`/`parentId`).

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`. System messages carry the prompt and tool loadout: the first request of a session persists one with every prompt section and tool declaration, and later changes persist as system messages that patch `sections` by name (`null` removes one) and list `toolsAdded`/`toolsRemoved`. Search tool results may also carry `toolsAdded`, resolved from the active permitted registry. Replaying system and tool-result declarations in order yields the current tool set; there is no separate tool catalog in session state. Identity is the exact `(namespace, name)` pair. Native search calls/results retain their original call ID and kind, and repeated identical search declarations do not invalidate additive replay.

A native async call can produce assistant entries with `checkpoint: true` before its side effect starts and when execution detaches or resumes. These are non-billable snapshots of the same `responseId`, not additional provider responses. Keep their usage intact for context projection, but exclude them from billing, response counts, and cache-request statistics. Context rebuilding combines snapshots with the final response's content and usage.

`responsesItem` retains the original completed provider item and wire identity. `executionStarted` records admission; `executionArguments` contains validated, preflight-adjusted arguments without changing that provider item. `executionDetached` means local execution stopped while an external owner retained the unfinished operation. A missing result does not prove that the side effect did not happen; recovery uses the tool's `resume` callback and never repeats an already-started `execute` call.

Responses assistants also retain ordered native items and acknowledged injected inputs in `responsesOutput`; `content` is the visible and executable projection. `responsesContent` records the original projection so a later content edit cannot replay that message's stale native items. `needsContinuation` records a successful hosted response that still needs another request. A failed response's `providerError` preserves its code and available request/response identifiers independently of the displayed error text.

A `before_agent_start` handler that forces the whole prompt changes only provider requests for the active run. The transcript and compaction/context-window checkpoints keep the structured sections and tool declarations; the next run regenerates extension guidance. Older sessions can contain full-prompt records with `replace: true`. Replay clears earlier content, sections, and tools before applying such a record. Resuming restores that saved state; the next run writes a structured replacement baseline so the old opaque prompt does not accumulate alongside new sections.

```json
{"type":"message","id":"a0b1c2d3","parentId":null,"timestamp":"2024-12-03T14:00:00.000Z","message":{"role":"system","content":"","sections":{"preamble":"You are an expert coding assistant...","tools":"<tools>\n- read: ...\n</tools>","cwd":"/project"},"toolsAdded":[{"name":"read","description":"...","parameters":{}}],"timestamp":1733234400000}}
{"type":"message","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:04:00.000Z","message":{"role":"system","content":"","sections":{"skills":"<skills>...</skills>"},"toolsRemoved":[{"name":"write"}],"timestamp":1733234640000}}
```

Sessions created before system messages existed have no leading system message; the first request declares the current prompt as a later system message, which replays the same way.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello","timestamp":1733234401000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop","timestamp":1733234402000}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1733234403000}}
```

### ModelChangeEntry

Emitted when the user switches models mid-session.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### ContextWindowEntry

A `context_window` entry starts a fresh model context without deleting session history. It stores optional `handoff` text, `tokensBefore` (or `null` when unknown), and an optional `systemMessage` checkpoint containing the current prompt and tool declarations. Context rebuilding replays that checkpoint before the visible window marker, so resuming a fresh window preserves its tool selection without restoring earlier conversation.

### UsageEntry

Records model-attributed usage that is not an assistant message and does not participate in LLM context. `kind` is an arbitrary string identifying the operation; for example, cache warming uses `"cache_warm"`.

```json
{"type":"usage","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:08:00.000Z","kind":"cache_warm","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":0,"output":0,"cacheRead":50000,"cacheWrite":0,"totalTokens":50000,"cost":{"input":0,"output":0,"cacheRead":0.015,"cacheWrite":0,"total":0.015}}}
```

Usage entries contribute to session token and cost totals. Appending the first usage entry saves the journal even before any assistant response, including earlier deferred entries. Copied branches containing usage are also saved immediately. Pi hides usage entries from the conversation tree. Consumers should treat unknown `kind` values as normal usage rather than rejecting them.

An optional `contributionId` is an idempotency key, separate from the native entry `id`. `pi.recordUsage({ id, kind, provider, model, usage, note? })` records that ID and usage together in one entry. An identical repeat anywhere in the same journal is a no-op; a conflicting payload throws. Resume and forks retain IDs on copied entries. No separate accounting ledger is stored.

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages and a complete system prompt/tool checkpoint.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000,"systemMessage":{"role":"system","content":"You are a coding assistant.","toolsAdded":[],"timestamp":1733235000000}}
```

`firstKeptEntryId` is required. It identifies the first entry retained from before the compaction entry. When rebuilding context, Pi replaces older summarized entries with the compaction summary and keeps the range beginning at this entry. A retain-none compaction stores its own ID in this field, so no preceding entries are retained.

Optional fields:
- `systemMessage`: The replayed prompt sections and tool declarations at the compaction boundary; it becomes the leading system message of the compacted context, and system messages among the kept entries are dropped in its favor. It is absent on older session entries.
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `details`: Implementation-specific data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions)
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### ContextEditEntry

Append-only edit of one earlier context-producing entry. It changes only future model context; the target entry and its metadata remain unchanged in raw history, UI, exports, and session accounting.

```json
{"type":"context_edit","id":"g6h7i8j9","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:11:00.000Z","targetId":"c3d4e5f6","replacement":null}
```

Targets may be user, assistant, tool-result, or custom-message entries. `replacement: null` omits the target from model context. A non-null `replacement` replaces only the target message content. String replacements for assistant and tool-result entries are normalized to one text block because those roles require content arrays. If several edits target the same entry, the latest edit on the active branch wins. Edits are branch-relative: navigating to a point before the edit reveals the target's original contribution again.

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

`parentId` is the entry from which the new branch continues. `fromId` is the previous leaf whose abandoned path was summarized.

Optional fields:
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload. Interactive mode can render custom entries via `pi.registerEntryRenderer(customType, renderer)`, but they still do not participate in LLM context.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name`, `--name` / `-n`, or `pi.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

## Tree Structure

Entries normally form one tree, but navigation APIs can create multiple roots:
- A root entry has `parentId: null`; the first entry is initially the root
- Each non-root entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree
- Calling `resetLeaf()` or `branchWithSummary(null, ...)` allows a later entry to become another root

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

`buildContextEntries()` walks from the current leaf to the root, producing the active entry list while honoring compaction:

1. Collects entries on the path, starting at the latest `ContextWindowEntry` when present
2. Coalesces assistant execution snapshots by response identity, preserving final content and usage with the latest admitted-call state
3. If one or more `CompactionEntry` values remain, uses the latest one:
   - Includes the compaction entry first
   - Includes non-system entries from `firstKeptEntryId` up to, but not including, the compaction entry
   - Includes entries after the compaction entry
4. Preserves non-message entries in the selected range so interactive mode can render them

`buildSessionProjection()` then applies the latest `context_edit` for each selected target. It returns the model-visible messages together with their source entries. Omitted targets produce no message; replacements retain the source entry's role and metadata while changing only content. When a Responses assistant's content changes, provider conversion uses the replacement instead of that message's saved native output. The raw selected entries are not modified.

`buildSessionContext()` builds on that projection to produce the message list for the LLM:

1. Extracts current model and thinking level settings from the full path
2. Converts selected entries to messages:
   - `message` -> stored `AgentMessage`
   - `context_window` -> system checkpoint followed by the window marker and handoff
   - `compaction` -> complete system checkpoint followed by `compactionSummary`
   - `branch_summary` -> `branchSummary`
   - `custom_message` -> `CustomMessage`
   - `context_edit` -> no context message of its own
   - `usage` and `custom` -> no context message

The compaction summary replaces entries before `firstKeptEntryId`. Pre-compaction system messages are folded into the complete checkpoint rather than replayed from the retained range. Retained non-system entries and all entries after the compaction remain available to the LLM.

## Parsing Example

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "usage":
      console.log(`[${entry.id}] Usage (${entry.kind}): ${entry.usage.totalTokens} tokens`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```

## SessionManager API

Key methods for working with sessions programmatically.

### Static Creation Methods
- `SessionManager.create(cwd, sessionDir?, options?)` - New session; `options` can set `id` and `parentSession`
- `SessionManager.open(path, sessionDir?, cwdOverride?)` - Open existing session file
- `SessionManager.continueRecent(cwd, sessionDir?)` - Continue most recent or create new
- `SessionManager.inMemory(cwd?, options?, entries?)` - No file persistence, optionally initialized from entries
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)` - Fork session from another project

### Static Listing Methods
- `SessionManager.list(cwd, sessionDir?, onProgress?, signal?)` - List sessions for a directory
- `SessionManager.listAll(onProgress?, signal?)` - List all sessions across all projects
- `SessionManager.listAll(sessionDir?, onProgress?, signal?)` - List sessions from a custom session root

### Instance Methods - Session Management
- `newSession(options?)` - Start a new session (options: `{ id?: string, parentSession?: string }`)
- `setSessionFile(path)` - Switch to a different session file
- `createBranchedSession(leafId)` - Extract branch to new session file

### Persistence Failures

Appends accept the entry into memory before synchronous journal I/O. If I/O throws, the entry, ID, parent, leaf, revision and label indexes remain accepted; do not repeat the append to retry saving it. `flush()` retries failed persistence using the complete native entry list, including repair of partial writes. Later appends also reconcile a prior failure before returning successfully. Errors continue to propagate until persistence succeeds.

Full rewrites stage the complete journal in an exclusively created sibling temporary file and replace the journal only after all writes and close succeed. For an existing journal opened through a symlink, staging and replacement use the resolved target, leaving the alias intact and preserving write-through behavior. Failed repair writes leave the prior journal bytes intact and remove the temporary file. Repair requires a writable target journal and its directory, and preserves the journal's permission mode; initial creation retains exclusive collision protection.

`flush()` does not change entries, revisions or the selected leaf, and emits no events. It is a no-op for in-memory sessions and deferred journals containing neither an assistant response nor a usage entry. Replacing a manager's session via `newSession`, `setSessionFile` or `createBranchedSession` first retries failed persistence so replacement cannot forget unsaved entries. This is not a filesystem freeze or a crash-durability guarantee; retain the live process after a failed save.

### Instance Methods - Appending (all return entry ID)
- `appendMessage(message, checkpoint?)` - Add a message; `checkpoint: true` records a non-billable assistant execution snapshot
- `appendThinkingLevelChange(level)` - Record thinking change
- `appendModelChange(provider, modelId)` - Record model change
- `appendContextWindow(handoff, tokensBefore)` - Start a fresh context with the current prompt and tool checkpoint
- `appendUsage(kind, provider, model, usage, note?, contributionId?)` - Record model-attributed usage outside the conversation; returns the appended or matching existing `UsageEntry`. Omitting `contributionId` keeps ordinary append semantics.
- `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?, usage?)` - Add compaction
- `appendCustomEntry(customType, data?)` - Extension state (not in context)
- `appendSessionInfo(name)` - Set session display name
- `appendCustomMessageEntry(customType, content, display, details?)` - Extension message (in context)
- `appendLabelChange(targetId, label)` - Set/clear label

### Instance Methods - Tree Navigation
- `getLeafId()` - Current position
- `getLeafEntry()` - Get current leaf entry
- `getEntry(id)` - Get entry by ID
- `getBranch(fromId?)` - Walk from entry to root
- `getTree()` - Get full tree structure
- `getChildren(parentId)` - Get direct children
- `getLabel(id)` - Get label for entry
- `branch(entryId)` - Move leaf to earlier entry
- `resetLeaf()` - Reset leaf to null (before any entries)
- `branchWithSummary(entryId, summary, details?, fromHook?, usage?)` - Branch with context summary; `entryId` may be `null` to branch from the root

### Instance Methods - Context & Info
- `buildContextEntries()` - Get active branch entries with compaction applied
- `buildSessionContext()` - Get messages, thinkingLevel, and model for LLM
- `getEntries()` - All entries (excluding header)
- `getEntriesRevision()` - Revision of this manager's file-wide entries; changes on append or replacement, not on leaf-only navigation. Available through the read-only extension context for caching derived entry data.
- `getHeader()` - Session header metadata
- `getSessionName()` - Get display name from latest session_info entry
- `getCwd()` - Working directory
- `getSessionDir()` - Session storage directory
- `getSessionId()` - Session UUID
- `getSessionFile()` - Session file path (undefined for in-memory)
- `isPersisted()` - Whether session is saved to disk
