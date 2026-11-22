# Upstream integration: 2026-11-21

## Baseline

This integration merges upstream `main` `9c4652688590abb836b40ebd1e4725ecf9a7c7d1` into fork
`080677ec837c06a77521fb048f93794b1f25c60a`, preserving both histories. The preceding upstream
baseline was `25190b72c195ce6502103ecba55064eade1f188b` (33 incoming commits).

Official release remains `v1.6.0` (`faac585884ae2c013a6b1400f3e9e77f10b34bac`); upstream `main` is
now 44 commits after it.

## Incoming changes

- **AI**: Google `compat.supportsStrictMode` and prefixed Gemini 3+ model ID detection (`#12371`),
  Bedrock SSO credential resolution through `HTTPS_PROXY` (`#12365`), OpenAI Decisions
  (`gpt-6-luna`) cache read/write token reporting and catalog pricing (`#12358`, `#12264`),
  `createProvider` publish-time model catalog merging (`#12366`), and additional retryable
  temporary provider failure patterns (`a00a5048d`).
- **Coding agent**: bash tail truncation for an over-long line followed by blank lines (`#12355`),
  iterative context-entry loading for very long post-compaction branches (`#12360`), Windows
  console-close / `SIGHUP` shutdown cleanup (`#11889`), and `models-configuration.md` docs for
  Google `compat.supportsStrictMode` (`#12371`).
- **MCP**: `createMcpResultSchema()` and `toMcpModelContent()` moved from coding-agent into
  `@earendil-works/pi-mcp` (`1acc72acd`).
- **TUI**: `Editor.addToHistory()` deduplication moving repeated prompts to the front (`#12370`).
- **Chord & Durable**: tagged unions (`kind`) replacing `in`-based union narrowing across
  `RolloutHost`, `PluginSource`, `SeriesResult`, `CommitResult`, tool parks, `Wrap`, `onYield`,
  `beforeCompact`, and `SignalState`; `Conversation.submit(tx, draft)` /
  `ConversationHandle.submit(tx, draft)` renamed to `admit(tx, draft)` (`befc2d59b`, `32c71a6d4`);
  sync protocol version header on Radius requests (`122db8483`).
- **p2 & p3**: named-brain Radius status formatting (`1ca254257`), full `CallToolResult` /
  model-facing MCP content in p2 (`51532e40c`, `1acc72acd`), subagent model listing and sheet UI
  (`780bf31fc`, `9c4652688`), multi-line syntax highlighting (`9d63bb727`), tagged unions
  (`5a7479a88`), and `p3` skeleton base / topology tier (`c9de86c4a`, `753bc0bb2`).
- **Docs**: `AGENTS.md` tagged-union rule (`cd352248c`) and consolidated reviewer-reporting rule
  (`725e0a21d`).

## Conflict decisions and retired fork deltas

Seventeen paths conflicted, plus five auto-merged fork sites updated for upstream API/type changes.

| Paths | Resolution |
| --- | --- |
| `apps/p2/plugins/radius/server.ts` | Adopted upstream `connected as brain "${status.name}" (${status.serverId})` (`1ca254257`) and retired the fork's `JSON.stringify` retained-delta entry from `FORK.md`. |
| `packages/ai/src/models.ts` | Adopted upstream `#12366` publish-time `indexByKey` / `keyOf` merge in `createProvider`, retiring the fork's per-read `Map` optimization. |
| `packages/ai/src/api/classifier-shared.ts` | Combined fork's `total_input_tokens` / `total_output_tokens` fallback (for Google Decisions) with upstream `#12358` `input_tokens_details.cached_tokens` and `cache_write_tokens` splitting (for OpenAI Decisions). |
| `packages/ai/src/api/{google-generative-ai,google-vertex,google-shared}.ts` | Dropped upstream's duplicate `buildParams()` blocks from `google-generative-ai.ts` and `google-vertex.ts` (fork shares `buildParams()` in `google-shared.ts`) and updated `google-shared.ts` to call `supportsGoogleStrictToolSampling(model)` so `compat.supportsStrictMode` applies to both Google adapters. |
| `packages/ai/package.json`, `package-lock.json`, `packages/coding-agent/install-lock/package-lock.json` | Kept fork's newer reviewed pins (`@anthropic-ai/sdk` `1.10.0`, `@aws-sdk/client-bedrock-runtime` `3.1172.0`) and added `"@aws-sdk/credential-provider-node": "3.972.97"` matching the version already resolved by `@aws-sdk/client-bedrock-runtime@3.1172.0`. Regenerated both lockfiles. |
| `packages/coding-agent/src/extensions/mcp/tools.ts` | Kept fork's `appendToolOutputPreview` import and dropped unused `formatSize`, `replaceTabs`, `keyHint`, and `VisualLinePreview` imports after upstream moved `toMcpModelContent` / `createMcpResultSchema` into `@earendil-works/pi-mcp`. |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Kept both upstream's `killTrackedDetachedChildren()` shutdown call (`#11889`) and fork's `process.exit(restartFailure ? 1 : 0)`. |
| `packages/coding-agent/test/rpc-prompt-response-semantics.test.ts` | Kept both fork's `restart-protocol.js` mock and upstream's `shell.js` mock (`#11889`). |
| `packages/durable/test/{harness-submissions,indexeddb-storage,store-storage}.test.ts`, `scripts/performance/fixtures/{durable-history,durable-storage}.ts` | Updated fork-only tests and performance fixtures for upstream `32c71a6d4`: `root.submit(tx, ...)` -> `root.admit(tx, ...)` and `{ stored: 1 }` -> `{ kind: "stored", stored: 1 }`. |
| `packages/{ai,chord,coding-agent,durable,mcp,tui}/CHANGELOG.md` | Merged fork and post-`v1.6.0` upstream entries under `## [Unreleased]` with single subsection headers while keeping `## [1.6.0]` and below byte-identical to tag `v1.6.0`. |

## Verification

All runs used macOS on Node 24.22.3 with offline/faux providers:

- `npm ci --ignore-scripts`, `npm run hydrate:model-data` (1698 tool-capable models), and `npm run build:offline` passed.
- `node scripts/check-released-changelogs.mjs` passed (`Released changelog sections match v1.6.0.`).
- `npm run check` passed (Biome across 2759 files, pinned deps, runtime deps, ts-imports, entry graphs, coding-agent install lock, root and examples `tsc --noEmit`, browser smoke).
- `cd apps/p2 && npm run check` passed (Biome across 986 files + `tsc --noEmit`).
- `./test.sh` targeted suites passed:
  - `packages/ai` (15 files covering classifiers, Google Decisions, Google shared/stream/strict mode, `models-runtime`, retry, Bedrock proxy/convert/strict-tool, model-data validation, Cloudflare OpenAI positional parity): 314 passed, 0 failed.
  - `packages/mcp` (full package suite, 16 files): 153 passed, 0 failed.
  - `packages/coding-agent` (7 files covering MCP extension, tools/bash truncation, print mode, RPC prompt semantics, session-manager context loading, shell process-tree cleanup, classifier overrides): 222 passed, 0 failed.
  - `packages/tui` (full package suite via `npm --prefix packages/tui test`): passed, 0 failed.
  - `packages/chord` (`node/workers/workers.test.ts`, `store/store.test.ts`): 100 passed, 0 failed.
  - `packages/durable` (9 files covering harness submissions/compaction, SQLite commit/storage, IndexedDB, StoreStorage, JSONL, cached storage): 592 passed, 0 failed.
  - `apps/p2` (`radius.test.ts`, `mcp-tools.test.ts`, `subagent-models.test.ts`, `highlight-lines.test.ts`, `terminal-agent-host.test.ts`): 42 passed, 1 skipped (daemon-gated), 0 failed.
  - `npm run test:scripts`: 286 passed, 1 skipped, 0 failed.
