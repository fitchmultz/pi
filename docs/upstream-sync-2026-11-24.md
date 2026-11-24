# Upstream integration: 2026-11-24

## Baseline

This integration merges upstream `main` `433c1fd94c6aa3cf3fa408aad0d765f6763bd362` into fork
`c94bfea6e71f1672298e6112e1f576af9dc56426`, preserving both histories. The preceding upstream
baseline was `9c4652688590abb836b40ebd1e4725ecf9a7c7d1` (52 incoming commits, 51 non-merge).

Official release remains `v1.6.0` (`faac585884ae2c013a6b1400f3e9e77f10b34bac`); upstream `main` is
now 96 commits after it.

## Incoming changes

- **AI**: Gemini 4 Hydrogen and Neon `xhigh` thinking (`ThinkingLevel.XHIGH`), shared
  `getGoogleBudget()` across Google Generative AI and Vertex (fixing Vertex Gemini 2.5 Flash-Lite
  budgets), and Gemini 3.x finish reasons (`001ffff32`); Google `formatGooglePromptBlockError()`
  with safety ratings and chunk-count incomplete-stream errors (`117eac3a0`, `#12357`); OpenAI
  Responses replayed tool calls with `status: "completed"` (`69a699348`, `#12367`) preventing
  GPT-6.2 reasoning loss on WebSocket reconnects; Codex initial effort pinning via
  `prepareResponsesPrompt(..., { effortBaseline: "initial" })` (`a588a7bc4`, `#12437`); Claude
  thinking-off support sourced from Anthropic's `models.dev` entry (`433c1fd94`, `#12489`);
  non-strict Anthropic tool schema dialect preservation (`4245b07b4`); OpenRouter
  `native_finish_reason` tracking (`ddf5868d2`) and classifier `responseId`/cost (`bff71c709`);
  retry classifier fixes for `"request rate increased too quickly"` (`0888fd79a`, `#12434`) and
  `finish_reason: "error"` (`4f3d2be9a`, `#12455`); `pi-classifier` API (`c2f3a5cea`, `#12421`),
  Radius classifier support (`f25aecaa1`), and Copilot `gpt-6-luna-decisions` + account-filtered
  classifiers (`90ef46ffe`, `#12495`); empty assistant content for affected Workers AI models
  (`b8be10a7a`); and catalog removals for retired OpenAI (`gpt-5-chat-latest`), Groq, and Mistral
  (`devstral-medium-latest`, `pixtral-12b`) models.
- **Coding agent**: Non-crashing `OutputFileStream` temp-file failure handling with
  `fullOutputError` fallback across bash tool, user bash executor, and `OutputAccumulator`
  (`943a99e3c`, `8209929fb`, `#12452`, `#12461`); unresolved stored credential status reporting and
  `clearConfigValueCacheEntry()` (`585648aaf`, `#12454`); explicit `text/plain` MIME type for
  `wl-copy` (`2d8133085`, `#12446`); oversized Mermaid source explanation (`9034e8a89`, `#12442`);
  rebuilt `!` output following `ctrl+o` (`0ab23c37b`, `#12427`); startup dialog blocked/permission
  reporting (`27a40ea2a`, `642a705e1`); simplified first-time setup (`f8149d1ab`); Windows Git Bash
  discovery (`e8ee38887`) and WSL update guard (`e3fa711f4`); and `thinkingLevelMap` docs
  (`d91ac96a4`).
- **TUI & MCP**: Skip OSC 8 hyperlinks over 8,192 chars (`6ca01d1e9`, `#12475`), keep Markdown
  after an unclosed currency `$` sign (`362bf6f1b`, `#12472`), Windows Tabby right-click paste fix
  (`165c70df9`), and MCP client matching responses echoing numeric request IDs as strings
  (`c717e647d`, `#12430`).
- **Chord & p2**: Backup moved to plugin and scoped to user (`10149e47c`, `8433532f9`, `d4760131e`,
  `b81e9ed66`), removed sync writer epochs (`a4c097630`), persistent unfinished logins across
  dropped connections (`fb248c7fc`, `AWAY_MS`), headphone-aware voice barge-in (`56c96af0b`),
  `cmd+shift` session cycling (`6cc1a3dfa`), hidden-transcript measurement guard (`c98c83037`), and
  WebKit image thumbnails / Markdown artifact scroll preservation (`ff0e0ff17`, `3c1e7798b`).

## Conflict decisions and retired fork deltas

Fifty-two paths conflicted, plus three test alignments for merged upstream contracts.

| Paths | Resolution |
| --- | --- |
| `packages/ai/package.json`, `package-lock.json`, `packages/coding-agent/install-lock/package-lock.json` | Kept fork's newer reviewed pins (`@google/genai` `3.6.1`, `@smithy/node-http-handler` `4.14.2`) and regenerated both lockfiles cleanly with `npm install --ignore-scripts` and `node scripts/generate-coding-agent-install-lock.mjs`. |
| `packages/ai/src/api/{google-shared,google-generative-ai,google-vertex}.ts`, `packages/ai/test/{google-stream,google-stream-errors,google-thinking-level-map}.test.ts` | Kept fork's unified `streamGoogle()` / `buildParams()` architecture in `google-shared.ts` (preserving `thinkingDisplay: "omitted"`, `CONTINUATION`, `store: false`, `VALIDATED` fallback, and transient `PROHIBITED_CONTENT` retry per `PIF-224`) while adopting upstream's shared `getGoogleBudget()`, `ThinkingLevel.XHIGH`, 3.x finish reasons, `formatGooglePromptBlockError()`, and chunk-count incomplete-stream errors. Removed the superseded pre-`001ffff32` Vertex Flash-Lite 128-token test and used `SAFETY` in `google-stream-errors.test.ts` so `PROHIBITED_CONTENT` stays retryable as tested in `google-stream.test.ts`. |
| `packages/ai/src/api/{openai-responses-shared,openai-responses,openai-codex-responses,azure-openai-responses}.ts` | Adopted upstream `prepareResponsesPrompt()` (`#12437`), Codex `effortBaseline: "initial"` pinning (`#12361`), and `replayedCall` `status: "completed"` (`#12367`) while keeping `toolSupport?: TranscriptToolSupport` optional for upstream callers and preserving all fork `#563`/`#564` optimizations (direct OpenAI Responses WebSocket mode, unified Codex `ResponsesWSBase` transport, 12h cache retention / `prompt_cache_options`, `OPENAI_RESPONSES_TOOL_CALL_PROVIDERS` with `zai`, `summaryBlock`, `compactionTrigger`, and `applyServiceTierPricing`). |
| `packages/ai/src/api/openai-completions.ts` | Combined fork's `openBlocks` / `toolCallsByIndex` / `prompt_progress` tracking with upstream's `isOpenRouter` / `nativeFinishReason` tracking. |
| `packages/ai/catalog/providers/openai.ts`, `packages/ai/src/types.ts`, `packages/ai/src/providers/radius-config.ts`, `packages/ai/README.md` | Adopted upstream `#12450` removal of shut-down `GPT_5_CHAT_LATEST` while keeping `normalizeOpenAIModel()`, combined `"google-decisions"` and `"pi-classifier"` in `KnownClassifierApi`, combined `cost.tiers` validation with Radius classifier models, and merged docs for both fork and Copilot classifiers. |
| `packages/ai/test/{abort,context-overflow,cross-provider-handoff,empty,image-tool-result,mistral-raw-stop-reason,mistral-tool-schema,radius-provider,responseid,stream,tokens,tool-call-without-result,total-tokens,unicode-surrogate}.test.ts` | Adopted upstream `#12449` retired Mistral replacements (`mistral-medium-latest`, `ministral-14b-latest`) while preserving fork `#10507` Radius pricing tests and `#12148` `mistral-large-4` strict-tool coverage. |
| `packages/coding-agent/src/{utils/output-files,core/bash-executor,core/tools/{bash,output-accumulator},modes/interactive/components/bash-execution}.ts`, `packages/coding-agent/test/{bash-spill,private-spill,output-file-failures}.test.ts` | Adopted upstream `#12452`/`#12461` non-crashing `OutputFileStream` / `OutputFileResult` / `fullOutputError` contract while retaining `write(data): Promise<void> | undefined` backpressure (resolving cleanly on write callback or failure, never rejecting), 300 s default foreground bash timeout (`ShellTimeoutError`), and compact-view / mouse expand handling. Aligned `bash-spill.test.ts` and `private-spill.test.ts` to the non-crashing `fullOutputError` contract and supplied `keyHint` in `output-file-failures.test.ts`'s `renderResult` test stub. |
| `packages/coding-agent/src/core/{auth-storage,resolve-config-value,model-runtime,provider-composer,model-resolver}.ts`, `packages/coding-agent/test/auth-storage.test.ts`, `packages/coding-agent/docs/{models,providers}.md` | Kept both fork's `refreshConfigValueCache` (reload + 401/403 retry) and upstream's `clearConfigValueCacheEntry` (`/login` re-entry), combined `!this.ignoresStoredCredentials(providerId)` with `configuredProviders.has(providerId)` in `getProviderAuthStatus()`, kept `ProviderAuthFallback` alongside upstream's JSDoc, kept `zai`/`zai-coding-cn` default `glm-5.4` while adopting upstream's `mistral: "mistral-medium-latest"`, and merged docs. |
| `.github/APPROVED_CONTRIBUTORS`, `apps/p2/plugins/login/logins.ts`, `apps/p2/test/p2/login.test.ts`, `apps/p2/plugins/voice/engine.ts` | Adopted full upstream `APPROVED_CONTRIBUTORS`, kept both `AWAY_MS` and fork's discriminated union `LoginsState` + cross-tab late-cancel regression check in `login.test.ts`, and combined upstream's headphone-aware `#openMicrophone(echoCancellation)` with fork's `run !== this.#running` stale-start track cleanup. |
| `packages/{ai,coding-agent,durable,mcp,tui}/CHANGELOG.md` | Merged fork and upstream entries under `## [Unreleased]` with single subsection headers while keeping `## [1.6.0]` and below byte-identical to tag `v1.6.0`. |

## Verification

All runs used macOS on Node 24.22.3 with offline/faux providers:

- `npm install --ignore-scripts`, `node scripts/generate-coding-agent-install-lock.mjs`, `npm run hydrate:model-data` (1690 tool-capable models), and `npm run build:offline` passed.
- `node scripts/check-released-changelogs.mjs` passed (`Released changelog sections match v1.6.0.`).
- `npm run check` passed (Biome across 2783 files, pinned deps, runtime deps, ts-imports, entry graphs, coding-agent install lock, root and examples `tsc --noEmit`, browser smoke).
- `cd apps/p2 && npm run check` passed (Biome across 992 files + `tsc --noEmit`).
- `./test.sh` targeted suites passed:
  - `packages/ai` (22 files covering Google stream/errors/thinking-level maps, OpenAI Codex/Responses/WebSocket/replay/compat, max-thinking, cache-retention, Cloudflare positional, Anthropic SSE/strict tools, classifiers/`pi-classifier`, Radius, retry, Z.AI, model-data validation, Claude/Copilot catalog, OpenRouter raw stop reasons): 493 passed, 4 skipped, 0 failed.
  - `packages/coding-agent` (15 files covering `output-file-failures`, `bash-spill`, `private-spill`, `bash-executor-truncation`, `auth-storage`, `model-resolver`, `model-runtime-auth-options`, `provider-credential-isolation`, `tools`, `compact-view`, `clipboard`, `sdk-session-manager`, `cache-warmer`, `startup-ui-program-status`, `interactive-mode-extension-dialogs`): 419 passed, 0 failed.
  - `packages/tui` (full package suite): passed, 0 failed.
  - `packages/mcp` (`client.test.ts`, `streamable-http.test.ts`): 47 passed, 0 failed.
  - `apps/p2` (`test/p2/login.test.ts`): 6 passed, 0 failed.
  - `npm run test:scripts`: 287 passed, 1 skipped, 0 failed.
