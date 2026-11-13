# Upstream integration: 2026-11-13

## Baseline

This integration merges upstream main `147dc531381960e2dd5e69fd05b92bd056b678ea` into fork main
`7ab6bd5807a3aa748edaec57c0f0a56daea1e1c1`, preserving both histories. The preceding upstream
baseline is `6273031b012ab3c017cdbf593a62b7e6792186a8`. There are 166 incoming non-merge commits
(170 commits after official v1.5.2).

Upstream CI on `147dc531381960e2dd5e69fd05b92bd056b678ea` passed all jobs before the merge.

## Incoming changes

- **AI**: `@google/genai` upgrades to 2.32.0 with `automaticContinuation: false` and custom `fetch`
  passed through `httpOptions` ([#12103](https://github.com/earendil-works/pi/pull/12103)).
  `models.json` `modelOverrides` adds `enabled: false` ([#12046](https://github.com/earendil-works/pi/pull/12046)).
  Google tool declarations drop empty `required: []` arrays ([#11988](https://github.com/earendil-works/pi/pull/11988)).
  Assistant error timing metadata is preserved (`065a0b305`), OpenAI Completions ignores an invalid
  `reasoning_effort` (`2e5e2e579`), and Anthropic OAuth reports Claude Code 2.1.326 (`432098902`).
- **TUI**: Kitty fullscreen full redraws skip `\x1b[2J` when uploaded images exist so unplaced
  cached image data stays resident ([#12010](https://github.com/earendil-works/pi/pull/12010)).
  Editor autocomplete updates synchronously ([#12055](https://github.com/earendil-works/pi/pull/12055)).
- **Coding agent**: local `read` attaches an `error` listener before awaiting `readline` so early
  cancellation cannot raise an unhandled `AbortError`
  ([#11956](https://github.com/earendil-works/pi/pull/11956)). Standalone Bun builds enable
  `--compile-autoload-package-json` ([#12012](https://github.com/earendil-works/pi/pull/12012)).
  MCP notification-triggered tool discovery is coalesced per server (`545f83e04`). HTML export
  inlines its stylesheet and viewer script, preserves leading whitespace in collapsed Bash previews,
  and wraps wide tables (`9125a41e8`, `2a0be0b1f`, `147dc5313`). Model unavailability scopes per
  API key ([#12071](https://github.com/earendil-works/pi/pull/12071)), `--models` preserves glob
  segment boundaries ([#12070](https://github.com/earendil-works/pi/pull/12070)), `SessionManager.open`
  propagates read errors ([#12075](https://github.com/earendil-works/pi/pull/12075)), and custom
  editor extensions keep image paste ([#12040](https://github.com/earendil-works/pi/pull/12040)).
- **Durable**: suspendable work lands across `Session`, `Harness` and `Codemode` (`sleep`, `wait`,
  `signal`, `checkpoint`, `durableTools`, `suspendWhenIdle`), along with Durable prompt templates
  (`d03b8c587`).
- **Env**: post-exit command output drains while the output link is backed up (`b48c675a9`), and
  pipe readers stop once a descendant inherits stdio after exit (`8ba28b75a`).
- **Chord and p2**: Chord gets its own CI test matrix shard (`510b19037`). p2 adds project/folder
  filtering, session-tree navigation, Mermaid diagrams, terminal hyperlinks, workspace search and
  review UI updates, and Radius brain reconnection refinements.
- **Release scripts**: `getPublicWorkspacePackages` inspects only direct `packages/*` directories so
  leftover binary staging copies are ignored (`2930f5220`).

## Retired fork divergences

Five fork changes are retired in favor of upstream's implementations:

1. **Local `read` stream open-abort listener** (`packages/coding-agent/src/core/tools/read.ts`):
   covered by upstream [#11956](https://github.com/earendil-works/pi/pull/11956). The fork's
   `read-streaming.test.ts` regression stays.
2. **Kitty fullscreen full-redraw placement clear** (`packages/tui/src/tui-alt-screen.ts`): covered
   by upstream [#12010](https://github.com/earendil-works/pi/pull/12010). The fork's source-aware
   selection and active gesture handling in `tui-alt-screen.ts` remain.
3. **Standalone Bun `--compile-autoload-package-json`** (`scripts/build-binaries.sh`,
   `packages/coding-agent/package.json`): covered by upstream
   [#12012](https://github.com/earendil-works/pi/pull/12012). The fork keeps its Linux CI standalone
   check and `compiled-extension-packages.test.ts`, plus the `../durable` build step in
   `packages/coding-agent/package.json` (`build:binary`).
4. **Env daemon post-exit output drain under link backpressure**
   (`packages/env/daemon/src/{exec,output,process,pty}.rs`,
   `packages/env/test/{process,remote}.test.ts`): replaced by upstream's `awaiting_drain` /
   `OutputDrained` implementation (`b48c675a9`), keeping the fork's macOS post-exit group kill in
   `exec.rs` and overflow watch regression in `remote.test.ts`.
5. **`@google/genai` 2.32.0 with `automaticContinuation: false` and `httpOptions.fetch`**
   (`packages/ai/package.json`, `packages/ai/src/api/google-{generative-ai,vertex,shared}.ts`):
   covered by upstream [#12103](https://github.com/earendil-works/pi/pull/12103). The fork keeps
   its `google-shared.ts` stream/request unification and updates `packages/ai/test/fetch-option.test.ts`
   to assert `stopReason === "length"` when automatic continuation is disabled.

The fork keeps `modelOverrides.hidden` alongside upstream's `modelOverrides.enabled`: `hidden`
omits an overridden built-in model from `/model` and `--list-models` entirely, whereas `enabled: false`
keeps the model selectable through explicit settings while excluding it from default discovery.

## Conflict decisions

Forty-two paths conflicted.

| Paths | Resolution |
| --- | --- |
| `package-lock.json`, `packages/{ai,coding-agent}/package.json`, `packages/coding-agent/install-lock/package-lock.json`, `scripts/generate-coding-agent-install-lock.mjs` | Adopt `@google/genai` 2.32.0 alongside upstream while keeping the fork's newer reviewed pins and coding-agent `chord`/`pi-durable`/`stream-chain`/`stream-json` dependencies, keep upstream's `#12012` `build:binary` flags alongside the `../durable` build step, keep `protobufjs` in `ALLOWED_SCRIPT_PACKAGES`, and regenerate both lockfiles. |
| `packages/{ai,chord,coding-agent,durable,env,tui}/CHANGELOG.md` | Place upstream's `[Unreleased]` entries first, followed by retained fork `[Unreleased]` entries, removing entries for the five retired fork changes. Released sections remain byte-identical to upstream `v1.5.2`. |
| `.github/APPROVED_CONTRIBUTORS` | Keep the fork's list. |
| `.github/workflows/{ci,issue-gate,issue-triage-labels}.yml` | Add upstream's `chord` test matrix shard in `ci.yml` while keeping the fork's Linux backup DNS step (matching `matrix.name != 'durable' && matrix.name != 'chord'`), standalone Bun extension check, and `macos-restart-background` job. Keep both workflows restricted to `fitchmultz/pi` while adopting upstream's `workflow_dispatch` fallback and `pkg:durable` / `pkg:chord` triage labels. |
| `packages/ai/src/api/google-{generative-ai,vertex}.ts` | Keep the fork's shared `google-shared.ts` request/stream owner while adopting upstream's empty-`required` omission (`#11988`), assistant error timing metadata (`065a0b305`), and `automaticContinuation: false` / `httpOptions.fetch` (`#12103`) across `google-{generative-ai,vertex,shared}.ts`. |
| `packages/tui/src/tui-alt-screen.ts` | Adopt upstream's `#12010` comment on the identical Kitty full-redraw branch while retaining the fork's source-aware selection and active gesture ownership. |
| `packages/env/daemon/src/{exec,output,process,pty}.rs` | Adopt upstream's post-exit drain and inherited-stdio handling while keeping `sys::kill_group_after_exit(pid)` in `exec.rs`. |
| `packages/durable/src/{harness/scheduler,session/transaction}.ts` | Combine upstream's `suspended` scheduler state and `suspendWhenIdle` with the fork's single `SchedulerState` tagged union (`paused` / `running` / `suspended` / `closing`), and forward `checkCommit` through `TransactionStorage`. |
| `packages/coding-agent/src/{main,core/agent-session,core/session-manager,core/export-html/tool-renderer}.ts`, `packages/coding-agent/test/{export-html-whitespace,model-resolver,read-streaming}.test.ts` | Keep fast header-first `--session`/`--fork` resolution alongside upstream's `SessionManager.open` error propagation (`#12075`), populate `_restoredToolNames` in `restoreWorkingSession` alongside upstream's `#12054` pending-tool narrowing, keep `toolExposure` in coalesced MCP discovery refresh, keep expanded tool-call HTML rendering alongside `pre.tool-output`, and keep both sides' regression cases in the three test files. |
| `scripts/build-binaries.sh`, `test.sh` | Adopt upstream's `#12012` Bun compile flags while keeping Apple Silicon macOS and Linux targets only; keep the fork's isolated-home, Node/npm pre-resolution, Termux allowlist, and focused `-- <command>` mode in `test.sh` while removing `OPENAI_ADMIN_KEY` with upstream. |
| `apps/p2/plugins/{chat/web,terminals/Terminal}.tsx`, `apps/p2/src/hosts/server.ts`, `apps/p2/test/p2/{helpers,plugin-layout,terminal-tool,tui-attach,web,workspace-environment}.test.ts` | Combine upstream's `openExternalUrl` / `SessionSettings` props with the fork's outbox `Message` type and missing-terminal reconnect reset; keep bundle-input retention, failed-start socket cleanup, and startup signal handling in `server.ts`; keep `--use-mock-keychain` in `helpers.ts` and `web.test.ts`, Node 26 TUI skip gate in `tui-attach.test.ts`, `TMPDIR` canonicalization in `workspace-environment.test.ts`, and upstream's equivalent `react-dom` and archive-job polling test updates. |

Six adjustments outside the conflicted files:

- `packages/ai/src/api/google-shared.ts`: carried upstream's assistant error timing metadata
  (`065a0b305`) and `httpOptions.fetch` forwarding (`#12103`) into the fork's shared Google adapter
  module.
- `packages/ai/test/fetch-option.test.ts`: updated the fork's truncated-turn test for
  `automaticContinuation: false` to expect `stopReason === "length"` instead of `"error"`, matching
  `@google/genai` 2.32.0 and upstream `#12103`.
- `packages/chord/test/telemetry-ingest/sender.test.ts`: included the shared-work `chord.hold` root
  span in the fork's in-flight worker batch test, matching upstream's shared wire-hold telemetry.
- `packages/coding-agent/src/core/tools/read.ts`: removed the duplicate raw-stream `error` listener
  after auto-merge combined the fork's listener with upstream `#11956`.
- `packages/coding-agent/test/suite/model-unavailability.test.ts`: added `resolveAuth` to the mock
  `ModelRuntime` for upstream `#12071`'s per-credential unavailability key lookup.
- `scripts/install-fork.test.mjs`: updated the synthetic workspace fixture to place test packages in
  direct `source/packages/<dir>` subdirectories (`coding-agent`, `chord`, `ai`), matching the real
  monorepo layout required by upstream's `getPublicWorkspacePackages` (`2930f5220`).

## Verification

Local verification ran on Apple Silicon macOS (Node 24.22.3) before opening the pull request; full
Linux and macOS suites run in GitHub Actions on the PR:

- `npm ci --ignore-scripts`, `npm run hydrate:model-data`, `npm run build`, and
  `npm run build:daemon --workspace packages/env` succeeded.
- `npm run check`, `npm run check:released-changelogs` (against upstream `v1.5.2`), and
  `cd apps/p2 && npm run check` passed with zero diagnostics.
- Targeted offline suites through `./test.sh -- <command>` passed:
  - `scripts/{ci-scope,install-fork}.test.mjs` and the remaining `test:scripts` files (270 passed,
    1 platform-skipped)
  - `packages/ai` (`fetch-option`, `google-thinking-level`, `google-gemini-cli-claude-thinking`,
    `google-shared-gemini3-unsigned-tool-call`, `google-tool-call-missing-args`: 136 passed)
  - `packages/tui` (`source-selection`, `tui-alt-screen`: 124 passed)
  - `packages/env` (`process`, `remote`: 32 passed)
  - `packages/durable` (`harness-inspect`, `harness-lifecycle`, `harness-sleep`, `codemode`,
    `tools`: 118 passed, 1 skipped)
  - `packages/coding-agent` (`export-html-whitespace`, `model-resolver`, `read-streaming`,
    `session-manager/file-operations`, `suite/model-unavailability`, `suite/agent-session-mcp`,
    `suite/export-html-tool-cards`, `changelog`: 209 passed)
  - `apps/p2` (`plugin-layout`, `server-start`, `outbox`, `workspace-environment`, `web`: 19 passed,
    1 browser-skipped)
