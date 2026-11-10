# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

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

Existing sessions are automatically migrated to the current version (v3) when loaded.

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

A message in the conversation. The `message` field contains an `AgentMessage`. System messages carry the prompt and tool loadout: the first request of a session persists one with every prompt section and tool declaration, and later changes persist as system messages that patch `sections` by name (`null` removes one) and list `toolsAdded`/`toolsRemoved`. Replaying them in order yields the current prompt and tools; there is no separate prompt state entry.

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

Usage entries contribute to session token and cost totals. Pi hides them from the conversation tree. Consumers should treat unknown `kind` values as normal usage rather than rejecting them.

Cache-warm entries also preserve the warm request's optional `cacheIdentity`, `thinkingLevel`, and `providerThinkingLevel` metadata. Cache diagnostics compare the next response with that request, not an earlier assistant's account or effort. Older entries without this metadata remain unknown.

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
- `providerSummary`: Written by Pi when an extension asked for a [provider summary block](compaction.md#provider-summary-block): `provider`, `api` and `model` of the request, `seconds`, `usage`, and either `block` (the signed block as the API returned it) or `reason` (why there is none). With a `block`, `systemMessage` is the leading system message of the context before the compaction, unchanged; `toolsAdded` and `toolsRemoved` hold the tool changes of the summarized messages, which Pi declares in a system message directly after the leading one; system messages among the kept entries stay in the context; and the summary follows the kept entries instead of preceding them

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

Pi stores [virtual model](virtual-models.md) router state as custom entries with `customType` `pi.virtual-model-state` and `data` `{ provider, modelId, state }`.

Custom types that start with `pi.` belong to Pi.

#### Runtime record (`pi.runtime`)

Pi appends one custom entry with `customType` `pi.runtime` each time it starts a saved session, immediately before the `session_start` event. It says which build of Pi, which packages, which extensions and which context files that start ran with. Like every custom entry, it is not part of LLM context and has no effect on the conversation.

```json
{"type":"custom","id":"16cb296d","parentId":"4606f246","timestamp":"2026-11-10T15:53:47.218Z","customType":"pi.runtime","data":{"version":1,"trigger":"startup","process":{"pid":62571,"mode":"tui","launcherPid":62560},"build":{"package":{"name":"@earendil-works/pi-coding-agent","version":"1.5.2","path":"/opt/pi/node_modules/@earendil-works/pi-coding-agent"},"runtime":{"node":"24.22.2","platform":"darwin","arch":"arm64"},"fork":null},"packages":[{"source":"git:github.com/user/repo","scope":"user","path":"/home/user/.pi/agent/git/github.com/user/repo","version":"1.2.3","commit":"b3e1f25d1fc94ac8e39e79de454fe98c5cab72b0"}],"extensions":[{"path":"/home/user/.pi/agent/extensions/notes.ts","source":"auto","scope":"user","sha256":"9f86d081..."},{"path":"builtin:mcp","source":"builtin","scope":"temporary"}],"contextFiles":[{"path":"/home/user/.pi/agent/AGENTS.md","bytes":14963,"sha256":"42f92518..."}]}}
```

When it is written:

- Every start writes a complete record, also when nothing changed since the previous one. `trigger` is the `session_start` reason: `startup`, `new`, `resume`, `fork` or `reload`.
- Sessions without a file (`--no-session`, `SessionManager.inMemory()`) get no record.
- A new session keeps its record in memory until its first message creates the file, so a session that ends unused leaves no file. A resumed or reloaded session gets its record written at once.
- A fork or clone copies the records of the path it copies, then gets its own with `trigger` `fork`.
- A session restored from a [working session](working-session.md), which every [managed restart](restart.md) is, keeps its startup record in memory until its first agent run. A journal newer than the saved state is refused, so the record must not be what makes it newer if the start is rolled back or tried again. The record then precedes that run's messages and carries that run's time. A restored session that never runs the agent gets no record.

A record does not count as activity: the session selector's order, message count, preview and name ignore it. It does change the file's modification time, which `pi -c` uses to find the most recent session.

`data` fields:

| Field | Content |
| --- | --- |
| `version` | Format version of the record. Currently `1` |
| `trigger` | Reason of the `session_start` event that follows |
| `process.pid` | Process ID of the Pi process |
| `process.mode` | Run mode, as extensions see it in `ctx.mode`: `tui`, `print`, `json` or `rpc` |
| `process.launcherPid` | Process ID of the [managed launcher](restart.md) that owns this process. Absent without one. `pi restart` and `/restart` replace the process and keep the launcher, so a record with the same `launcherPid` as the one before it and another `pid` marks a restart |
| `build` | What `pi --build-info` prints: `package` (`name`, `version`, `path`), `runtime` (`node`, `platform`, `arch`) and `fork`, the fork installer's receipt with the built `commit`, or `null` for other installs |
| `packages` | Every package that supplied a loaded extension, skill, prompt template or theme: `source` as configured, `scope` (`user`, `project` or `temporary`), `path` of the installed package, `version` from its `package.json` if it has one, and `commit` if `path` is the root of a git checkout. A configured package with all of its resources disabled is not listed |
| `extensions` | Every loaded extension that no package supplied: `path` of the entry file, `source` (`auto` for extension directories, `local` for settings entries, `cli` for `-e`, `builtin`, `inline`), `scope`, and `sha256` of the entry file. Built-in and inline extensions have a name instead of a file and no hash. Packages given with `-e` appear here |
| `contextFiles` | Every [context file](configuration.md#context-files) loaded for the system prompt: `path`, `bytes` (UTF-8 length) and `sha256` of the loaded text |

Package versions, commits and file hashes are read from disk when the record is written. `/new`, `/resume` and `/fork` in the same directory keep extension code that the process already imported, so a package updated on disk since the process started is recorded with its new version while its old code still runs until `/reload` or a restart. The record holds no settings values, environment variables, credentials or prompt text.

The package exports the custom type as `RUNTIME_RECORD_ENTRY` and the `data` type as `RuntimeRecordData`.

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

1. Collects all entries on the path
2. If one or more `CompactionEntry` values are on the path, uses the latest one:
   - Includes the compaction entry first
   - Includes non-system entries from `firstKeptEntryId` up to, but not including, the compaction entry
   - Includes entries after the compaction entry
3. Preserves non-message entries in the selected range so interactive mode can render them

`buildSessionProjection()` then applies the latest `context_edit` for each selected target. It returns the model-visible messages together with their source entries. Omitted targets produce no message; replacements retain the source entry's role and metadata while changing only content. The raw selected entries are not modified.

`buildSessionContext()` builds on that projection to produce the message list for the LLM:

1. Extracts current model and thinking level settings from the full path
2. Converts selected entries to messages:
   - `message` -> stored `AgentMessage`
   - `compaction` -> complete system checkpoint followed by `compactionSummary`. With a provider summary block: the unchanged leading system message, which carries the block as `providerSummary`, then a system message with the tool changes of the summarized messages, if any; `compactionSummary` follows the kept entries
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
