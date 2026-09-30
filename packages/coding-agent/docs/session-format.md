# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each nonempty line is a JSON object with a `type` field; readers should ignore blank separator lines. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

For programmatic creation, persistence, and tree navigation, see the [`SessionManager` API](sdk.md#sessionmanager-api).


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

Ordinary v1/v2 sessions migrate to v3 when loaded. Legacy fork journals containing retired runtime fields require a separate, one-time copy conversion; they are not silently resumed.

## Source Files

Source on GitHub ([pi](https://github.com/earendil-works/pi)):
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - Session entry types and SessionManager
- [Message Types](message-types.md) - Shared message and content-block reference
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts) - Extended message types
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) - Base message and content-block types
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) - Extensible `AgentMessage` union

For TypeScript definitions in your project, inspect `node_modules/@earendil-works/pi-coding-agent/dist/` and `node_modules/@earendil-works/pi-ai/dist/`.

## Messages

A `message` entry stores an [`AgentMessage`](message-types.md). Message content blocks, roles, usage, and message timestamps are defined in [Message Types](message-types.md).

Session entry timestamps are ISO 8601 strings. The nested message timestamp is a Unix timestamp in milliseconds.

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

A message in the conversation. The `message` field contains an [`AgentMessage`](message-types.md). System messages carry named prompt sections and public-name tool declarations. Replay additions/removals in order; `toolsRemoved` contains `{ name }` references, not strings or namespace pairs. A legacy journal with retired native execution fields requires [copy conversion](#convert-a-legacy-fork-session).

```json
{"type":"message","id":"a0b1c2d3","parentId":null,"timestamp":"2024-12-03T14:00:00.000Z","message":{"role":"system","content":"","sections":{"preamble":"You are a coding assistant."},"toolsAdded":[{"name":"read","description":"Read a file","parameters":{}}],"timestamp":1733234400000}}
```

Sessions created before system messages existed have no leading system message; the first request declares the current prompt as a later system message.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello","timestamp":1733234401000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop","timestamp":1733234402000}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1733234403000}}
```

Assistant messages name the model that produced them. Newer messages also record `thinkingLevel`, the Pi thinking level requested for that response.

### ModelChangeEntry

Emitted when the user switches models mid-session. The latest entry is the selected model, which may be a [virtual model](virtual-models.md); assistant messages then name the physical model that answered.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### UsageEntry

Records model-attributed usage that is not an assistant message and does not participate in LLM context. `kind` is an arbitrary string identifying the operation; for example, cache warming uses `"cache_warm"`.

```json
{"type":"usage","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:08:00.000Z","kind":"cache_warm","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":0,"output":0,"cacheRead":50000,"cacheWrite":0,"totalTokens":50000,"cost":{"input":0,"output":0,"cacheRead":0.015,"cacheWrite":0,"total":0.015}}}
```

Usage entries contribute to session token/cost totals. The first usage entry saves a file-backed journal, including earlier deferred entries, even before the first assistant response. Copied branches containing usage are saved immediately. Pi hides usage entries from the conversation tree; accept unknown `kind` values.

Optional `contributionId` is an idempotency key separate from the entry ID. `pi.recordUsage({ id, kind, provider, model, usage, note? })` persists it with the contribution. Identical repeats anywhere in the journal are no-ops; conflicts throw. Resume/forks retain IDs on copied entries; omitted entries do not reserve their IDs in a fork. Unrelated journals have independent IDs. There is no second accounting store.

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages and, when available, a complete system prompt/tool checkpoint.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000,"systemMessage":{"role":"system","content":"You are a coding assistant.","toolsAdded":[],"timestamp":1733235000000}}
```

`firstKeptEntryId` is required. It identifies the first entry retained from before the compaction entry. When rebuilding context, Pi replaces older entries with the compaction summary and keeps the range beginning at this entry. A summary-free extension handoff can use public compaction hooks without a separate context-window entry.

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

Targets may be user, assistant, tool-result, or custom-message entries. `replacement: null` omits the target from model context. A non-null `replacement` has `{ content }` and replaces only the target message content. String replacements for assistant and tool-result entries are normalized to one text block because those roles require content arrays. If several edits target the same entry, the latest edit on the active branch wins. Edits are branch-relative: navigating to a point before the edit reveals the target's original contribution again.

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

Use `customType` to identify your extension's entries on reload. The first custom entry saves a file-backed session even before an assistant response, including earlier deferred entries; copied branches containing custom entries are saved immediately. Interactive mode can render custom entries via `pi.registerEntryRenderer(customType, renderer)`, but they still do not participate in LLM context.

Pi stores [virtual model](virtual-models.md) router state as custom entries with `customType` `pi.virtual-model-state` and `data` `{ provider, modelId, state }`.

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

`buildContextEntries()` walks the active tree branch, applies the latest compaction boundary, and keeps entries from `firstKeptEntryId` onward plus later entries. `buildSessionContext()` converts retained message, compaction, branch-summary, and custom-message entries into model context. Usage and custom state entries do not enter model context. `context_edit` changes a target's future context contribution without rewriting its raw journal entry. The compaction's `systemMessage`, when present, supplies the complete prompt/tool checkpoint rather than replaying pre-compaction system messages.

## Persistence failures

Appends accept entries in memory before journal I/O. An I/O error retains the entry, ID, parent, leaf, revision, and indexes; do not append again to retry saving. `flush()` and later appends retry missing entries without replacing the journal, preserving entries saved by other writers. An incomplete final line is terminated and skipped during parsing; entries already saved are not duplicated. Errors propagate until saving succeeds.

Full rewrites stage a complete sibling temporary file and rename only after writes/close succeed. Journals opened through symlinks replace the resolved target while preserving the alias and permission mode. Failed staging preserves old bytes and removes temporary output. Full rewrites need a writable journal and parent; new journals retain exclusive collision protection.

`flush()` changes no entries/revisions/leaf and emits no events. It is a no-op for in-memory sessions and deferred journals with no assistant response, usage, or custom entry. Session replacement flushes failed persistence first. Retain the process after failed saving; this is not a filesystem freeze or power-loss guarantee.

`getEntriesRevision()` changes on append or session replacement, not leaf-only navigation; use it for file-wide derived-data caches. Session listing methods accept optional abort signals. See the exported [`SessionManager`](../src/core/session-manager.ts) declarations for signatures.

## Convert a legacy fork session

Use `pi convert-session SOURCE.jsonl NEW_PATH.jsonl` for a settled v3 legacy fork journal. It writes a distinct new file and preserves the original; it does not load extensions or contact providers or execute tools. Resume with `pi --session NEW_PATH.jsonl`, which starts a fresh provider request rather than resuming an in-flight response. Existing output is never overwritten. Stop the original writer first; conversion refuses changed source bytes.

Native response snapshots are coalesced only when a unique final response exists on every affected branch. On linear histories, explicitly concurrent receipts move after the related coalesced responses in their original receipt order; the first snapshot's ordering metadata controls the response. Causal reordering across a compaction, context window, or context edit, and causal reordering on branched histories, are refused. Histories without concurrent receipt metadata still support branches. Legacy context windows become compaction boundaries where safe, carrying retained calls and receipts without billing them again.

Tool declarations recorded on results become empty system messages immediately after those results, with every child branch continuing after the declaration. Colliding namespace/name identities receive deterministic, distinct public names used consistently by declarations, calls, results, and removals. The reversible name mapping, original declarations, response snapshots, and ordering metadata are archived in custom `legacy-conversion-*` entries, outside model input and billing.

Historical steering statuses are preserved, never changed to `applied` or delivered again. Queued records without a steering ID and accepted/unknown outcomes require the exact user message to be journaled once on the same branch, after the event, followed by a completed different response. Applied steering requires its durable input; failed steering remains an archived failure.

Conversion refuses unfinished or deferred responses, missing/mismatched tool results, unjournaled or unresolved steering, unsupported boundary/edit reconstruction, malformed references and unsupported entry types. Do not replay refused work. This copy conversion is separate from live [working-session checkpoints](checkpoint.md), which preserve exact accepted queues and selection.

## Parsing Example

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  if (!line.trim()) continue;
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
