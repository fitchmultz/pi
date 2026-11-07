# fitchmultz/pi — personal Pi fork

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi), rebuilt on upstream
v1.0.0 and synchronized through upstream main at
`085c84e98e7f4c950f2be606466fff4f75d8fe7c` (2026-11-07), following official v1.5.0.
It is upstream plus the features
below. Everything else follows upstream behavior and APIs.

The [2026-11-07 integration record](docs/upstream-sync-2026-11-07.md) documents the current baseline,
conflict decisions and verification. The [2026-11-05 integration record](docs/upstream-sync-2026-11-05.md) documents the previous baseline,
conflict decisions and verification. The [2026-11-04 integration record](docs/upstream-sync-2026-11-04.md)
records the previous integration. The [v1.5.0 integration record](docs/upstream-sync-1.5.0.md) records the preceding release integration. The
[2026-10-29 integration record](docs/upstream-sync-2026-10-29.md) records the previous
integration. The [v1.4.0 integration record](docs/upstream-sync-1.4.0.md)
records the previous release integration. The
[2026-10-21 consolidation record](docs/upstream-consolidation-2026-10-21.md)
records the previous native replacements, retained differences and consumer inspection. The [v1.3.0 integration record](docs/upstream-sync-1.3.0.md)
records the previous integration's callers, regressions and commands. The
[earlier 2026-10-15 integration record](docs/upstream-sync-2026-10-15.md) documents the
measured divergence, preserved callers, new regressions and verification commands.

## Fork features

Owners below are source paths under `packages/coding-agent/src/`, and tests are under
`packages/coding-agent/test/`, unless another package or repository path is given.
The tests identify each delta's behavioral owner; they are not claims of live provider or
all-platform qualification.

| Feature and reason retained | Owner | Primary tests | Docs |
| --- | --- | --- | --- |
| Managed restart: same-session replacement without replay, with readiness rollback, acknowledged readiness, intentional-exit IPC and extension `managedHost`/shutdown `disposition` for work that outlives a worker | `cli/{launcher,restart-protocol}.ts`, `extensions/restart/`, `cli-launcher.ts` | `restart-launcher.test.ts`, `restart-tui.test.ts`, `restart-guidance.test.ts` | [Restart](packages/coding-agent/docs/restart.md) |
| Detached `background_command`: durable jobs/logs and completion delivery | `extensions/background-command/`, worker asset in `config.ts` | `background-command-process.test.ts`, `suite/background-command-{session,guards}.test.ts`, `scripts/smoke-test-background-command-bundle.mjs` | [Background commands](packages/coding-agent/docs/background-command.md) |
| Opt-in `codemode` background scripts: a receipt at the tool call, one completion message with the run's nested record and usage, store writes deferred to delivery | `extensions/codemode/`, `core/{agent-session,nested-tool-calls}.ts`, `core/extensions/{types,runner}.ts`, `core/{usage-totals,compaction/utils}.ts`, `core/export-html/template.js`, `packages/codemode/src/source.ts` | `suite/agent-session-codemode-background.test.ts`, `suite/agent-session-codemode.test.ts`, `packages/codemode/test/source.test.ts`, `compaction-nested-calls.test.ts`, `scripts/smoke-test-codemode-background.mjs` | [Codemode](packages/coding-agent/docs/codemode.md#background-scripts) |
| `discover_tools`: initial capability summaries, full prior-turn instructions and stable positional declarations | `extensions/instruction-groups/`, native deferred-tool restore in `core/agent-session.ts`, narrow `refreshTools()` seam in `core/{agent-session,extensions/loader,extensions/types}.ts` | `suite/instruction-groups.test.ts`, `suite/prompt-cache-prefix.test.ts` | [Instruction groups](packages/coding-agent/docs/instruction-groups.md) |
| JSON `read`: selection before paging/truncation, inherited by native factory consumers | `core/tools/{read,read-json}.ts` | `read-json.test.ts` | [SDK](packages/coding-agent/docs/sdk.md#json-selection-with-read) |
| Compact activity: regroup native cards without replacing the whole TUI | `modes/interactive/{interactive-mode,components/activity}.ts`, card renderers, `core/settings-manager.ts` | `compact-view.test.ts`, `suite/regressions/compact-view.test.ts` | [Settings](packages/coding-agent/docs/settings.md) |
| Immutable fork update: exact source/catalog, frozen install, guarded selection and automatic pruning with active-runtime receipts | `config.ts`, `utils/{fork-update,fork-release-store}.ts`, `scripts/install-fork.mjs` | `fork-update.test.ts`, `scripts/{install-fork,fork-release-liveness}.test.mjs` | [Install and activate](#install-and-activate) |
| Termux: compiler/environment handling, short control-socket paths and OSC 52 clipboard fallback without Termux:API | `scripts/install-fork.mjs`, `test.sh`, `cli/restart-protocol.ts`, `utils/clipboard.ts` | `scripts/install-fork.test.mjs`, `restart-control.test.ts`, `clipboard.test.ts`; device activation is separate | [Termux](packages/coding-agent/docs/termux.md) |
| Complete working state: native admission, all branches/queues/mode buffers and completed-exit attestation; strict plain-JSON snapshots use Chord's checker with a container hook, so coding-agent keeps its `@earendil-works/chord` dependency after upstream dropped it | `core/{working-session,agent-session,sdk,agent-session-services}.ts`, `cli/working-session-control.ts`, native mode/builtin bindings, `packages/chord/src/json.ts` (`CheckJsonOptions`) | `suite/working-session.test.ts`, `suite/working-session-cli.test.ts`, `packages/chord/test/json.test.ts` | [Working sessions](packages/coding-agent/docs/working-session.md) |
| Credential isolation: routing providers must not read unrelated stored credentials | `core/model-runtime.ts`, provider registration types/adapter | `provider-credential-isolation.test.ts` | [Custom providers](packages/coding-agent/docs/custom-provider.md) |
| Auth fallback: ephemeral credentials without replacing native provider/catalog/transport | `core/{model-runtime,provider-composer}.ts`, `core/extensions/provider-registrations.ts` | `model-runtime-auth-options.test.ts` | [Auth fallback](packages/coding-agent/docs/custom-provider.md#supply-fallback-authentication-without-replacing-a-provider) |
| Hidden model overrides: `models.json` can only add or patch catalog models, so superseded built-ins cannot otherwise be dropped from `/model` and `--list-models` | `core/{model-config,provider-composer}.ts` | `model-registry.test.ts` | [Models](packages/coding-agent/docs/models.md) |
| Public model-reference resolution: extensions need native thinking-suffix and exact-ID selection without constructing a second model runtime | `index.ts` re-export of `core/model-resolver.ts` | `model-resolver.test.ts` through the public entrypoint | [SDK](packages/coding-agent/docs/sdk.md#resolve-a-model-reference-without-creating-a-runtime) |
| Opt-in slow diagnostics: native synchronous handlers and footer frames need dispatch attribution | `core/extensions/{runner,wrapper}.ts`; `PI_EXTENSION_PERFORMANCE=1` | `extensions-performance.test.ts` | [Extensions](packages/coding-agent/docs/extensions.md#opt-in-performance-warnings) |
| Temporary passive tracing: public hooks do not yet cover final serialization/consumed attempts | `packages/ai/src/utils/cache-trace.ts`, native adapter hooks, `core/cache-trace-context.ts`, `scripts/cache-trace-report.mjs` | `packages/ai/test/cache-trace.test.ts`, `sdk-stream-options.test.ts`, `scripts/cache-trace-report.test.mjs` | [Fidelity and retirement](packages/coding-agent/docs/cache-tracing.md) |
| Cloudflare catalogs: canonical Claude IDs, qualified Opus 5.5 positional controls/cache lifetimes, and direct-OpenAI positional defaults for `/openai` Responses models | `packages/ai/src/api/cloudflare.ts`, `packages/ai/catalog/providers/cloudflare-ai-gateway.ts`, `packages/ai/scripts/hydrate-model-catalog.ts` and `core/remote-catalog-provider.ts` | `packages/ai/test/{model-data-validation,cloudflare-openai-positional}.test.ts`, `remote-catalog-provider.test.ts`, `model-runtime-cloudflare-compat.test.ts`, `suite/prompt-cache-prefix.test.ts` | [Providers](packages/coding-agent/docs/providers.md), [Cache lifetimes](packages/coding-agent/docs/models.md#prompt-cache-lifetimes) |
| Path hyperlinks: prose paths and inline-code paths/URLs stay clickable after wrapping; terminals only regex-match one row and the source-transform seam cannot preserve literal codespan rendering | `packages/tui/src/components/markdown.ts` | `packages/tui/test/markdown.test.ts` | [Terminal setup](packages/coding-agent/docs/terminal-setup.md#override-detected-capabilities) |
| Source-aware fullscreen selection: highlighted copies retain Markdown and real line breaks without display padding or wraps; `/copy` stays unchanged | `packages/tui/src/{selection-source,selection-markers,utils,tui-alt-screen}.ts`, `packages/tui/src/components/{markdown,markdown-source,text}.ts` | `packages/tui/test/source-selection.test.ts` | [Copy part of a response](packages/coding-agent/docs/terminal-setup.md#copy-part-of-a-response) |

Complete working state also depends on the queue/admission APIs in
`packages/agent/src/agent.ts`, resource/settings capture, and bounded artifact I/O in
`utils/streaming-file.ts`; these are part of the retained capability, not redundant helpers.

### Retained correctness deltas

Ordinary quit does not wait for tools that ignore cancellation. Strict shutdown for certified
working-session exits waits for `session.abort()` before disconnecting persistence. This retains
the fork's nonblocking quit behavior rather than upstream's unconditional wait from #9124;
an ordinary quit can leave an interrupted tool call without its final result.

These fixes remain until upstream supplies equivalent behavior, not merely closes a report.
Private output-file creation (`wx` / `0o600`) now follows upstream `utils/output-files.ts` (adopted in the v1.1.0 sync); the fork keeps `private-spill.test.ts` as a regression guard.
Malformed Env frames now follow upstream's guarded decoder; the fork keeps `packages/env/test/connection.test.ts` as a subprocess regression guard. The SSH login-shell fixture now follows upstream's sh/Bash/zsh startup coverage.
Literal and modified `+` key bindings now use upstream's modifier parser; the fork's regression cases remain.
Managed npm extension installs now use upstream's `--no-audit --no-fund` flags, so the fork-only audit suppression is retired.
The main shell helper now uses upstream's macOS process-group pause before killing; the fork's extra Linux pause is retired there. Other environment helpers retain their listed adaptations; upstream removed the sandbox example together with its adaptation.
An oversized Env watch change now reports `overflow` through upstream's frame-limit check ([#10516](https://github.com/earendil-works/pi/issues/10516)), so the fork's daemon change is retired; `packages/env/test/remote.test.ts` keeps the regression.
Chord v2 data, frames and tool arguments validate with upstream's pi-schema, compiled once per schema. Chord's transport and validation tests follow the v2 runtime.
Durable's retained-context scheduling now follows upstream's idle scopes and wake handling; the fork's scheduler change and its two `harness-context.test.ts` cases are retired.
HTML export now uses upstream's iterative tree traversal, replacing the fork's `activeFirst` traversal. The long-tree regression remains.
Empty quoted prompt-template arguments now follow upstream's token parser and positional-default regression coverage ([#10867](https://github.com/earendil-works/pi/issues/10867)); the equivalent fork implementation and tests are retired.
Transcript resume uses upstream's branch-wide recorded active-tool loadout, activates eligible never-mentioned extension tools, and applies `--tools +name/-name` modifiers ([#10785](https://github.com/earendil-works/pi/issues/10785), [#11062](https://github.com/earendil-works/pi/issues/11062)). The fork counts historical instruction-group deferrals as mentioned, so internal deferral does not make a tool newly registered. Other selections follow upstream's recorded additions and removals, without a separate selection protocol or legacy-session policy. The fork reconciles temporarily deferred discovery tools when discovery is disabled or absent; explicit selections, exclusions and later deselection remain authoritative across subsequent resumes. Native complete working-session restore retains its exact saved current loadout and modifier policy.
Claude 5.5 catalog entries now use upstream's models.dev metadata rather than the removed fallback definitions.
OpenCode Go's Google adapter and inference endpoints now follow upstream; `packages/ai/test/opencode-provider-headers.test.ts` retains the Gemini routing regression guard.
Chord's host, reference admission and link lifecycle follow upstream v2. The active extensions inspected for this integration do not import Chord. Coding-agent uses its `/json` helpers, while Durable uses its explicit foundation entry points and v2 store.
See the [AI](packages/ai/CHANGELOG.md#unreleased), [agent](packages/coding-agent/CHANGELOG.md#unreleased),
[Codemode](packages/codemode/CHANGELOG.md) and [TUI](packages/tui/CHANGELOG.md#unreleased) changelogs for user-facing details.

| Reason retained | Owner | Primary tests |
| --- | --- | --- |
| Render requests cannot outlive their callbacks across stop/start; stopping drops the owed frame and starting requests a new one. A main-screen stop moves the cursor below the frame, so the first frame after a restart redraws the screen instead of diffing against it | `packages/tui/src/{tui,tui-main-screen}.ts` | `packages/tui/test/tui-render.test.ts` |
| MCP initialization rejects a connection closed while its final notification is sent; closed stays final and close listeners run once | `packages/mcp/src/client.ts` | `packages/mcp/test/client.test.ts` |
| Command output must drain after process exit without counting link backpressure as silence | `packages/env/daemon/src/{exec,output,process,pty}.rs` | `packages/env/test/{process,terminal,conformance,remote}.test.ts` |
| WebSocket errors close their Chord link or HTTP scope while `ws` completes its close handshake, delivering code 1009 for oversized frames | `packages/chord/src/node/http/upgrades.ts`, `apps/p2/src/hosts/socket-limits.ts` | `packages/chord/test/node/http/upgrades.test.ts`, `apps/p2/test/p2/socket-limits.test.ts` |
| A worker whose `ready` crosses its stop must stay `stopping` in `workers.state`; upstream shows it `running` again until it exits, which the rollout step and the app kit's `exportData` read | `packages/chord/src/node/workers/workers.ts` | `packages/chord/test/node/workers/workers.test.ts` |
| Legacy published Kimi Coding catalogs must not break offline builds or revert the native OpenAI protocol on fetched/cached overlays; preserve effort/tool constraints and K3 cache-write pricing | `packages/ai/src/api/kimi.ts`, `packages/ai/catalog/{families/kimi,providers/kimi-coding,providers/moonshotai}.ts`, `packages/ai/scripts/hydrate-model-catalog.ts`, `core/remote-catalog-provider.ts` | `packages/ai/test/model-data-validation.test.ts`, `remote-catalog-provider.test.ts` |
| Git footers must catch branch changes missed while native watchers and polling baselines start | `core/footer-data-provider.ts` | `footer-data-provider.test.ts` |
| Cache warming must schedule prepared native retention and estimate one-hour writes and prompt-length price tiers without claiming provider-wrapper rates | `core/{cache-warmer,model-runtime,sdk}.ts`, `modes/interactive/interactive-mode.ts` | `cache-warmer.test.ts` |
| Standalone extension dependencies need runtime package manifests for public entrypoints and transitive imports | `scripts/build-binaries.sh`, `packages/coding-agent/package.json` (`build:binary`) | `compiled-extension-packages.test.ts` (built Bun CLI) |
| Oversized public Durable input/write admissions must not fail the Session; host commits can opt into assembled-batch checks including document revisions. Queued input entry-size refusal settles only that input and preserves answers, tool work and valid siblings. SQLite checks exact rows with confirmed rollback, not an aggregate queue cap; post-effect compactions and real commit failures keep their fatal-storage semantics. Upstream's group commit fails the Session on any refused batch, so the check runs before a commit joins the writer's group, once every admitted write is published; the Session's storage cache and gated storage forward it | `packages/durable/src/{storage/sqlite/storage,session/session,session/cached-storage,session/keys,session/transaction,harness/harness,harness/inbox,harness/submissions,harness/compaction}.ts` | `packages/durable/test-workers/{input-admission,commit-admission,storage}.test.ts`, `packages/durable/test/harness-storage-failure.test.ts` |
| Cancelling a shell on macOS must not wake waiting ancestors into later steps; freeze its process group before killing it | `packages/durable/src/env/node.ts`, `packages/env/daemon/src/sys/unix.rs` | `background-command.test.ts`, `suite/background-command-guards.test.ts`, shared `packages/durable/src/testing/env-conformance.ts` |
| File forks must migrate legacy entries before replacing the source header, preserving indexed history and model context | `core/session-manager.ts` | `session-manager/fork-migration.test.ts` |
| After a failed journal write, including the first write that creates the file, the next append or save must rewrite the journal from accepted memory so reopened history keeps its ancestry without duplicate or partial records. Appends never adopt a file another writer created at a new journal's path, a file rejected by `setSessionFile()` never receives the current session's entries, and a new session starts without the old failure ([#257](https://github.com/fitchmultz/pi/issues/257)) | `core/session-manager.ts` | `session-manager/file-operations.test.ts`, `suite/regressions/257-journal-write-failure.test.ts` |
| Atomic private rewrites, canonical credential locks and preservation of unrelated settings | `utils/atomic-file.ts`, `core/{auth-storage,settings-manager,session-manager}.ts` | `file-safety.test.ts` |
| HTML export must not replace the journal through any alias | `core/export-html/index.ts` | `file-safety.test.ts` |
| Edits must preserve UTF-8 and untouched original text/boundaries. Upstream's line-ending splicing and bounded diff windows run in the shared owner; fuzzy matching keeps the fork's exact original spans | Shared policy in `packages/durable/src/tools/edit-diff.ts`; byte I/O in `packages/durable/src/tools/edit.ts`, `core/tools/{edit,edit-diff}.ts`, `utils/text.ts` | `packages/durable/test/tools.test.ts`, `edit-byte-safety.test.ts`, `edit-diff-window.test.ts`, `edit-tool-diff-before-write.test.ts` |
| One auth-check failure must not hide healthy providers or replace saved/scoped selections | `packages/ai/src/models.ts`, `core/{model-runtime,model-resolver,sdk}.ts` | `packages/ai/test/models-runtime.test.ts`, `model-runtime-auth-options.test.ts`, `model-resolver.test.ts`, `agent-session-dynamic-provider.test.ts` |
| Refresh admission must precede config I/O: awaited scopes follow current per-provider catalog/auth readiness, global availability reads cannot discard credential synchronization or make it join unrelated work, and full-pass auth failures retain provider-local diagnostics and sibling credential filters under scoped overlap. Scoped snapshot updates read only their own catalogs, so a refresh stays linear in the number of providers | `core/model-runtime.ts` | `model-runtime-refresh-order.test.ts`, `agent-session-dynamic-provider.test.ts`, `model-runtime-credential-sync.test.ts` |
| OAuth state, cancellation and UI failures must retain listener/prompt cleanup | `packages/ai/src/auth/oauth/{callback-server,openai-chatgpt}.ts` | `packages/ai/test/{oauth-callback-server,openai-chatgpt-oauth}.test.ts` |
| Retained payload objects must not mutate Codex continuation baselines | `packages/ai/src/api/openai-codex-responses.ts` | `packages/ai/test/openai-codex-stream.test.ts` |
| Mistral's header deadline must stop after headers with or without a caller signal; caller cancellation must still stop SSE and held-open HTTP-error bodies ([#10609](https://github.com/earendil-works/pi/issues/10609)) | `packages/ai/src/api/mistral-conversations.ts` | `packages/ai/test/mistral-http-transport.test.ts` |
| Failed terminal responses must preserve consumed numeric usage and error details | `packages/ai/src/api/{openai-responses-shared,openai-codex-responses}.ts` | `packages/ai/test/{openai-responses-terminal-event,openai-codex-stream}.test.ts` |
| Low-level `agentLoop()` and `agentLoopContinue()` streams must end when their run throws, for example from `prepareRequest`: an error assistant message (`aborted` after cancellation), `turn_end`, then `agent_end` carrying the messages accepted before the failure and that message. Upstream's adapters settle only a successful run, so iteration and `result()` stay pending and the rejection is unhandled | `packages/agent/src/agent-loop.ts` | `packages/agent/test/agent-loop.test.ts` |
| Astra Ultrafast and legacy Codex Fast estimates need correct tier/confirmation rules | `packages/ai/src/api/{openai-responses,openai-codex-responses}.ts` | `packages/ai/test/openai-ultrafast-pricing.test.ts` |
| Anthropic strict limits apply across initial and inline definitions, including required schemas. Upstream's one-time fallback after a rejected request stays for limits a count cannot predict, such as compiled grammar size; alone it would spend a rejected request on every over-limit turn and drop strict mode for all preferred tools | `packages/ai/src/api/anthropic-messages.ts` | `packages/ai/test/anthropic-strict-tool-{schema,fallback}.test.ts` |
| Optional nulls inside schema unions must not be coerced into fabricated values. Upstream's pi-schema drops optional nulls only through properties and items; inside an `anyOf`/`oneOf` branch its conversion pass turns them into values (`"null"` for a string) | `packages/schema/src/coerce.ts` (pass 1) | `packages/ai/test/validation.test.ts`, `packages/schema/test/coerce.test.ts` |
| DNS root dots must not bypass `NO_PROXY` | `packages/ai/src/utils/node-http-proxy.ts` | `packages/ai/test/node-http-proxy.test.ts` |
| Fractional/overflowed zero retry delays must not become a minute; retry cancellation keeps its normalized assistant-result shape. Timer cancellation/listener cleanup now reuse native `utils/sleep.ts` rather than a private retry timer ([#10506](https://github.com/earendil-works/pi/issues/10506)) | `packages/ai/src/utils/retry.ts` | `packages/ai/test/retry.test.ts` |
| Radius gateway pricing must have finite rates and tiers before cost estimation ([#10507](https://github.com/earendil-works/pi/issues/10507)) | `packages/ai/src/providers/radius-config.ts` | `packages/ai/test/radius-provider.test.ts` |
| Abort tests must check the terminal result and follow-up rather than pass early ([#10508](https://github.com/earendil-works/pi/issues/10508)); this is test-only, not a provider cancellation fix | `packages/ai/test/abort.test.ts` | Offline faux-provider case in the same file |
| The subagent cancellation test waits for partial output before aborting, so the child's SIGTERM handler is ready, and verifies that escalation ends it with SIGKILL | `packages/coding-agent/test/{subagent-extension.test.ts,fixtures/subagent-child.mjs}` | `packages/coding-agent/test/subagent-extension.test.ts` |
| Codemode string store keys must round-trip as own data properties, including `__proto__`, on every sandbox backend ([#10510](https://github.com/earendil-works/pi/issues/10510)) | `packages/codemode/src/runtime/execution.ts` | `packages/codemode/test/sandbox.test.ts` |
| Equivalent known-hosts path spellings must serialize accept/forget rewrites ([#10517](https://github.com/earendil-works/pi/issues/10517)) | `packages/env/src/ssh.ts`, `packages/env/test/ssh.test.ts` | `packages/env/test/ssh.test.ts` |
| Replayed signatures count toward context estimates | `packages/ai/src/utils/estimate.ts` | `packages/ai/test/context-estimate.test.ts` |
| Model-switch output limits must use target-model usage and native replay, not charge reasoning dropped from the request | `packages/ai/src/{utils/estimate,utils/transform-messages,api/simple-options}.ts`; the existing public `api/transform-messages` entry re-exports the shared implementation | `packages/ai/test/context-estimate.test.ts` |
| Retry omissions after a valid usage anchor must not re-estimate its unchanged prefix ([#10287](https://github.com/earendil-works/pi/issues/10287), [#10068](https://github.com/earendil-works/pi/issues/10068)); compaction must count replayed reasoning signatures (estimate portion of [#9409](https://github.com/earendil-works/pi/issues/9409)), while text summaries budget only serialized content | `core/compaction/{compaction,branch-summarization}.ts`, `core/bug-report.ts` | `session-context-edit.test.ts`, `branch-summarization.test.ts`, `suite/agent-session-context-usage.test.ts` |
| Dialog input needs xterm printable decoding, grapheme-safe replacement and correct mouse columns | `packages/tui/src/components/input.ts` | `packages/tui/test/{input,mouse-components}.test.ts` |
| Hyperlink control payloads must stay byte-identical | `packages/tui/src/utils.ts` | `packages/tui/test/truncate-to-width.test.ts` |
| Very long newline-free Markdown, such as a 20M-unit saved user message, must render instead of overflowing the native regex stack in Marked's Setext-heading rule; Setext matching is skipped only when no newline exists | `packages/tui/src/components/markdown.ts` | `packages/tui/test/markdown.test.ts` |
| Terminal cell-size replies must reach native housekeeping before extension input listeners | `packages/tui/src/tui.ts` | `packages/tui/test/tui-cell-size-input.test.ts` |
| A failed autocomplete lookup, including a rejection with the abort reason after a newer request supersedes it, must not block later requests or escape as an unhandled rejection, which exits Pi | `packages/tui/src/components/editor.ts` | `packages/tui/test/editor.test.ts` |
| Image coordinate notes need independent unrounded axis ratios | `utils/image-resize.ts` | `image-dimension-note.test.ts` |
| Branch budgets must exclude system declarations not serialized as conversation | `core/compaction/branch-summarization.ts` | `branch-summarization.test.ts` |
| Cache overlap estimates must follow native ancestry, identify expected model/provider transitions and distinguish current, prior observed, catalog and unknown read prices without changing real usage totals | `core/cache-stats.ts`, `modes/interactive/interactive-mode.ts` | `cache-stats.test.ts`, `interactive-mode-assistant-diagnostics.test.ts`, `suite/prompt-cache-prefix.test.ts` |
| Piped input needs separators; whitespace-only input must not start a turn | `cli/initial-message.ts`, `main.ts` | `initial-message.test.ts` |
| Reload must preserve deselected default-active tools while adopting newly configured defaults, including saved `--tools +name/-name` modifiers | `core/agent-session.ts` | `default-tools-setting.test.ts` |
| Custom UI must dispose components completed during factory initialization and capture drafts at mount rather than factory entry. Native inline-dialog draft restoration remains observable through public `setEditorText()` and is retained, not replaced by stack visibility/focus ownership | `modes/interactive/interactive-mode.ts` | `interactive-mode-status.test.ts`, `suite/working-session-dialogs.test.ts` |
| Extension cancellation must remain observable through run setup, post-run recovery and pre-settlement, without replacing the active loop's signal or exposing an idle signal; upstream's `agent_settled.aborted` is captured before clearing that signal | `core/{agent-session,extensions/types}.ts` | `suite/background-command-session.test.ts`, `suite/agent-session-boundaries.test.ts` |
| A prompt whose input hooks or auth check overlap another prompt's run start must queue into that run by its `streamingBehavior` or be rejected, not start a second run that drops the prompt and releases the first run's activity while it streams | `core/agent-session.ts` | `suite/agent-session-prompt.test.ts` |
| Repeated context-usage reads must reuse the last scalar without rescanning archived ancestry; native leaf identity and effective model limits preserve compaction, edits, branches and reload/restore behavior | `core/agent-session.ts` | `suite/agent-session-context-usage.test.ts` |
| Session hot paths incrementally retain active ancestry, compaction-aware raw context entries and model/thinking settings; projected messages and returned arrays remain fresh. Entry-list and leaf identity invalidate reuse on reload or navigation. The latest name stays indexed; branch-summary admission stays linear, file forks reuse a private exclusive descriptor, and custom-flat listings reject unrelated cwd headers before reading bodies | `core/session-manager.ts`, `core/compaction/branch-summarization.ts` | `session-manager/*.test.ts`, `session-context-edit.test.ts`, `branch-summarization.test.ts`, `file-safety.test.ts` |
| Empty-draft boundary previews use the live manager and compute projection/LLM fields only when read; pending-queue readers never project history. Each handler retains its own preview for freshness. Canonical context still refreshes after every boundary because public Agent state allows in-place mutation; committed drafts refresh before entry notifications. Mutable nonempty drafts still need eager validation. The undocumented `emitBoundary` preview builder remains synchronous | `core/extensions/runner.ts`, `core/agent-session.ts` | `extensions-runner.test.ts`, `suite/agent-session-boundaries.test.ts` |

### Internal state ownership

These owner-authorized refactors remove overlapping state representations without changing
supported behavior. Preserve their ownership guarantees when integrating equivalent upstream code.

| Ownership guarantee | Owner | Primary tests |
| --- | --- | --- |
| One waiting/completing/settled phase owns OAuth callback admission and settlement; manual cancellation leaves an active exchange alone | `packages/ai/src/auth/oauth/callback-server.ts` | `packages/ai/test/oauth-callback-server.test.ts` |
| Keyboard mode uses one mutually exclusive state; the outstanding Kitty stack push remains a separate cleanup obligation | `packages/tui/src/terminal.ts` | `packages/tui/test/terminal.test.ts` |
| Internal paste state uses one optional content buffer and one completion path, preserving split markers and input ordering | `packages/tui/src/stdin-buffer.ts` | `packages/tui/test/stdin-buffer.test.ts` |
| Durable codemode keeps unlaunched calls in one held/released queue. Release checks precede launch, and each call still waits for its issued count to commit | `packages/durable/src/codemode/codemode.ts` | `packages/durable/test/{codemode,codemode-checkpoints}.test.ts` |
| Durable writer parts distinguish stored writes from memory-only holds. Only stored parts carry writes and publish with a durable sequence number | `packages/durable/src/session/{writer,session}.ts` | `packages/durable/test/{session-group-commit,session-deferred-commits,session-adoption,harness-storage-failure}.test.ts` |
| Each open Anthropic content block owns its emitted block and content index. Only a tool-call owner carries an argument parser, which stays off emitted messages | `packages/ai/src/api/anthropic-messages.ts` | `packages/ai/test/{anthropic-sse-parsing,streaming-tool-arguments,anthropic-message-threads}.test.ts` |
| Photon loading keeps the completed module in its cached promise rather than a second module field | `utils/photon.ts` | `image-processing.test.ts` |

### Performance deltas

These paths remove repeated work or bound allocation while preserving their existing contracts.
Keep them visible during upstream syncs; retire each change when upstream covers the same behavior.
Workloads, measurements and limits are in [Performance reproduction](docs/performance.md).

| Retained work reduction | Owner | Primary tests |
| --- | --- | --- |
| Scan each decoded journal chunk once and join complete lines only at record boundaries when opening sessions | `packages/coding-agent/src/core/session-manager.ts` | `packages/coding-agent/test/session-manager/file-operations.test.ts`; [synthetic opening measurements](docs/performance/session-open-2026-10-24.md) |
| Resolve `--session` and `--fork` ID prefixes, cross-project IDs and misses without parsing non-matching journals past their headers; matching sessions are still read in full because activity time orders ambiguous matches. Full `list()`/`listAll()` listings are unchanged and uncached. Upstream still builds complete metadata for every saved session | `core/session-manager.ts` (`listProjectSessions`, `listAllSessions`), `main.ts` | `session-arg-resolution.test.ts` |
| Lossless upload compression on qualified Anthropic Messages and public OpenAI Responses endpoints; existing Codex zstd stays canonical-endpoint-only. See [support boundaries and measurement](docs/compression.md) | `packages/ai/src/utils/request-compression.ts`, `packages/ai/src/api/{anthropic-messages,openai-responses,openai-codex-responses}.ts` | `packages/ai/test/{anthropic-request-compression,openai-request-compression,openai-codex-stream}.test.ts` |
| Normalize tool declarations once per comparison, index model overlays per read, repair JSON by spans, and drain Codex events without repeated array shifts | `packages/agent/src/agent-loop.ts`, `packages/ai/src/{utils/transcript,utils/json-parse,models,api/openai-codex-responses}.ts` | `packages/agent/test/agent.test.ts`, `packages/ai/test/{system-message-replay,json-parse,model-types,openai-codex-websocket-queue}.test.ts` |
| Stream long-token wrapping, use native grapheme endpoints, reuse only the current editor layout after comparing text, width and paste membership, and reuse unchanged same-index rows in unstyled Boxes after child changes | `packages/tui/src/{utils,components/editor,components/input,components/box}.ts` | `packages/tui/test/{wrap-ansi,editor,input,layout,mouse-components}.test.ts` |
| Keep the rendered lines of assistant Markdown blocks a stream has not changed, avoid rendering assistants to query emptiness in compact/hybrid grouping, reject plain prose before Mermaid lexing, and compute visible tree ancestry in one pass. Upstream reuses the blocks but re-runs every Markdown transformer on each streamed update; skipping unchanged blocks made streamed updates 2.7-3.6 times faster with a long thinking block ([v1.5.0 record](docs/upstream-sync-1.5.0.md)) | `modes/interactive/components/{activity,assistant-message,mermaid,tree-selector}.ts` | `{compact-view,assistant-message,mermaid,tree-selector}.test.ts` |
| Normalize edit text once and scan only requested head-truncation ranges | `packages/durable/src/tools/edit-diff.ts`, `core/tools/truncate.ts` | `packages/durable/test/tools.test.ts`, `edit-byte-safety.test.ts`, `tools.test.ts` |
| Compare PNG with the requested-quality JPEG as upstream does, then encode fallback qualities only until one fits | `utils/image-resize-core.ts` | `image-processing.test.ts` |
| Bound native Bash spill queues and wait for complete private files; push-only custom producers retain their existing callback contract | `core/{bash-executor,tools/bash,tools/output-accumulator}.ts`, `utils/{output-files,child-process}.ts` | `bash-spill.test.ts`, `private-spill.test.ts`, `streaming-file.test.ts` |
| Skip disk reads only for acknowledged, confirmed-terminal background jobs during monitoring; explicit tools remain fresh | `extensions/background-command/{index,jobs}.ts` | `suite/background-command-session.test.ts`, `background-command-process.test.ts` |
| Accumulate SSE lines without repeatedly copying long partial lines; stdio framing and byte-bounded HTTP errors use upstream's shared implementations | `packages/mcp/src/transports/{lines,stdio,streamable-http}.ts` | `packages/mcp/test/{lines,stdio,streamable-http}.test.ts` |
| Binary-search historical revisions, write no SQLite record-ID claim that storage already holds, and join long lines at their boundary | `packages/durable/src/{storage/memory,storage/sqlite/commit,env/node}.ts` | `packages/durable/test/{memory-storage,sqlite-storage,sqlite-commit,env-node}.test.ts` |
| Count decoded lengths with scratch storage, reuse frame payload allocation without retaining large metadata, bound read-ahead, and precompute directory sort keys | `packages/env/daemon/src/{decode,scan,frame}.rs`, `packages/env/src/remote-env.ts` | Native daemon tests, `packages/env/test/{connection,remote,differential}.test.ts` |
| Append native eval journals and validate reports once | `packages/evals/src/{cli,report}.ts` | `packages/evals/test/{cli,report}.test.ts` |
| Build ready workspaces two at a time, batch selected npm packs, avoid unused native-path Biome WASM loading, and retain every startup worker profile | `scripts/{build,package-artifacts,pack-nix-packages,biome-check,profile-coding-agent-node}.mjs`, `nix/package.nix` | `scripts/{workspace-build,package-artifacts,package-artifact-cli,profile-coding-agent-node}.test.mjs` |

Upstream's rewritten in-memory telemetry adapter copies only incoming attribute values, so the
fork's retained-array optimization and its changelog entry are retired. Telemetry's root export
now supplies upstream's `source` condition, so the fork-only export correction is also retired.
Upstream's streaming `read` keeps only the shown lines of a text file in memory, so the fork's
whole-file read range scan is retired; JSON selections still read the whole file. Upstream's
batched SQLite commit keeps checked records in memory, retiring the fork's record reuse, but it
re-claimed stored record IDs on every update, so the fork keeps that filter. The
[2026-11-05 record](docs/upstream-sync-2026-11-05.md#performance) has the measurements.

The fork also keeps its own delivery tooling: `scripts/install-fork.mjs`, the isolated `./test.sh`,
fork policy text in `AGENTS.md`/`CONTRIBUTING.md`, a macOS CI job for restart and
`background_command`, and no upstream publishing, binary (including Android APK) or
issue-analysis workflows. Upstream's `scripts/preview-packages.mjs` is kept but unused;
the preview script's tests still run. Nix builds
retain upstream's derivation and locks with the batched install-phase packing above; automatic
catalog-pin commits and stable-branch promotion are upstream-only. The
Nix install check now follows upstream's removal of esbuild from the installer dependencies. Env's upstream platform check accepts the
darwin-x64 daemon under native arm64 Node with Rosetta, so CI no longer forces x64 Node. Upstream
also supplies foreground-job polling, the large-listing timeout, and Chord's private short-path lock
fallback for deep temporary directories. The fork retains Windows teardown retries and enough time
to delete the large listing and watch trees.
Contributor approvals remain fork-local; upstream approval-list additions and maintainer-specific
label assignment/reopening rules are not imported.
The fork uses upstream's install lock, not the removed npm shrinkwrap, and keeps its immutable
installer. Direct registry dependencies, including internal packages and the retained coding-agent
Chord dependency, use upstream's exact-version policy. It uses upstream's pre-commit hook and
`npm run check`. Delivery evidence comes from
`./test.sh`, installer/consumer tests, bundle smoke, and Linux/macOS CI; it does not establish live
Windows or Termux-device acceptance.

Configuration schemas, shared settings defaults, strict theme validation, and native fake-cursor
markers follow upstream. `SettingsSchema` also describes the fork's `compactView` boolean or
`"hybrid"` preference; settings keep upstream's allowance for extension-owned keys. Hardware
cursor mode draws only the focused terminal cursor, while unfocused fake cursors remain visible.
The generated schemas are under `packages/coding-agent/schemas/` and use upstream's
`https://pi.dev/schemas/*.schema.json` IDs. They match the hosted files except for the fork's
`compactView` setting, which the hosted settings schema accepts as an extra key, and
`modelOverrides.hidden` in `models.schema.json` and `docs/models-configuration.md`.

Package production uses the maintained `scripts/package-artifacts.mjs` and local consumer helpers,
including npm 12's expected-package-keyed pack metadata. Selected workspaces pack in one npm process;
Nix retains its ten raw named archives. Upstream's derivation has no source override for pi-schema,
which its install lock lists without an integrity hash, so its Nix build fails to evaluate; the fork
packs pi-schema and overrides it. Pinned fleet automation has migrated to the artifact API,
and the obsolete `scripts/coding-agent-consumer.mjs` shim has been removed.
Retained offline comparison fixtures are documented in [Performance reproduction](docs/performance.md).

Chord v2 is the root package and supplies the host, links, store, plugins and app kit.
The fork keeps `CheckJsonOptions` and its container hook in `@earendil-works/chord/json`
for native working-session validation. Coding-agent imports JSON helpers from `/json`,
not the host runtime. Durable imports context, draft and JSON types from `/context`,
`/delta` and `/json`, and uses the v2 store at the root. Shared output and SQLite APIs
remain at `/output` and `/sqlite`, including Node and Cloudflare drivers. No Chord v1
host or transport implementation remains.

Tool arguments validate with upstream's pi-schema, which replaces TypeBox validation. Built-in
coding-agent tools keep their TypeBox schemas, as upstream's do; pi-schema checks them as plain JSON
Schema. pi-ai's package no longer exports `Type`, `Static` or `TSchema`; the extension loader still
resolves `typebox` and pi-ai's former TypeBox exports for extensions. Durable commits
use upstream's group commit and batched `Storage.commit` statements; the fork's admission check
and stored-claim filter run on that path.

System One classifier images follow upstream's TypeSafe assets, Cloudflare images/assets
and OpenRouter state-image serialization, including native limits and opt-in headers.
Grep uses upstream's `rg --no-config` and ripgrep-provided context lines, with no matched-file reread. Truncated-response recovery uses upstream's
projected-context scan to omit the failed assistant and its matching tool results together.
These are release integrations, not additional fork mechanisms.

Grep globs follow upstream's search-path-relative matching. Edit execution and preview use upstream's
bounded diff windows, computed before writing. Original line endings are spliced back only at
matched ranges, with the fork's exact fuzzy-boundary mapping retained in the shared Durable owner.
Kitty fullscreen images draw after all covered text rows on every terminal. These upstream fixes
do not replace the fork's UTF-8 validation, compact Bash rendering, or source-aware selection.

Model references follow upstream's shared provider-selection policy, including gateway IDs,
thinking suffixes, authenticated-provider tie breaking and explicit-key ambiguity. The fork retains
saved/scoped selections when a provider's auth check fails. Codemode follows upstream's prompt
cancellation and FIFO worker admission (two live workers by default, configurable through
`PI_CODEMODE_MAX_WORKERS`). Foreground and background scripts share that queue; a
background receipt does not wait for admission. The fork retains safe arbitrary store keys,
exactly-once deferred completion/usage, cancellation and working-session save barriers.
Concurrent extension dialogs use upstream's stack for visibility and focus. Upstream also
retains custom-dialog draft restoration; the fork keeps it with capture at mount rather than
factory entry. Removing it changes supported `ctx.ui.setEditorText()` behavior while a dialog
is open, so the attempted removal is withdrawn. Factory admission and late-component disposal
after early completion remain; native-boundary tests cover these retained adaptations.

Client identity and attribution now follow pi-ai's native `ClientIdentity` and
`withClientIdentity`, including the mutable wrapper's fork `getAvailability()` diagnostics.
This is an upstream API migration, not retirement of a fork-only attribution engine.
Headers returned by `before_provider_headers` retain object identity through custom-provider
dispatch (required by Cursor); cache-trace provenance and prepared-retention warming remain.
Google adapters apply identity during client/header setup while sharing the existing stream engine.
Upstream's unused SQLite replication scaffold is removed; Durable's IndexedDB storage is additive,
not a replacement for the fork's memory/SQLite storage or scheduler semantics.

Streamed tool-call arguments now follow upstream's incremental `StreamingJsonParser` and
`ToolCallArgumentsStream`. Providers keep scratch state off emitted content blocks. Final arguments
still use the fork's span-based repair and existing fallback order, including native invalid `\u` repair. Anthropic requests use upstream message threads where supported;
cache warming sets `disableContinuation` and retains the fork's prepared-auth timing and trace hooks. Anthropic and
Bedrock Claude error-result images follow all tool results of the turn; error text and successful
result images retain their native placement.
These behaviors have offline parser/payload regression coverage, not a live provider qualification.
`/share` supports an explicit gist or Radius destination; its default `auto` selection is unchanged.

Anthropic native tool changes follow upstream's inline definitions and fixed initial tool list,
including same-name redefinitions. The fork retains request-wide strict-schema budgets and passive
cache tracing. Cross-model thinking removal and custom-overlay ownership follow upstream 1.3.0.
The pure replay implementation is shared with target-aware output budgeting under `utils/`;
the existing public API path remains available and entry-graph restrictions are unchanged.
Catalog release validation follows upstream, with the fork's existing npm pack metadata
validator reused for both npm array and package-keyed output.
ChatGPT OAuth follows upstream's mandatory callback listener and port-conflict
failure while keeping the fork's cancellation, state validation and cleanup safeguards. Cloudflare
Claude-ID generation already produces canonical IDs upstream. The shared helper also canonicalizes
provider inputs, remote overlays and pinned catalog hydration. For canonical Cloudflare Opus 5.5 it
restores positional system/tool/effort controls and defaults absent cache metadata to five-minute
and one-hour lifetimes. Cloudflare `/openai` Responses entries for the GPT models whose direct
OpenAI entries accept mid-conversation developer messages or `additional_tools` get the corresponding
flags too. The published catalog lists only OpenCode and Copilot as Responses proxies, so these
defaults preserve Cloudflare's cached prefix after supported system updates and tool additions.
GPT-5.5 and older now follow upstream's top-level tool declarations after its replay-namespace fix
([#11415](https://github.com/earendil-works/pi/issues/11415)); GPT-6.1 Terra gets both defaults.
A parity test keeps both lists aligned with `catalog/families/openai.ts`. Explicit compatibility flags and whole cache metadata objects are preserved;
catalog entries with a non-canonical `baseUrl` do not receive these defaults.

Program status and prompt-length pricing tiers follow upstream 1.1.0. Kimi K3, including Kimi Coding's `k3-256k`, keeps
the published $3/M five-minute cache-write rate across canonical Kimi Coding and
Moonshot OpenAI entries and Kimi Coding's implied estimate
([pricing](https://platform.kimi.ai/docs/pricing/chat)). Kimi Coding's shared
metadata helper also migrates canonical legacy Anthropic catalog entries and restores
omitted K3 cache-write rates during offline hydration and fetched/cached runtime
merges. Custom endpoints and other providers are unchanged. Claude 5.5 pricing now follows
models.dev metadata, including Sonnet 5.5's $0.10/M cache-read rate.

Cache investigation keeps persistent restart guidance in its existing `context_with_system`
owner, not the per-run `before_agent_start` hook. Forced text stays run-scoped and unpersisted. Child
finalization recovery remains a conditional source risk: managed saved-session attempts create
new contracts, and no reachable unchanged-contract reset was reproduced. Do not restore an old
phase for a new contract or apply a speculative recovery patch. Passive tracing records unknown
coverage explicitly; remove it when the investigation ends.

## Conventions

- Add fork features as builtin extensions in `packages/coding-agent/src/extensions/<name>/`,
  registered in `src/extensions/index.ts`, using public extension APIs.
- Patch core only when no public seam exists. Keep the patch small and list it in the table above.
- Default to upstream architecture. Do not re-add a dropped feature without the owner's approval.
- Behavior covered by upstream replaces the fork version; delete the fork path.

The fork carries the coordinated provider/schema refresh proposed in upstream issue
[#10909](https://github.com/earendil-works/pi/issues/10909), plus reviewed same-major
runtime updates for YAML 2.9.1, Chalk 6.0.1, Ignore 7.0.12, Undici 8.12.3 and
get-east-asian-width 1.7.0 and the fork's streaming-file dependencies stream-chain 4.2.6
and stream-json 3.7.0.
Root and generated installer locks stay together.
Google GenAI automatic continuation is disabled so Pi still owns retries and cancellation.
Generative AI and Vertex share stream processing and request construction in
`packages/ai/src/api/google-shared.ts`; their adapters retain authentication, client setup,
API identity and provider-specific thinking budgets.
Return these changes to upstream when it includes equivalent behavior. Marked 18.1.1
is deferred: its numeric entity decoding turns `&#27;[2J` into an active terminal escape
in Pi's Markdown renderer ([Marked #4141](https://github.com/markedjs/marked/issues/4141)).
Major-version migrations remain upstream-led.

Dropped in the 1.0 rebuild: working-session checkpoints and safe sleep, `pi convert-session`, the
old session-performance internals, `pi.recordUsage`, atomic write/edit publication
(`publishLocalFile`), `/topview`, Responses web-search metadata, cache-miss cause details,
`forkBranch()`/`getBranchState()`, `ambientAuth`, retry events, `unregisterCommand`,
`preservePending`/`persistOnCancel`, the busy-state helpers, `getCompactionSettings`,
`registerBashCwdHook`, `--session-cwd`, and the sync-upstream, verify-fork, bench-session,
task-cost and profiling scripts. Also dropped: the fork's native-MCP changes (the owner runs
`pi-mcp-adapter`, which already loads servers lazily on 1.0) and the old prompt-cache protection
framework (1.0 already keeps prompts deterministic; only the observed instruction-group prefix
rewrite needed a fix). Dropped after the rebuild: overflow recovery through compaction hooks when
nothing is old enough to summarize. It offered tiny, misreported overflows to hooks, against
Posthorse's native-eligibility contract, and official 1.0 recovers a real full-window overflow
after a reset on the next prompt. The live PTY RPC-to-TUI handoff (`attach_tui`) is also dropped.

The focused native working-session and provider-auth-fallback APIs above are owner-authorized additions to the 1.0 foundation `a74a93cbbb17d8affae01f1b269f5e079cbb9ea3`. They do not restore the old checkpoint stack or `ambientAuth` API. Consumers must record the effective source including these additions; the foundation SHA alone does not identify this behavior.

## Remotes and history

- Identify remotes by URL with `git remote -v`. In the ecosystem checkout, `origin` is
  `fitchmultz/pi` and `upstream` is `earendil-works/pi` (fetch only).
- Local `main` tracks the fork's `main`. Merge upstream; never rebase or force-push fork history.
- The 1.0 rebuild started from the v1.0.0 tree and recorded earlier fork history with
  `git merge -s ours`.

## Updating from upstream

Choose checks for the changed behavior and affected callers, reusing still-valid results.
The full suite below suits broad integrations; focused catch-up merges use the affected
tests through `./test.sh -- <command>`.

```sh
git fetch origin
git -c fetch.pruneTags=false fetch upstream --tags
git worktree add -b sync/upstream-<tag> ~/Projects/worktrees/pi/upstream-<tag> origin/main
cd ~/Projects/worktrees/pi/upstream-<tag>
git merge <tag>                  # resolve conflicts, keeping the features above
npm ci --ignore-scripts
npm run hydrate:model-data
npm run check
./test.sh
```

Open the PR with `gh pr create --repo fitchmultz/pi`, follow CI to completion, fix failures and actionable review findings (or record evidence-backed rebuttals), and merge through repository rules. Refresh the canonical local checkout without overwriting unrelated work, install and verify changed resources, then remove only the task's clean worktree and obsolete branch.
CI adds tmux for the real-terminal restart test, a macOS job for restart and
`background_command`, and one Linux standalone build with the compiled extension regression.
The standalone step uses pinned Bun 1.3.14 and the existing package build.

## Install and activate

This runtime workflow applies when runtime code or bundled runtime resources change. For guidance-only changes, refresh the canonical checkout and any actual installed copies of the changed guidance, verify they match the merged revision, and clean up the task worktree. Do not build, activate or restart unchanged core code merely for Markdown edits.

Installations are immutable releases under `~/.local/share/pi-fork/releases/`. The `pi` binary
links through a selector symlink, by default
`~/.local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent`.

```sh
npm ci --ignore-scripts
npm run hydrate:model-data                            # right before staging
node scripts/install-fork.mjs --stage                 # build and validate HEAD, no selection
node scripts/install-fork.mjs --activate <identity>   # select; old target kept at <selector>.previous
node scripts/install-fork.mjs --rollback <identity>
node scripts/install-fork.mjs --prune --keep 5
```

The installer builds the exact commit from a Git archive plus the checkout's hydrated model data,
installs frozen dependencies from `packages/coding-agent/install-lock`, smoke-tests the SDK and CLI,
runs a bundled `background_command` smoke and the real-tmux restart test against the installed CLI.
The release identity is `<commit>-<catalog sha256 prefix>-node<version>-<platform>-<arch>`, so the
catalog is frozen at staging time. Normal install/activation compares frozen installed
provider/model IDs with the selected release under the shared mutation lock, before changing
either selector link. First installs and equal/growing catalogs pass; losses are listed and refuse
activation. Review intentional removals, then use `--activate <identity> --accept-model-removals`;
the removed IDs are still printed. No model generation or remote refresh occurs during comparison.
Missing, invalid or unsupported-schema selected catalogs fail closed. Explicit `--rollback`
skips the catalog downgrade check for recovery, not receipt/identity or store/lock safeguards.
Settings, credentials, sessions and extensions are never edited.
Builds share a private npm cache in `~/.cache/pi-fork/npm-cache` and keep each failed
attempt's npm debug logs in `~/.cache/pi-fork/npm-logs/<attempt>`; see
[Fork installation](packages/coding-agent/docs/quickstart.md#fork-installation) for cleanup.
`node scripts/install-fork.mjs --help` lists every option.

All release mutations share `<selector>.lock`. A release store belongs to one selector, recorded
in its `.owner-selector`; other selectors must use their own `--releases` directory. `--prune` only
removes releases installed by the owning selector. Legacy releases are kept until removed by hand.

`pi update`, its self-update aliases, and the Pi update in `--all` follow fork main
when the running installation has a fork receipt. Explicit custom update commands
take precedence. `pi --build-info` prints the actual runtime path and existing
receipt, so builds with the same upstream version remain distinguishable.

An explicit npm installation of the upstream package can replace the selector
with a real directory. Move that directory aside before native activation.
See [Restore the fork after an npm replacement](packages/coding-agent/docs/quickstart.md#restore-the-fork-after-an-npm-replacement).

Running sessions keep their runtime. To load a newly selected release, fully relaunch Pi, or run
`pi restart` from a session that follows the selector. `pi restart --runtime <package dir>` tries
a staged release without selecting it. See [restart.md](packages/coding-agent/docs/restart.md).

The fork updater does the fetch, build, stage and activate steps for you from the latest
`fitchmultz/pi` main. It only updates an existing selector installation and leaves the previous
release selectable at `<selector>.previous`. Unlike the manual installer's default, this
owner-authorized updater accepts routine catalog removals and prints every removed ID;
malformed or empty catalogs still fail closed. Its selector is
`$(npm root -g)/@earendil-works/pi-coding-agent`; on Termux it is
`~/.local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent` with `~/.local/bin/pi`.
After a successful activation, including a same-commit reuse, it runs the pinned installer's
`--prune --keep 5` with the same `--selector` and `--releases`. The installer's ownership,
selected, `.previous` and `lsof`/`ps` checks still apply; legacy releases count toward the five
but are never removed. Fork CLI and SDK processes keep their release receipt open so `lsof`
can detect JavaScript-only runtimes. Restart workers from older releases to gain this protection.
Missing or failed process-inspection tools skip cleanup with a warning, not a failed update.
A direct launch of an old release during pruning is not coordinated with the process snapshot.

After activation, immediately restart running workers and verify their actual runtime, not only
the selector. Launcher changes require a full CLI relaunch; worker restart leaves the launcher
loaded. Preserve the previous immutable release until the new runtime is verified. Restart accepts
only complete current native state, with no journal-only or pre-v1 handoff fallback.

## Testing

- `npm run check` after code changes.
- `./test.sh` (also the default `npm test`) runs all non-e2e tests offline in an isolated home; `./test.sh -- <command>` runs a
  focused command the same way. Node and npm resolve before HOME isolation so version-manager
  shims keep working. The isolated root follows the caller's `TMPDIR`; Chord's upstream lock
  fallback handles Unix socket paths that exceed the native limit.
- `./test.sh` keeps the caller's `PATH`. If GNU coreutils' `gnubin` comes before `/bin`, Env's
  foreground-job test sees `gsleep` instead of `sleep`. Remove `gnubin` from `PATH` and unset
  `BASH_ENV` when it re-adds it, for example `env -u BASH_ENV PATH=<PATH without gnubin> ./test.sh`.
- Restart terminal tests need tmux and a built CLI; set `PI_TEST_CLI` to test an installed release.
- Standalone builds enable `--compile-autoload-package-json`: dependency `main` and `exports`
  resolve at runtime, including Bun export conditions. Unexported subpaths are rejected as under
  Node; use public entrypoints. `--no-compile-autoload-bunfig` keeps project preloads disabled, and `--no-compile-autoload-dotenv` prevents launch-directory `.env` files from changing Pi's environment.
  Bun 1.3.14's runtime tsconfig autoload default remains disabled; the package-manifest flag is
  independent. Pi's project-resource trust gate and embedded host peers are unchanged.
- `compiled-extension-packages.test.ts` requires an explicit `PI_TEST_COMPILED_CLI` standalone
  target; unset skips, invalid targets fail. It checks deferred conditional/transitive imports,
  main-only roots, private-subpath rejection, project-extension denial, disabled bunfig
  preloads and dotenv isolation without model calls. `PI_TEST_CLI` remains the separate Node restart-test input.

  ```sh
  PI_TEST_COMPILED_CLI=/path/to/pi ./test.sh -- \
    node node_modules/vitest/dist/cli.js --run --root packages/coding-agent \
    test/compiled-extension-packages.test.ts
  ```
