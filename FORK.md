# fitchmultz/pi — personal Pi fork

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi), rebuilt on upstream
v1.0.0 and synchronized through upstream `f1b2e77f5b13b2a199b1052cb79c235451afe7d7`
(2026-10-09), an unreleased snapshot after v1.1.0 `abe508e1b`. It is upstream plus the features
below. Everything else follows upstream behavior and APIs.

## Fork features

Owners below are source paths under `packages/coding-agent/src/`, and tests are under
`packages/coding-agent/test/`, unless another package or repository path is given.
The tests identify each delta's behavioral owner; they are not claims of live provider or
all-platform qualification.

| Feature and reason retained | Owner | Primary tests | Docs |
| --- | --- | --- | --- |
| Managed restart: same-session replacement without replay, with readiness rollback | `cli/{launcher,restart-protocol}.ts`, `extensions/restart/`, `cli-launcher.ts` | `restart-launcher.test.ts`, `restart-tui.test.ts`, `restart-guidance.test.ts` | [Restart](packages/coding-agent/docs/restart.md) |
| Detached `background_command`: durable jobs/logs and completion delivery | `extensions/background-command/`, worker asset in `config.ts` | `background-command-process.test.ts`, `suite/background-command-{session,guards}.test.ts`, `scripts/smoke-test-background-command-bundle.mjs` | [Background commands](packages/coding-agent/docs/background-command.md) |
| `discover_tools`: full prior-turn instructions and stable positional declarations | `extensions/instruction-groups/`, narrow `refreshTools()` seam in `core/{agent-session,extensions/loader,extensions/types}.ts` | `suite/instruction-groups.test.ts`, `suite/prompt-cache-prefix.test.ts` | [Instruction groups](packages/coding-agent/docs/instruction-groups.md) |
| JSON `read`: selection before paging/truncation, inherited by native factory consumers | `core/tools/{read,read-json}.ts` | `read-json.test.ts` | [SDK](packages/coding-agent/docs/sdk.md#json-selection-with-read) |
| Compact activity: regroup native cards without replacing the whole TUI | `modes/interactive/{interactive-mode,components/activity}.ts`, card renderers, `core/settings-manager.ts` | `compact-view.test.ts`, `suite/regressions/compact-view.test.ts` | [Settings](packages/coding-agent/docs/settings.md) |
| Immutable fork update: exact source/catalog, frozen install and guarded selection | `utils/{fork-update,fork-release-store}.ts`, `scripts/install-fork.mjs` | `fork-update.test.ts`, `scripts/install-fork.test.mjs` | [Install and activate](#install-and-activate) |
| Termux: compiler/environment handling and short control-socket paths | `scripts/install-fork.mjs`, `test.sh`, `cli/restart-protocol.ts`, `experimental/server.ts` | `scripts/install-fork.test.mjs`, `restart-control.test.ts`; device activation is separate | [Termux](packages/coding-agent/docs/termux.md) |
| Complete working state: native admission, all branches/queues/mode buffers and completed-exit attestation | `core/{working-session,agent-session,sdk,agent-session-services}.ts`, `cli/working-session-control.ts`, native mode/builtin bindings | `suite/working-session.test.ts`, `suite/working-session-cli.test.ts` | [Working sessions](packages/coding-agent/docs/working-session.md) |
| Credential isolation: routing providers must not read unrelated stored credentials | `core/model-runtime.ts`, provider registration types/adapter | `provider-credential-isolation.test.ts` | [Custom providers](packages/coding-agent/docs/custom-provider.md) |
| Auth fallback: ephemeral credentials without replacing native provider/catalog/transport | `core/{model-runtime,provider-composer}.ts`, `core/extensions/provider-registrations.ts` | `model-runtime-auth-options.test.ts` | [Auth fallback](packages/coding-agent/docs/custom-provider.md#supply-fallback-authentication-without-replacing-a-provider) |
| Opt-in slow diagnostics: native synchronous handlers and footer frames need dispatch attribution | `core/extensions/{runner,wrapper}.ts`; `PI_EXTENSION_PERFORMANCE=1` | `extensions-performance.test.ts` | [Extensions](packages/coding-agent/docs/extensions.md#opt-in-performance-warnings) |
| Temporary passive tracing: public hooks do not yet cover final serialization/consumed attempts | `packages/ai/src/utils/cache-trace.ts`, native adapter hooks, `core/cache-trace-context.ts`, `scripts/cache-trace-report.mjs` | `packages/ai/test/cache-trace.test.ts`, `sdk-stream-options.test.ts`, `scripts/cache-trace-report.test.mjs` | [Fidelity and retirement](packages/coding-agent/docs/cache-tracing.md) |
| Cloudflare Claude IDs: canonicalize provider/remote input before passthrough and merge | `packages/ai/src/api/cloudflare.ts`, generator/provider and `core/remote-catalog-provider.ts` | `remote-catalog-provider.test.ts`, `model-runtime-cloudflare-compat.test.ts` | [Providers](packages/coding-agent/docs/providers.md) |

### Retained correctness deltas

These fixes remain until upstream supplies equivalent behavior, not merely closes a report.
Private output-file creation (`wx` / `0o600`) now follows upstream `utils/output-files.ts` (adopted in the v1.1.0 sync); the fork keeps `private-spill.test.ts` as a regression guard.
Malformed Env frames now follow upstream's guarded decoder; the fork keeps `packages/env/test/connection.test.ts` as a subprocess regression guard. The SSH login-shell fixture now follows upstream's sh/Bash/zsh startup coverage.
Literal and modified `+` key bindings now use upstream's modifier parser; the fork's regression cases remain.
Claude 5.5 catalog entries now use upstream's models.dev metadata rather than the removed fallback definitions.
See the [AI](packages/ai/CHANGELOG.md#unreleased), [agent](packages/coding-agent/CHANGELOG.md#unreleased),
[Codemode](packages/codemode/CHANGELOG.md#unreleased) and [TUI](packages/tui/CHANGELOG.md#unreleased) changelogs for user-facing details.

| Reason retained | Owner | Primary tests |
| --- | --- | --- |
| Standalone extension dependencies need runtime package manifests for public entrypoints and transitive imports | `scripts/build-binaries.sh`, `packages/coding-agent/package.json` (`build:binary`) | `compiled-extension-packages.test.ts` (built Bun CLI) |
| Atomic private rewrites, canonical credential locks and preservation of unrelated settings | `utils/atomic-file.ts`, `core/{auth-storage,settings-manager,session-manager}.ts` | `file-safety.test.ts` |
| HTML export must not replace the journal through any alias | `core/export-html/index.ts` | `file-safety.test.ts` |
| Edits must preserve UTF-8 and untouched original text/boundaries | `core/tools/{edit,edit-diff}.ts`, `utils/text.ts` | `edit-byte-safety.test.ts` |
| One auth-check failure must not hide healthy providers or replace saved/scoped selections | `packages/ai/src/models.ts`, `core/{model-runtime,model-resolver,sdk}.ts` | `packages/ai/test/models-runtime.test.ts`, `model-runtime-auth-options.test.ts`, `model-resolver.test.ts`, `agent-session-dynamic-provider.test.ts` |
| Refresh admission must precede config I/O: awaited scopes follow current per-provider catalog/auth readiness, global availability reads cannot discard credential synchronization or make it join unrelated work, and full-pass auth failures retain provider-local diagnostics and sibling credential filters under scoped overlap | `core/model-runtime.ts` | `model-runtime-refresh-order.test.ts`, `agent-session-dynamic-provider.test.ts`, `model-runtime-credential-sync.test.ts` |
| OAuth state, cancellation and UI failures must retain listener/prompt cleanup | `packages/ai/src/auth/oauth/{callback-server,openai-chatgpt}.ts` | `packages/ai/test/{oauth-callback-server,openai-chatgpt-oauth}.test.ts` |
| Retained payload objects must not mutate Codex continuation baselines | `packages/ai/src/api/openai-codex-responses.ts` | `packages/ai/test/openai-codex-stream.test.ts` |
| Mistral's header deadline must stop after headers with or without a caller signal; caller cancellation must still stop SSE and held-open HTTP-error bodies ([#10609](https://github.com/earendil-works/pi/issues/10609)) | `packages/ai/src/api/mistral-conversations.ts` | `packages/ai/test/mistral-http-transport.test.ts` |
| Failed terminal responses must preserve consumed numeric usage and error details | `packages/ai/src/api/{openai-responses-shared,openai-codex-responses}.ts` | `packages/ai/test/{openai-responses-terminal-event,openai-codex-stream}.test.ts` |
| Astra Ultrafast and legacy Codex Fast estimates need correct tier/confirmation rules | `packages/ai/src/api/{openai-responses,openai-codex-responses}.ts` | `packages/ai/test/openai-ultrafast-pricing.test.ts` |
| Anthropic strict limits apply across initial and inline definitions, including required schemas | `packages/ai/src/api/anthropic-messages.ts` | `packages/ai/test/anthropic-strict-tool-schema.test.ts` |
| Optional nulls inside schema unions must not be coerced into fabricated values | `packages/ai/src/utils/validation.ts` | `packages/ai/test/validation.test.ts` |
| DNS root dots must not bypass `NO_PROXY` | `packages/ai/src/utils/node-http-proxy.ts` | `packages/ai/test/node-http-proxy.test.ts` |
| Fractional/overflowed zero retry delays must not become a minute; completed backoffs must release abort listeners ([#10506](https://github.com/earendil-works/pi/issues/10506)) | `packages/ai/src/utils/retry.ts` | `packages/ai/test/retry.test.ts` |
| Radius gateway pricing must have finite rates and tiers before cost estimation ([#10507](https://github.com/earendil-works/pi/issues/10507)) | `packages/ai/src/providers/radius-config.ts` | `packages/ai/test/radius-provider.test.ts` |
| Abort tests must check the terminal result and follow-up rather than pass early ([#10508](https://github.com/earendil-works/pi/issues/10508)); this is test-only, not a provider cancellation fix | `packages/ai/test/abort.test.ts` | Offline faux-provider case in the same file |
| Chord in-process service hydration must reject non-plain arrays ([#10509](https://github.com/earendil-works/pi/issues/10509)) | `packages/chord/src/delta/revision-validator.ts` | `packages/chord/test/services.test.ts` |
| Codemode string store keys must round-trip as own data properties, including `__proto__` ([#10510](https://github.com/earendil-works/pi/issues/10510)) | `packages/codemode/src/runtime/host.ts` | `packages/codemode/test/sandbox.test.ts` |
| An oversized Env watch change must report `overflow` instead of stopping the daemon's output writer ([#10516](https://github.com/earendil-works/pi/issues/10516)) | `packages/env/daemon/src/watch.rs` | `packages/env/test/remote.test.ts` |
| Equivalent known-hosts path spellings must serialize accept/forget rewrites ([#10517](https://github.com/earendil-works/pi/issues/10517)) | `packages/env/src/ssh.ts`, `packages/env/test/ssh.test.ts` | `packages/env/test/ssh.test.ts` |
| Replayed signatures count toward context estimates | `packages/ai/src/utils/estimate.ts` | `packages/ai/test/context-estimate.test.ts` |
| Dialog input needs xterm printable decoding, grapheme-safe replacement and correct mouse columns | `packages/tui/src/components/input.ts` | `packages/tui/test/{input,mouse-components}.test.ts` |
| Hyperlink control payloads must stay byte-identical | `packages/tui/src/utils.ts` | `packages/tui/test/truncate-to-width.test.ts` |
| Terminal cell-size replies must reach native housekeeping before extension input listeners | `packages/tui/src/tui.ts` | `packages/tui/test/tui-cell-size-input.test.ts` |
| Image coordinate notes need independent unrounded axis ratios | `utils/image-resize.ts` | `image-dimension-note.test.ts` |
| Branch budgets must exclude system declarations not serialized as conversation | `core/compaction/branch-summarization.ts` | `branch-summarization.test.ts` |
| Empty quoted arguments must not shift template positions | `core/prompt-templates.ts` | `prompt-templates.test.ts` |
| Piped input needs separators; whitespace-only input must not start a turn | `cli/initial-message.ts`, `main.ts` | `initial-message.test.ts` |
| Reload must preserve deselected default-active tools while adopting newly configured defaults, including saved `--tools +name/-name` modifiers | `core/agent-session.ts` | `default-tools-setting.test.ts` |
| Extension cancellation must remain observable through post-run recovery and pre-settlement, without replacing the active loop's signal or exposing an idle signal; upstream's `agent_settled.aborted` is captured before clearing that signal | `core/{agent-session,extensions/types}.ts` | `suite/background-command-session.test.ts`, `suite/agent-session-boundaries.test.ts` |
| Repeated context-usage reads must reuse the last scalar without rescanning archived ancestry; native leaf identity and effective model limits preserve compaction, edits, branches and reload/restore behavior | `core/agent-session.ts` | `suite/agent-session-context-usage.test.ts` |
| No-op boundary handlers must not copy archived history for unread previews; mutable nonempty drafts still need eager validation. The undocumented `emitBoundary` preview builder is synchronous so `event.context` can materialize on first read | `core/extensions/runner.ts`, `core/agent-session.ts` | `extensions-runner.test.ts`, `suite/agent-session-boundaries.test.ts` |

The fork also keeps its own delivery tooling: `scripts/install-fork.mjs`, the isolated `./test.sh`,
fork policy text in `AGENTS.md`/`CONTRIBUTING.md`, a macOS CI job for restart and
`background_command`, and no upstream publishing, binary or issue-analysis workflows. Nix builds
follow upstream; its automatic catalog-pin commits and stable-branch promotion are upstream-only.
Contributor approvals remain fork-local; upstream approval-list additions and maintainer-specific
label assignment/reopening rules are not imported.
The fork uses upstream's install lock, not the removed npm shrinkwrap, and keeps its immutable
installer. It uses upstream's pre-commit hook and `npm run check`. Delivery evidence comes from
`./test.sh`, installer/consumer tests, bundle smoke, and Linux/macOS CI; it does not establish live
Windows, Termux-device or hosted Axiom acceptance.

Configuration schemas, shared settings defaults, strict theme validation, and native fake-cursor
markers follow upstream. `SettingsSchema` also describes the fork's `compactView` boolean or
`"hybrid"` preference; settings keep upstream's allowance for extension-owned keys. Hardware
cursor mode draws only the focused terminal cursor, while unfocused fake cursors remain visible.
The published schemas are under `packages/coding-agent/schemas/`.

Package production uses upstream's `scripts/package-artifacts.mjs` and local consumer helpers,
including npm 12's expected-package-keyed pack metadata.
The narrow `scripts/coding-agent-consumer.mjs` packing export remains for pinned fleet automation
until that external caller migrates to the artifact API.

Anthropic native tool changes follow upstream's inline definitions and fixed initial tool list,
including same-name redefinitions. The fork retains request-wide strict-schema budgets and passive
cache tracing. ChatGPT OAuth follows upstream's mandatory callback listener and port-conflict
failure while keeping the fork's cancellation, state validation and cleanup safeguards. Cloudflare
Claude-ID generation already produces canonical IDs upstream. The shared helper also canonicalizes
provider inputs and remote overlays before passthrough/merge; current bundled defaults are not
claimed to be broken.

Program status and prompt-length pricing tiers follow upstream 1.1.0. Kimi K3 keeps
the published $3/M five-minute cache-write rate, including Kimi Coding's implied
estimate ([pricing](https://platform.kimi.ai/docs/pricing/chat)). Claude 5.5 pricing now follows
models.dev metadata, including Sonnet 5.5's $0.10/M cache-read rate.

Cache investigation keeps persistent restart guidance in its existing `context_with_system`
owner, not the user-only run hook. Forced text stays run-scoped and unpersisted. Child
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

After the v1.0.1 sync, the fork carries reviewed leaf patches for YAML 2.9.1, Chalk
6.0.1 and Ignore 7.0.11, with the root and generated installer locks kept together.
Return these pins to upstream when it includes the same or newer fixes. Ignore 7.0.12
is held by the two-day npm release-age gate. Marked 18.0.14 is deferred: its numeric
entity decoding turns `&#27;[2J` into an active terminal escape in Pi's Markdown renderer.
Transport, sandbox, schema, provider SDK and major-version updates remain upstream-led.

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
after a reset on the next prompt. The live PTY RPC-to-TUI handoff (`attach_tui`) is also dropped:
it is Axiom-specific, and Axiom pins `fitchmultz/pi` 7ca602dd and carries its own port. Reference
implementation: 63401a044.

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
release selectable at `<selector>.previous`. Its selector is
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
  shims keep working.
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
