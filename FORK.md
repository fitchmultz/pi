# fitchmultz/pi — personal Pi fork

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi), rebuilt on upstream
v1.0.0 and synchronized through upstream `4954d760504c11df9b2cbdc040346107b6a8153d`
(2026-10-15), including v1.3.0 and its follow-up fixes. It is upstream plus the features
below. Everything else follows upstream behavior and APIs.

The [v1.3.0 integration record](docs/upstream-sync-1.3.0.md) documents the current
baseline, preserved callers, new regressions and verification commands. The
[earlier 2026-10-15 integration record](docs/upstream-sync-2026-10-15.md) documents the
measured divergence, preserved callers, new regressions and verification commands.

## Fork features

Owners below are source paths under `packages/coding-agent/src/`, and tests are under
`packages/coding-agent/test/`, unless another package or repository path is given.
The tests identify each delta's behavioral owner; they are not claims of live provider or
all-platform qualification.

| Feature and reason retained | Owner | Primary tests | Docs |
| --- | --- | --- | --- |
| Managed restart: same-session replacement without replay, with readiness rollback | `cli/{launcher,restart-protocol}.ts`, `extensions/restart/`, `cli-launcher.ts` | `restart-launcher.test.ts`, `restart-tui.test.ts`, `restart-guidance.test.ts` | [Restart](packages/coding-agent/docs/restart.md) |
| Detached `background_command`: durable jobs/logs and completion delivery | `extensions/background-command/`, worker asset in `config.ts` | `background-command-process.test.ts`, `suite/background-command-{session,guards}.test.ts`, `scripts/smoke-test-background-command-bundle.mjs` | [Background commands](packages/coding-agent/docs/background-command.md) |
| `discover_tools`: initial capability summaries, full prior-turn instructions and stable positional declarations | `extensions/instruction-groups/`, native deferred-tool restore in `core/agent-session.ts`, narrow `refreshTools()` seam in `core/{agent-session,extensions/loader,extensions/types}.ts` | `suite/instruction-groups.test.ts`, `suite/prompt-cache-prefix.test.ts` | [Instruction groups](packages/coding-agent/docs/instruction-groups.md) |
| JSON `read`: selection before paging/truncation, inherited by native factory consumers | `core/tools/{read,read-json}.ts` | `read-json.test.ts` | [SDK](packages/coding-agent/docs/sdk.md#json-selection-with-read) |
| Compact activity: regroup native cards without replacing the whole TUI | `modes/interactive/{interactive-mode,components/activity}.ts`, card renderers, `core/settings-manager.ts` | `compact-view.test.ts`, `suite/regressions/compact-view.test.ts` | [Settings](packages/coding-agent/docs/settings.md) |
| Immutable fork update: exact source/catalog, frozen install and guarded selection | `utils/{fork-update,fork-release-store}.ts`, `scripts/install-fork.mjs` | `fork-update.test.ts`, `scripts/install-fork.test.mjs` | [Install and activate](#install-and-activate) |
| Termux: compiler/environment handling and short control-socket paths | `scripts/install-fork.mjs`, `test.sh`, `cli/restart-protocol.ts` | `scripts/install-fork.test.mjs`, `restart-control.test.ts`; device activation is separate | [Termux](packages/coding-agent/docs/termux.md) |
| Complete working state: native admission, all branches/queues/mode buffers and completed-exit attestation; strict plain-JSON snapshots use Chord's checker with a container hook, so coding-agent keeps its `@earendil-works/chord` dependency after upstream dropped it | `core/{working-session,agent-session,sdk,agent-session-services}.ts`, `cli/working-session-control.ts`, native mode/builtin bindings, `packages/chord/src/json.ts` (`CheckJsonOptions`) | `suite/working-session.test.ts`, `suite/working-session-cli.test.ts`, `packages/chord/test/json.test.ts` | [Working sessions](packages/coding-agent/docs/working-session.md) |
| Credential isolation: routing providers must not read unrelated stored credentials | `core/model-runtime.ts`, provider registration types/adapter | `provider-credential-isolation.test.ts` | [Custom providers](packages/coding-agent/docs/custom-provider.md) |
| Auth fallback: ephemeral credentials without replacing native provider/catalog/transport | `core/{model-runtime,provider-composer}.ts`, `core/extensions/provider-registrations.ts` | `model-runtime-auth-options.test.ts` | [Auth fallback](packages/coding-agent/docs/custom-provider.md#supply-fallback-authentication-without-replacing-a-provider) |
| Opt-in slow diagnostics: native synchronous handlers and footer frames need dispatch attribution | `core/extensions/{runner,wrapper}.ts`; `PI_EXTENSION_PERFORMANCE=1` | `extensions-performance.test.ts` | [Extensions](packages/coding-agent/docs/extensions.md#opt-in-performance-warnings) |
| Temporary passive tracing: public hooks do not yet cover final serialization/consumed attempts | `packages/ai/src/utils/cache-trace.ts`, native adapter hooks, `core/cache-trace-context.ts`, `scripts/cache-trace-report.mjs` | `packages/ai/test/cache-trace.test.ts`, `sdk-stream-options.test.ts`, `scripts/cache-trace-report.test.mjs` | [Fidelity and retirement](packages/coding-agent/docs/cache-tracing.md) |
| Cloudflare catalogs: canonical Claude IDs, qualified Opus 5.5 positional controls/cache lifetimes, and direct-OpenAI positional defaults for `/openai` Responses models | `packages/ai/src/api/cloudflare.ts`, generator/provider, `packages/ai/scripts/hydrate-model-catalog.ts` and `core/remote-catalog-provider.ts` | `packages/ai/test/{model-data-validation,cloudflare-openai-positional}.test.ts`, `remote-catalog-provider.test.ts`, `model-runtime-cloudflare-compat.test.ts`, `suite/prompt-cache-prefix.test.ts` | [Providers](packages/coding-agent/docs/providers.md), [Cache lifetimes](packages/coding-agent/docs/models.md#prompt-cache-lifetimes) |
| Path hyperlinks: Markdown paths stay clickable after wrapping; terminals only regex-match one row and the source-transform seam cannot see codespans or code blocks | `packages/tui/src/components/markdown.ts` | `packages/tui/test/markdown.test.ts` | [Terminal setup](packages/coding-agent/docs/terminal-setup.md#override-detected-capabilities) |

Complete working state also depends on the queue/admission APIs in
`packages/agent/src/agent.ts`, resource/settings capture, and bounded artifact I/O in
`utils/streaming-file.ts`; these are part of the retained capability, not redundant helpers.

### Retained correctness deltas

These fixes remain until upstream supplies equivalent behavior, not merely closes a report.
Private output-file creation (`wx` / `0o600`) now follows upstream `utils/output-files.ts` (adopted in the v1.1.0 sync); the fork keeps `private-spill.test.ts` as a regression guard.
Malformed Env frames now follow upstream's guarded decoder; the fork keeps `packages/env/test/connection.test.ts` as a subprocess regression guard. The SSH login-shell fixture now follows upstream's sh/Bash/zsh startup coverage.
Literal and modified `+` key bindings now use upstream's modifier parser; the fork's regression cases remain.
Empty quoted prompt-template arguments now follow upstream's token parser and positional-default regression coverage ([#10867](https://github.com/earendil-works/pi/issues/10867)); the equivalent fork implementation and tests are retired.
Transcript resume uses upstream's recorded active-tool loadout and `--tools +name/-name` modifiers ([#10785](https://github.com/earendil-works/pi/issues/10785)). The fork reconciles temporarily deferred discovery tools when discovery is disabled or absent; explicit selections, exclusions and later deselection remain authoritative across subsequent resumes. Native complete working-session restore retains its exact saved current loadout and modifier policy.
Claude 5.5 catalog entries now use upstream's models.dev metadata rather than the removed fallback definitions.
OpenCode Go's Google adapter and inference endpoints now follow upstream; `packages/ai/test/opencode-provider-headers.test.ts` retains the Gemini routing regression guard.
The Chord service-hydration array check ([#10509](https://github.com/earendil-works/pi/issues/10509)) was retired with upstream's Chord 2 runtime: the service runtime is gone, and every link, including the in-memory one, JSON-round-trips frames.
Chord reference admission now follows upstream's foreign-context checks and root handling.
The fork's shared admission helper and supporting type changes are retired; the local/client/host
regression matrix remains in `packages/chord/test/review.test.ts`.
See the [AI](packages/ai/CHANGELOG.md#unreleased), [agent](packages/coding-agent/CHANGELOG.md#unreleased),
[Codemode](packages/codemode/CHANGELOG.md) and [TUI](packages/tui/CHANGELOG.md#unreleased) changelogs for user-facing details.

| Reason retained | Owner | Primary tests |
| --- | --- | --- |
| Legacy published Kimi Coding catalogs must not break offline builds or revert the native OpenAI protocol on fetched/cached overlays; preserve effort/tool constraints and K3 cache-write pricing | `packages/ai/src/api/kimi.ts`, `packages/ai/scripts/{generate-models,hydrate-model-catalog}.ts`, `core/remote-catalog-provider.ts` | `packages/ai/test/model-data-validation.test.ts`, `remote-catalog-provider.test.ts` |
| Git footers must catch branch changes missed while native watchers and polling baselines start | `core/footer-data-provider.ts` | `footer-data-provider.test.ts` |
| Cache warming must schedule prepared native retention and estimate one-hour writes and prompt-length price tiers without claiming provider-wrapper rates | `core/{cache-warmer,model-runtime,sdk}.ts`, `modes/interactive/interactive-mode.ts` | `cache-warmer.test.ts` |
| Standalone extension dependencies need runtime package manifests for public entrypoints and transitive imports | `scripts/build-binaries.sh`, `packages/coding-agent/package.json` (`build:binary`) | `compiled-extension-packages.test.ts` (built Bun CLI) |
| WebSocket text frames must not decode object-transport packing markers and bypass untrusted-client compression restrictions | `packages/chord/src/link.ts` | `packages/chord/test/websocket.test.ts` |
| Releasing the last state view during hydration must not strand a shared method-only reference | `packages/chord/src/remote.ts` | `packages/chord/test/bindings.test.ts` |
| Cancelling a shell on macOS must not wake waiting ancestors into later steps; freeze its process group before killing it | `utils/shell.ts`, `packages/coding-agent/examples/extensions/sandbox/index.ts`, `packages/durable/src/env/node.ts`, `packages/env/daemon/src/sys/unix.rs` | `background-command.test.ts`, `suite/background-command-guards.test.ts`, shared `packages/durable/src/testing/env-conformance.ts` |
| Atomic private rewrites, canonical credential locks and preservation of unrelated settings | `utils/atomic-file.ts`, `core/{auth-storage,settings-manager,session-manager}.ts` | `file-safety.test.ts` |
| HTML export must not replace the journal through any alias | `core/export-html/index.ts` | `file-safety.test.ts` |
| Edits must preserve UTF-8 and untouched original text/boundaries | Shared policy in `packages/durable/src/tools/edit-diff.ts`; byte I/O in `packages/durable/src/tools/edit.ts`, `core/tools/{edit,edit-diff}.ts`, `utils/text.ts` | `packages/durable/test/tools.test.ts`, `edit-byte-safety.test.ts` |
| One auth-check failure must not hide healthy providers or replace saved/scoped selections | `packages/ai/src/models.ts`, `core/{model-runtime,model-resolver,sdk}.ts` | `packages/ai/test/models-runtime.test.ts`, `model-runtime-auth-options.test.ts`, `model-resolver.test.ts`, `agent-session-dynamic-provider.test.ts` |
| Refresh admission must precede config I/O: awaited scopes follow current per-provider catalog/auth readiness, global availability reads cannot discard credential synchronization or make it join unrelated work, and full-pass auth failures retain provider-local diagnostics and sibling credential filters under scoped overlap. Scoped snapshot updates read only their own catalogs, so a refresh stays linear in the number of providers | `core/model-runtime.ts` | `model-runtime-refresh-order.test.ts`, `agent-session-dynamic-provider.test.ts`, `model-runtime-credential-sync.test.ts` |
| OAuth state, cancellation and UI failures must retain listener/prompt cleanup | `packages/ai/src/auth/oauth/{callback-server,openai-chatgpt}.ts` | `packages/ai/test/{oauth-callback-server,openai-chatgpt-oauth}.test.ts` |
| Retained payload objects must not mutate Codex continuation baselines | `packages/ai/src/api/openai-codex-responses.ts` | `packages/ai/test/openai-codex-stream.test.ts` |
| Mistral's header deadline must stop after headers with or without a caller signal; caller cancellation must still stop SSE and held-open HTTP-error bodies ([#10609](https://github.com/earendil-works/pi/issues/10609)) | `packages/ai/src/api/mistral-conversations.ts` | `packages/ai/test/mistral-http-transport.test.ts` |
| Failed terminal responses must preserve consumed numeric usage and error details | `packages/ai/src/api/{openai-responses-shared,openai-codex-responses}.ts` | `packages/ai/test/{openai-responses-terminal-event,openai-codex-stream}.test.ts` |
| Astra Ultrafast and legacy Codex Fast estimates need correct tier/confirmation rules | `packages/ai/src/api/{openai-responses,openai-codex-responses}.ts` | `packages/ai/test/openai-ultrafast-pricing.test.ts` |
| Anthropic strict limits apply across initial and inline definitions, including required schemas. Upstream's one-time fallback after a rejected request stays for limits a count cannot predict, such as compiled grammar size; alone it would spend a rejected request on every over-limit turn and drop strict mode for all preferred tools | `packages/ai/src/api/anthropic-messages.ts` | `packages/ai/test/anthropic-strict-tool-{schema,fallback}.test.ts` |
| Optional nulls inside schema unions must not be coerced into fabricated values | `packages/ai/src/utils/validation.ts` | `packages/ai/test/validation.test.ts` |
| DNS root dots must not bypass `NO_PROXY` | `packages/ai/src/utils/node-http-proxy.ts` | `packages/ai/test/node-http-proxy.test.ts` |
| Fractional/overflowed zero retry delays must not become a minute; completed backoffs must release abort listeners ([#10506](https://github.com/earendil-works/pi/issues/10506)) | `packages/ai/src/utils/retry.ts` | `packages/ai/test/retry.test.ts` |
| Radius gateway pricing must have finite rates and tiers before cost estimation ([#10507](https://github.com/earendil-works/pi/issues/10507)) | `packages/ai/src/providers/radius-config.ts` | `packages/ai/test/radius-provider.test.ts` |
| Abort tests must check the terminal result and follow-up rather than pass early ([#10508](https://github.com/earendil-works/pi/issues/10508)); this is test-only, not a provider cancellation fix | `packages/ai/test/abort.test.ts` | Offline faux-provider case in the same file |
| Codemode string store keys must round-trip as own data properties, including `__proto__`, on every sandbox backend ([#10510](https://github.com/earendil-works/pi/issues/10510)) | `packages/codemode/src/runtime/execution.ts` | `packages/codemode/test/sandbox.test.ts` |
| An oversized Env watch change must report `overflow` instead of stopping the daemon's output writer ([#10516](https://github.com/earendil-works/pi/issues/10516)) | `packages/env/daemon/src/watch.rs` | `packages/env/test/remote.test.ts` |
| Equivalent known-hosts path spellings must serialize accept/forget rewrites ([#10517](https://github.com/earendil-works/pi/issues/10517)) | `packages/env/src/ssh.ts`, `packages/env/test/ssh.test.ts` | `packages/env/test/ssh.test.ts` |
| Replayed signatures count toward context estimates | `packages/ai/src/utils/estimate.ts` | `packages/ai/test/context-estimate.test.ts` |
| Model-switch output limits must use target-model usage and native replay, not charge reasoning dropped from the request | `packages/ai/src/{utils/estimate,utils/transform-messages,api/simple-options}.ts`; the existing public `api/transform-messages` entry re-exports the shared implementation | `packages/ai/test/context-estimate.test.ts` |
| Retry omissions after a valid usage anchor must not re-estimate its unchanged prefix ([#10287](https://github.com/earendil-works/pi/issues/10287), [#10068](https://github.com/earendil-works/pi/issues/10068)); compaction must count replayed reasoning signatures (estimate portion of [#9409](https://github.com/earendil-works/pi/issues/9409)), while text summaries budget only serialized content | `core/compaction/{compaction,branch-summarization}.ts`, `core/bug-report.ts` | `session-context-edit.test.ts`, `branch-summarization.test.ts`, `suite/agent-session-context-usage.test.ts` |
| Dialog input needs xterm printable decoding, grapheme-safe replacement and correct mouse columns | `packages/tui/src/components/input.ts` | `packages/tui/test/{input,mouse-components}.test.ts` |
| Hyperlink control payloads must stay byte-identical | `packages/tui/src/utils.ts` | `packages/tui/test/truncate-to-width.test.ts` |
| Terminal cell-size replies must reach native housekeeping before extension input listeners | `packages/tui/src/tui.ts` | `packages/tui/test/tui-cell-size-input.test.ts` |
| Image coordinate notes need independent unrounded axis ratios | `utils/image-resize.ts` | `image-dimension-note.test.ts` |
| Branch budgets must exclude system declarations not serialized as conversation | `core/compaction/branch-summarization.ts` | `branch-summarization.test.ts` |
| Cache overlap estimates must follow native ancestry, identify expected model/provider transitions and distinguish current, prior observed, catalog and unknown read prices without changing real usage totals | `core/cache-stats.ts`, `modes/interactive/interactive-mode.ts` | `cache-stats.test.ts`, `interactive-mode-assistant-diagnostics.test.ts`, `suite/prompt-cache-prefix.test.ts` |
| Piped input needs separators; whitespace-only input must not start a turn | `cli/initial-message.ts`, `main.ts` | `initial-message.test.ts` |
| Reload must preserve deselected default-active tools while adopting newly configured defaults, including saved `--tools +name/-name` modifiers | `core/agent-session.ts` | `default-tools-setting.test.ts` |
| Custom UI must dispose components completed during factory initialization and preserve drafts typed before an asynchronous factory mounts | `modes/interactive/interactive-mode.ts` | `interactive-mode-status.test.ts` |
| Extension cancellation must remain observable through run setup, post-run recovery and pre-settlement, without replacing the active loop's signal or exposing an idle signal; upstream's `agent_settled.aborted` is captured before clearing that signal | `core/{agent-session,extensions/types}.ts` | `suite/background-command-session.test.ts`, `suite/agent-session-boundaries.test.ts` |
| Repeated context-usage reads must reuse the last scalar without rescanning archived ancestry; native leaf identity and effective model limits preserve compaction, edits, branches and reload/restore behavior | `core/agent-session.ts` | `suite/agent-session-context-usage.test.ts` |
| Session hot paths incrementally retain active ancestry, compaction-aware raw context entries and model/thinking settings; projected messages and returned arrays remain fresh. Entry-list and leaf identity invalidate reuse on reload or navigation. The latest name stays indexed; branch-summary admission stays linear, file forks reuse a private exclusive descriptor, and custom-flat listings reject unrelated cwd headers before reading bodies | `core/session-manager.ts`, `core/compaction/branch-summarization.ts` | `session-manager/*.test.ts`, `session-context-edit.test.ts`, `branch-summarization.test.ts`, `file-safety.test.ts` |
| Empty-draft boundary previews use the live manager and compute projection/LLM fields only when read; pending-queue readers never project history. Each handler retains its own preview for freshness. Canonical context still refreshes after every boundary because public Agent state allows in-place mutation; committed drafts refresh before entry notifications. Mutable nonempty drafts still need eager validation. The undocumented `emitBoundary` preview builder remains synchronous | `core/extensions/runner.ts`, `core/agent-session.ts` | `extensions-runner.test.ts`, `suite/agent-session-boundaries.test.ts` |

### Performance deltas

These paths remove repeated work or bound allocation while preserving their existing contracts.
Keep them visible during upstream syncs; retire each change when upstream covers the same behavior.
Workloads, measurements and limits are in [Performance reproduction](docs/performance.md).

| Retained work reduction | Owner | Primary tests |
| --- | --- | --- |
| Normalize tool declarations once per comparison, index model overlays per read, repair JSON by spans, and drain Codex events without repeated array shifts | `packages/agent/src/agent-loop.ts`, `packages/ai/src/{utils/transcript,utils/json-parse,models,api/openai-codex-responses}.ts` | `packages/agent/test/agent.test.ts`, `packages/ai/test/{system-message-replay,json-parse,model-types,openai-codex-websocket-queue}.test.ts` |
| Stream long-token wrapping, use native grapheme endpoints, and reuse only the current editor layout after comparing text, width and paste membership | `packages/tui/src/{utils,components/editor,components/input}.ts` | `packages/tui/test/{wrap-ansi,editor,input}.test.ts` |
| Reuse unchanged assistant runs, reject plain prose before Mermaid lexing, and compute visible tree ancestry in one pass | `modes/interactive/components/{assistant-message,mermaid,tree-selector}.ts` | `{assistant-message,mermaid,tree-selector}.test.ts` |
| Normalize edit text once and scan only requested read, grep and head-truncation ranges | `packages/durable/src/tools/edit-diff.ts`, `core/tools/{read,grep,truncate}.ts` | `packages/durable/test/tools.test.ts`, `edit-byte-safety.test.ts`, `tools.test.ts` |
| Stop image encoding at the first fitting candidate without changing candidate order | `utils/image-resize-core.ts` | `image-processing.test.ts` |
| Bound native Bash spill queues and wait for complete private files; push-only custom producers retain their existing callback contract | `core/{bash-executor,tools/bash,tools/output-accumulator}.ts`, `utils/{output-files,child-process}.ts` | `bash-spill.test.ts`, `private-spill.test.ts`, `streaming-file.test.ts` |
| Skip disk reads only for acknowledged, confirmed-terminal background jobs during monitoring; explicit tools remain fresh | `extensions/background-command/{index,jobs}.ts` | `suite/background-command-session.test.ts`, `background-command-process.test.ts` |
| Compile upstream's single Chord frame schema once, drain publications by cursor, and accumulate MCP lines and error prefixes without repeated copying | `packages/chord/src/{wire,publish}.ts`, `packages/mcp/src/transports/{stdio,streamable-http}.ts` | `packages/chord/test/{links-review,state}.test.ts`, `packages/mcp/test/{stdio,streamable-http}.test.ts` |
| Limit retained-context scheduler work, binary-search historical revisions, avoid redundant SQLite writes, and join long lines at their boundary | `packages/durable/src/{harness/scheduler,storage/memory,storage/sqlite/storage,env/node}.ts` | `packages/durable/test/{harness-context,memory-storage,sqlite-storage,env-node}.test.ts` |
| Count decoded lengths with scratch storage, reuse frame payload allocation without retaining large metadata, bound read-ahead, and precompute directory sort keys | `packages/env/daemon/src/{decode,scan,frame}.rs`, `packages/env/src/remote-env.ts` | Native daemon tests, `packages/env/test/{connection,remote,differential}.test.ts` |
| Append native eval journals and validate reports once; avoid repeated retained-array copying in the opt-in telemetry adapter | `packages/evals/src/{cli,report}.ts`, `packages/telemetry/src/memory.ts` | `packages/evals/test/{cli,report}.test.ts`, `packages/telemetry/test/conformance.test.ts` |
| Build ready workspaces two at a time, batch selected npm packs, avoid unused native-path Biome WASM loading, and retain every startup worker profile | `scripts/{build,package-artifacts,pack-nix-packages,biome-check,profile-coding-agent-node}.mjs`, `nix/package.nix` | `scripts/{workspace-build,package-artifacts,package-artifact-cli,profile-coding-agent-node}.test.mjs` |

The fork also keeps its own delivery tooling: `scripts/install-fork.mjs`, the isolated `./test.sh`,
fork policy text in `AGENTS.md`/`CONTRIBUTING.md`, a macOS CI job for restart and
`background_command`, and no upstream publishing, binary (including Android APK) or
issue-analysis workflows. Upstream's local `scripts/issues` triage tool is kept but unused. Nix builds
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
`compactView` setting, which the hosted settings schema accepts as an extra key.

Package production uses the maintained `scripts/package-artifacts.mjs` and local consumer helpers,
including npm 12's expected-package-keyed pack metadata. Selected workspaces pack in one npm process;
Nix retains its nine raw named archives. Pinned fleet automation has migrated to the artifact API,
and the obsolete `scripts/coding-agent-consumer.mjs` shim has been removed.
Retained offline comparison fixtures are documented in [Performance reproduction](docs/performance.md).

Chord follows upstream's protocol 4, contract-owned placement, typed principals, named declarations,
per-cell versions and initialization, host lifetimes, and reload/code-generation retirement.
`host.get` and `ctx.get` await readiness and state hydration; `host.hold` is the synchronous
acquisition API. Protocol peers must upgrade together. Durable uses upstream's shared
`@earendil-works/chord/output` implementation. Its public `utf8ByteLength` helper also
backs Durable's internal truncation utilities.
It also follows upstream's schema-derived frame types, stricter contract tokens and error codes,
large-payload deflation, acknowledgement-based state flow control, and optional per-link call limits.
`Link.send` reports encoded sizes when available; call results may overtake waiting state. The fork
retains one compiled frame validator, the cursor-based publication drain, strict-JSON container hooks
and public exports. Coding-agent uses Chord's JSON helpers, not its host/link transport; this sync
establishes no current TUI or tool-performance improvement from those transport features.

Model references follow upstream's shared provider-selection policy, including gateway IDs,
thinking suffixes, authenticated-provider tie breaking and explicit-key ambiguity. The fork retains
saved/scoped selections when a provider's auth check fails. Codemode follows upstream's prompt
cancellation and two-live-worker admission limit, with the fork's safe arbitrary store keys retained.

Streaming tool-call JSON now follows upstream's invalid `\u` repair without losing later fields,
while retaining span-based repair and the original partial-parser fallback order. Anthropic and
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
OpenAI entries accept mid-conversation developer messages and `additional_tools` get both flags too:
the published catalog lists only OpenCode and Copilot as Responses proxies, so without them every
system update or tool load rewrote the cached prompt prefix. A parity test keeps that model list
aligned with the generator's. Explicit compatibility flags and whole cache metadata objects are preserved;
catalog entries with a non-canonical `baseUrl` do not receive these defaults.

Program status and prompt-length pricing tiers follow upstream 1.1.0. Kimi K3 keeps
the published $3/M five-minute cache-write rate, including Kimi Coding's implied
estimate ([pricing](https://platform.kimi.ai/docs/pricing/chat)). Kimi Coding's shared
metadata helper also migrates canonical legacy Anthropic catalog entries during
offline hydration and fetched/cached runtime merges. Native OpenAI entries, custom
endpoints and other providers are unchanged. Claude 5.5 pricing now follows
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
runtime updates for YAML 2.9.1, Chalk 6.0.1, Ignore 7.0.12, Undici 8.11.2 and
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

- `origin`: upstream `earendil-works/pi` (fetch only). `fork`: `fitchmultz/pi`.
- Local `main` tracks `fork/main`. Merge upstream; never rebase or force-push fork history.
- The 1.0 rebuild started from the v1.0.0 tree and recorded earlier fork history with
  `git merge -s ours`.

## Updating from upstream

```sh
git fetch origin --tags
git worktree add -b sync/upstream-<tag> ../worktrees/pi/upstream-<tag> fork/main
cd ../worktrees/pi/upstream-<tag>
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
`node scripts/install-fork.mjs --help` lists every option.

All release mutations share `<selector>.lock`. A release store belongs to one selector, recorded
in its `.owner-selector`; other selectors must use their own `--releases` directory. `--prune` only
removes releases installed by the owning selector. Legacy releases are kept until removed by hand.

Do not run `pi update` (self) on a fork installation: it installs the official npm package over the
selector. If that happens, `--activate` a fork release again.

Running sessions keep their runtime. To load a newly selected release, fully relaunch Pi, or run
`pi restart` from a session that follows the selector. `pi restart --runtime <package dir>` tries
a staged release without selecting it. See [restart.md](packages/coding-agent/docs/restart.md).

`pi update --fork` does the fetch, build, stage and activate steps for you from the latest
`fitchmultz/pi` main. It only updates an existing selector installation and leaves the previous
release selectable at `<selector>.previous`. Unlike the manual installer's default, this
owner-authorized updater accepts routine catalog removals and prints every removed ID;
malformed or empty catalogs still fail closed. Its selector is
`$(npm root -g)/@earendil-works/pi-coding-agent`; on Termux it is
`~/.local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent` with `~/.local/bin/pi`.

After activation, immediately restart running workers and verify their actual runtime, not only
the selector. Launcher changes require a full CLI relaunch; worker restart leaves the launcher
loaded. Preserve the previous immutable release until the new runtime is verified. Restart accepts
only complete current native state, with no journal-only or pre-v1 handoff fallback.

## Testing

- `npm run check` after code changes.
- `./test.sh` runs all non-e2e tests offline in an isolated home; `./test.sh -- <command>` runs a
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
