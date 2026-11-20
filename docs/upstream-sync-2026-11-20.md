# Upstream integration: 2026-11-20 (v1.6.0)

## Baseline

This integration merges upstream `main` `25190b72c195ce6502103ecba55064eade1f188b` into fork
`61ac5c61e7cba85de49bcbe737fc7ff7bb96c7d9`, preserving both histories. The preceding upstream
baseline was `653f332b6fe22e2e927dd3d553d20234a3de27f0` (42 incoming commits).

Official `v1.6.0` (`faac585884ae2c013a6b1400f3e9e77f10b34bac`) is in this range. Upstream `main` is
11 commits after it: post-release `[Unreleased]` headers, `#10506` retry abort-listener cleanup,
Cloudflare HTTP 525 and `#12227` gateway retry patterns, `#12295` editor repaint after
`pasteToEditor`/`setEditorText`, and `p3` design docs.

## Incoming changes

- **Release v1.6.0**: package versions (`1.6.0`), `packages/ai/src/utils/version.ts`,
  `nix/model-catalog.json`, and released `[1.6.0]` changelog sections.
- **AI**: OpenAI Codex leading `developer`/`system` input item (dropping top-level `instructions`,
  `#12273`), Codex mid-conversation `configuration_update` effort changes including `off` -> `"none"`
  and `max_output_tokens` (`#12269`), `openai_input_transformations` diagnostic recording
  (`03de604b8`), `qwen4-max-preview`, post-release retry abort-listener cleanup (`#10506`), and
  Cloudflare HTTP 525 / gateway retry patterns (`#12227`).
- **Coding agent**: stdout flush before exit (`#12133`), `SIGTSTP` terminal restore (`#12283`),
  search-picker cursor/highlight fixes (`#12245`), unscoped syntax-highlight theme foreground
  (`#11092`), llama.cpp classifier image input (`#12282`), Enter-on-path-autocomplete fix (`#12309`),
  and post-release `pasteToEditor`/`setEditorText` `requestRender()` (`#12295`).
- **TUI**: `TUI.setSuspendSignalHandler()` (`#12283`), `Editor` autocomplete Enter fix (`#12309`),
  and `SettingsList` search cursor-key fix (`#12245`).
- **Chord**: sync batching (`BATCH_BYTES`), start-timer test incarnation wait (`ff8970889`).
- **p2 & p3**: backup, search worker, MCP sheet UI, and `p3` docs.

## Conflict decisions and retired fork deltas

Twenty-eight paths conflicted, plus three auto-merged duplicate-code sites audited and cleaned up.

| Paths | Resolution |
| --- | --- |
| `packages/ai/catalog/families/openai.ts`, `packages/ai/src/api/{openai-prompt-cache,cloudflare}.ts` | Retired fork's re-export of `OPENAI_MID_CONVO_EFFORT_MODEL_IDS` from `openai-prompt-cache.ts` in favor of upstream's `OPENAI_MID_CONVO_EFFORT_MODEL_IDS` in `catalog/families/openai.ts`. `cloudflare.ts` keeps its local set (checked by `cloudflare-openai-positional.test.ts`) to preserve Cloudflare `/openai` passthrough parity (`supportsMidConvoEffort`, `supportsExplicitPromptCacheMode`, `supportsToolSearch`). |
| `packages/ai/src/api/openai-codex-responses.ts`, `packages/ai/catalog/providers/openai.ts`, `packages/ai/src/providers/compat-schema.ts`, `packages/ai/test/{max-thinking,openai-codex-stream,openai-responses-mid-convo-effort}.test.ts` | Adopted upstream `#12273` and `#12269` (`getConfigurationUpdateEffort`, `resolveReasoningEffort`, `off` -> `"none"`, `max_output_tokens`) and retired the fork's duplicate Codex effort helpers. Kept fork's `service_tier_fallback`, `applyServiceTierPricing`, `failedResponseError`, canonical zstd guard, and WebSocket occupancy refactor. |
| `packages/ai/src/api/{openai-responses-shared,openai-responses}.ts` | Adopted upstream `appendReasoningRemovals(output, response?.input_transformations)` (`03de604b8`) and retired fork's inline `rawTransformations` block (preventing double-recorded diagnostics). Kept fork's `finalizeResponse(event.response)` on `response.failed`, `failedResponseError`, and `applyServiceTierPricing`. |
| `packages/ai/src/utils/retry.ts`, `packages/ai/test/retry.test.ts` | Adopted upstream's HTTP 525 and `#12227` retryable patterns plus `#10506` regression test while retaining fork's `utils/sleep.ts` backoff, zero/finite `retryDelayMs` guard, and Gemini retryable finish-reason patterns. |
| `packages/ai/test/openai-completions-tool-choice.test.ts` | Kept fork's typed fixture (`openAICompletionsModel`) to satisfy `scripts/biome/stable-payload-fixtures.grit`. |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `packages/coding-agent/test/interactive-mode-assistant-diagnostics.test.ts` | Retained fork's `droppedThinkingReport`, high-water-mark `countKnownThinkingDrops`, plain-language causes for Anthropic and OpenAI drops, and `addChatActivity(...)` (removing unused upstream `getDroppedReasoning`). Adopted upstream's `await flushStdout()` in `shutdown()` alongside fork's `restartFailure ? 1 : 0` exit code, `SIGTSTP` handling, and `requestRender()` in `pasteToEditor`/`setEditorText`. |
| `packages/tui/src/tui.ts` | Kept both upstream's suspend-signal fields (`#12283`) and fork's `renderRequested` lifecycle doc comment. |
| `packages/chord/test/node/workers/workers.test.ts` | Adopted upstream `ff8970889` incarnation wait in the start-timer test, retiring the fork's test-only `principal` hook workaround while keeping the fork's `ready`-crosses-`stop` fix and test. |
| `{apps/p2,packages/{ai,coding-agent,evals}}/package.json`, `package-lock.json`, `packages/coding-agent/install-lock/package-lock.json` | Bumped all workspace package versions and internal `@earendil-works/*` pins to `1.6.0`. Kept fork's newer reviewed external dependency pins (`openai` `7.60.0`, `@google/genai` `3.6.0`, `@anthropic-ai/sdk` `1.10.0`, `vitest` `5.1.1`, `diff` `9.0.0`, `@earendil-works/elanor-react` `0.1.1`), `coding-agent`'s `@earendil-works/chord` + `@earendil-works/pi-durable` + `stream-*` dependencies, and Node security floors (`^22.23.5 || ^24.22.3 || >=26.13.1`). Regenerated both lockfiles. |
| `packages/*/CHANGELOG.md` (all 11 packages) | Matched `v1.6.0` byte-for-byte from `## [1.6.0]` downward (also correcting auto-merged fork lines in `durable` and `mcp` that Git placed under `[1.6.0]`). Kept active fork entries and post-`v1.6.0` upstream entries under `## [Unreleased]`, and retired superseded entries (`#12269`, `#12273`, `03de604b8`, `#10506`). |

## Verification

All runs used macOS on Node 24.22.3 with offline/faux providers:

- `npm ci --ignore-scripts`, `npm run hydrate:model-data` (1698 tool-capable models), and `npm run build:offline` passed.
- `node scripts/check-released-changelogs.mjs` passed (`Released changelog sections match v1.6.0.`).
- `npm run check` passed (Biome across 2754 files, pinned deps, runtime deps, ts-imports, entry graphs, coding-agent install lock, root and examples `tsc --noEmit`, browser smoke).
- `cd apps/p2 && npm run check` passed (Biome across 980 files + `tsc --noEmit`).
- `./test.sh` targeted suites passed:
  - `packages/ai` (16 files covering Codex stream/service-tier/WebSocket, Completions tool-choice, Responses compat/input-transformations/mid-convo-effort/terminal-event/ultrafast-pricing, Cloudflare positional parity, max-thinking, retry/Google retry, model-data validation, providers, Qwen Token Plan): 563 passed, 0 failed.
  - `packages/coding-agent` (21 files covering interactive-mode diagnostics/suspend/paste, Wave 1 `<host>` system-prompt, `skillExposure` + compact skills, `.git` exclusion in `grep`/`find`, `flush-stdout`, selector/submenu/syntax-highlight/llama tests, changelog, Cloudflare compat): 279 passed, 0 failed.
  - `packages/tui` (full package suite via `node --test`): 1289 passed, 1 skipped, 0 failed.
  - `packages/chord` (`workers.test.ts`, `sync.test.ts`): 75 passed, 0 failed.
  - `npm run test:scripts`: 285 passed, 1 skipped, 0 failed.
