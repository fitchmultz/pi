# Upstream integration: 2026-11-25

## Baseline

This integration merges upstream `main` `e4cd354e6f3ce317a9dd4a8ab1dd4fb6500ebc98` into fork
`99ea07b2119d048b78dfda03540b6ea5c15f8f45`, preserving both histories. The preceding upstream
baseline was `433c1fd94c6aa3cf3fa408aad0d765f6763bd362` (23 incoming commits, 23 non-merge).

Official release `v1.6.1` (`ef4a1cfcca62b77ad3558337ff3e1c7f6beeadfe`) is included; upstream `main`
is 4 commits after it.

## Incoming changes

- **AI**: HTTP error and retry attempt reporting to `onResponse` (`8a57d42a5`, `#12502`, `#12376`),
  shared linear-time `SseDecoder` for Anthropic, OpenAI Codex, Mistral, and `pi-messages`
  (`da7e26cc8`, `#12451`, `#12224`), tighter `request_too_large` boundary check in
  `isContextOverflow()` (`32c7f6d7b`, `#12438`, `#12343`), OpenRouter empty-stop retry when
  `native_finish_reason` indicates an upstream failure (`9b911b409`, `#12407`), `pi-classifier`
  API renamed to `pi-decision` posting to `<baseUrl>/decision` (`9553d5834`, `604359311`), and
  decision-model prose updates (`6906528da`).
- **Coding agent**: Breaking replacement of `showCacheMissNotices` with per-notice settings
  `notices.{cacheMisses, cacheWarming, compactionCosts, reasoningDrops}` and migration
  (`88c6e00f7`, with default-off restored in `e24c9d5f0`), linear-time JSONL/session/llama line
  reading (`da7e26cc8`, `#12224`), `after_provider_response` WebSocket failure documentation
  (`c7a5f2e78`, `#12503`), post-v1.6.1 `/llama` download confirmation preferring a browsed highlight
  over typed `owner/repository` (`bfafd8ed5`, `#12537`, `#12465`), and temp-path-independent
  `output-file-failures` test (`3511d4554`).
- **TUI, MCP, Durable, Env, Chord, p2, p3**: Linear-time bracketed-paste end-marker scanning in
  `StdinBuffer` (`pasteBuffer` + 5-character `pasteTail` window), `SseDecoder` in MCP Streamable HTTP, and per-caller incremental text line scans in Durable
  Node env and `RemoteExecutionEnv` (`da7e26cc8`, `#12224`); streaming backups in p2 (`2e4deff6b`);
  Chord sync exports and backup marker in p3 (`7cf1443c1`); macOS file-event startup waits in two
  Chord plugin tests (`e4cd354e6`); Nix model catalog pin update (`660831bf8`); and the `v1.6.1`
  release (`ef4a1cfcc`, `dbc8075ab`).

## Conflict decisions and retired fork deltas

Forty-four paths conflicted, plus one entry-graph budget update and one Google error-response header
test alignment.

| Paths | Resolution |
| --- | --- |
| `packages/ai/src/utils/provider-retry.ts`, `packages/ai/src/api/{google-client,google-shared,google-generative-ai,google-vertex,google-images,openai-responses}.ts`, `packages/ai/test/{google-shared-retry,provider-error-response}.test.ts`, `scripts/check-entry-graphs.mjs` | Kept fork's `isProviderLimitError()` short-circuit in `retryProviderRequest()` alongside upstream's `onErrorResponse` callback, and raised `./utils/provider-retry`'s entry-graph budget from 6 to 7 for upstream's `headers.ts` import. Kept `createGoogleFetch()` reporting real HTTP response headers on every Google attempt (2xx and 4xx/5xx) while omitting `onResponse` from `retryGoogleRequest()` in `google-generative-ai`, `google-vertex`, and `google-images` so Google errors never double-fire `onResponse`; kept `retryGoogleRequest(request, model, options, getFailureHeaders)` firing `onErrorResponse` for direct callers (`google-shared-retry.test.ts`), and updated `provider-error-response.test.ts` to assert `headers: true` for Google. Passed `onErrorResponse` in `openai-responses.ts`'s SSE retry path without disturbing direct WebSocket transport. |
| `packages/ai/src/types.ts`, `packages/ai/README.md`, `packages/coding-agent/docs/{codemode,models}.md` | Adopted upstream's `"pi-decision"` rename (replacing `"pi-classifier"` in `KnownClassifierApi`) while keeping fork's `"google-decisions"` API and Google/Cloudflare decision-model docs. |
| `packages/ai/src/api/{anthropic-messages,openai-codex-responses}.ts`, `packages/coding-agent/src/{core/session-manager,modes/rpc/jsonl}.ts`, `packages/durable/src/env/node.ts`, `packages/env/src/remote-env.ts`, `packages/mcp/src/transports/streamable-http.ts`, `packages/tui/src/stdin-buffer.ts` | Adopted upstream's shared `SseDecoder` (`packages/ai/src/utils/sse.ts`), per-caller incremental line scans (`decodeJsonl`, `lines`, `loadEntriesFromFile`, and class-local `indexOf` scans in `durable/src/env/node.ts` and `env/src/remote-env.ts`), and `StdinBuffer`'s `pasteBuffer` + 5-character `pasteTail` end-marker window verbatim (`#12224`, retiring fork's separate paste and MCP SSE buffer optimizations) while preserving fork's WHATWG EOF truncated-frame discard (`#567`) via the `trailingAtEof` stamp on `sse.end()` events in `anthropic-messages.ts` and the `done`-scoped discard in `openai-codex-responses.ts`, preserving `onPending` in `attachJsonlLineReader()`, and keeping fork's `SessionManager` streaming/tail-read optimizations and `RemoteExecutionEnv` / `NodeExecutionEnv` logic. |
| `packages/ai/catalog/providers/qwen-token-plan-individual.ts`, `packages/ai/test/qwen-token-plan-models.test.ts` | Replaced `qwen4-max-preview` (preview expired 2026-11-25 per upstream `#12313`) with `qwen4-max` after live `models.dev` dropped `qwen4-max-preview` and added `qwen4-max` to both `alibaba-token-plan` and `alibaba-token-plan-cn`. |
| `packages/coding-agent/src/{core/settings-{defaults,schema,manager},modes/interactive/{interactive-mode,components/settings-selector}}.ts`, `packages/coding-agent/schemas/settings.schema.json`, `packages/coding-agent/docs/settings.md`, `packages/coding-agent/test/{interactive-mode-assistant-diagnostics,interactive-mode-compaction}.test.ts` | Adopted upstream's breaking replacement of `showCacheMissNotices` with `notices.{cacheMisses, cacheWarming, compactionCosts, reasoningDrops}` and its migration while preserving `compactView`, `skillExposure`, `beforeMutation?.()` in `setNotice()`, fork's `hideThinkingBlock` docs, `ChatContainer` compaction tests, and fork's `droppedThinkingReport` / `countKnownThinkingDrops` plain-language diagnostics wired to `notices.reasoningDrops`. |
| `packages/coding-agent/test/llama-ui.test.ts` | Kept both fork's search-abort tests and upstream's post-`v1.6.1` browsed-highlight vs typed `owner/repository` confirmation tests (`#12465`). |
| `{apps/p2,packages/{ai,coding-agent,evals}}/package.json`, `nix/model-catalog.json`, `package-lock.json`, `packages/coding-agent/install-lock/package-lock.json` | Bumped all internal `@earendil-works/*` pins to `1.6.1` while keeping fork's `@earendil-works/chord` and `@earendil-works/pi-durable` in `coding-agent` and newer reviewed external pins (`@anthropic-ai/sdk` `1.12.0`, `@aws-sdk/*`, `diff` `9.0.0`, `elanor-react` `0.1.1`, `vitest` `5.1.1`, `vitest-evals` `0.18.1`), adopted upstream `nix/model-catalog.json`, and regenerated both lockfiles with `npm install --package-lock-only --ignore-scripts` and `node scripts/generate-coding-agent-install-lock.mjs`. |
| `packages/*/CHANGELOG.md` (all 11 packages) | Restored `## [1.6.1]` and below byte-identical to tag `v1.6.1` across every package (including auto-merged `durable` and `mcp`), kept active fork entries plus post-`v1.6.1` upstream `#12465` under `## [Unreleased]`, and retired fork entries superseded by `v1.6.1` (replayed tool-call `status: "completed"`, pre-3.6.1 Google `xhigh` entry, MCP SSE copying entry). |

## Verification

All runs used macOS on Node 24.22.3 with offline/faux providers:

- `npm install --ignore-scripts`, `node scripts/generate-coding-agent-install-lock.mjs --check`,
  `npm run hydrate:model-data` (1700 tool-capable models), and `npm run build:offline` passed.
- `node scripts/check-released-changelogs.mjs` passed (`Released changelog sections match v1.6.1.`).
- `npm run check` passed (Biome across 2786 files, pinned deps, runtime deps, ts-imports, entry
  graphs, coding-agent install lock, root and examples `tsc --noEmit`, browser smoke).
- `cd apps/p2 && npm run check` passed (Biome across 993 files + `tsc --noEmit`).
- `./test.sh` targeted suites passed:
  - `packages/ai` (15 files: `google-shared-retry`, `provider-error-response`, `provider-retry`,
    `pi-decision`, `fetch-option`, `anthropic-sse-parsing`, `openai-codex-stream`, `overflow`,
    `radius-provider`, `google-images`, `sse`, `google-stream`, `google-stream-errors`,
    `openai-responses-websocket`, `classifier-models`): 287 passed, 0 failed.
  - `packages/coding-agent` (12 files: `settings-manager`, `settings-selector`,
    `interactive-mode-assistant-diagnostics`, `interactive-mode-compaction`, `rpc-jsonl`,
    `llama-ui`, `output-file-failures`, `session-manager/file-operations`,
    `suite/regressions/4167-thinking-toggle-pending-tool-render`, `config-schemas`, `changelog`,
    `compact-view`): 238 passed, 0 failed.
  - `packages/durable` (`env-line-scan.test.ts`): 4 passed, 0 failed.
  - `packages/mcp` (`streamable-http.test.ts`): 32 passed, 0 failed.
  - `packages/tui` (`stdin-buffer.test.ts`): 86 passed, 0 failed.
