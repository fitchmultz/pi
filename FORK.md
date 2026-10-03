# fitchmultz/pi — personal Pi fork

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi), rebuilt on upstream
v1.0.0 and synchronized through upstream v1.0.1 `4c6fb7cfe` (2026-10-03). It is upstream plus the features
below. Everything else follows upstream behavior and APIs.

## Fork features

| Feature | Implementation | Docs |
| --- | --- | --- |
| Managed restart (`pi restart`, `/restart`) | Launcher/worker split (`src/cli-launcher.ts`, `src/cli/launcher.ts`, `src/cli/restart-protocol.ts`) and the `restart` builtin extension, with small CLI/TUI lifecycle seams | [restart.md](packages/coding-agent/docs/restart.md) |
| `background_command` | `background-command` builtin extension and its worker | [background-command.md](packages/coding-agent/docs/background-command.md) |
| `discover_tools` instruction groups | `instruction-groups` builtin extension (public 1.0 APIs only); enabling a group adds tools positionally so Responses/Codex prompt-cache prefixes stay stable | [instruction-groups.md](packages/coding-agent/docs/instruction-groups.md) |
| `read` JSON selection (`json: { path, fields }`) | Core `read` tool patch (`src/core/tools/read.ts`, `read-json.ts`) | [sdk.md](packages/coding-agent/docs/sdk.md#json-selection-with-read) |
| Compact activity view (`compactView: false \| true \| "hybrid"`) | Small interactive-mode renderer patch | [settings.md](packages/coding-agent/docs/settings.md) |
| `pi update --fork` | Updater that builds pinned `fitchmultz/pi` main and activates it through `scripts/install-fork.mjs` (`src/utils/fork-update.ts`, `package-manager-cli.ts`) | [Install and activate](#install-and-activate) |
| Termux (Android) support | Installer compiler/environment handling, `test.sh`, and short Unix-socket paths for restart and the experimental server | [Install and activate](#install-and-activate) |
| File and credential safety | Atomic auth/settings/journal rewrites, canonical credential locks, UTF-8 and boundary-safe edits, HTML journal guard, and private shell spill logs | [Changelog](packages/coding-agent/CHANGELOG.md#unreleased) |
| Provider correctness fixes | Provider-local auth availability and saved/scoped selection, OAuth cleanup, detached Codex continuation, Responses terminal usage, Anthropic strict budgets, schema validation, proxy exclusions, retry delays, and signature token estimates | [AI changelog](packages/ai/CHANGELOG.md), [coding-agent changelog](packages/coding-agent/CHANGELOG.md) |
| Opt-in provider credential isolation (`ignoreStoredCredentials`) | Credential-read adapter in `src/core/model-runtime.ts` plus registration types; used by account-routing extensions | [custom-provider.md](packages/coding-agent/docs/custom-provider.md) |
| Complete native working-session save/resume | One native admission/hold and complete-state codec, mode/builtin readiness bindings, conditional private Unix socket and final-worker launcher attestation | [working-session.md](packages/coding-agent/docs/working-session.md) |
| Provider-scoped auth fallback | Ephemeral fallback composed with the effective `ModelRuntime` provider; native auth precedence, catalogs and transport retained | [custom-provider.md](packages/coding-agent/docs/custom-provider.md#supply-fallback-authentication-without-replacing-a-provider) |
| GPT-6 Astra Ultrafast and Codex Fast cost estimates | Service-tier pricing in `packages/ai/src/api/openai-responses.ts` and `openai-codex-responses.ts` | [models.md](packages/coding-agent/docs/models.md) |
| Slow-extension diagnostics (handler over 100 ms, footer render over 16 ms) | Timing at handler dispatch and extension footers in `src/core/extensions/runner.ts` | [extensions.md](packages/coding-agent/docs/extensions.md) |
| Temporary passive cache investigation | Opt-in private HMAC recorder at native send/usage boundaries, SDK provenance, and read-only `scripts/cache-trace-report.mjs`; no provider probes or cache-policy changes | [cache-tracing.md](packages/coding-agent/docs/cache-tracing.md) |
| Cloudflare AI Gateway Claude IDs | `normalizeCloudflareModelId()` in `packages/ai/src/api/cloudflare.ts`, used by the generator, the provider and remote catalogs | [providers.md](packages/coding-agent/docs/providers.md) |
| Small confirmed fixes | TUI input, keys and links; resized-image coordinate notes; branch-summary budgets; prompt-template and piped-input handling | [Changelog](packages/coding-agent/CHANGELOG.md#unreleased) |

The fork also keeps its own delivery tooling: `scripts/install-fork.mjs`, the isolated `./test.sh`,
fork policy text in `AGENTS.md`/`CONTRIBUTING.md`, a macOS CI job for restart and
`background_command`, and no upstream publishing, binary or issue-analysis workflows. Nix builds
follow upstream; its automatic catalog-pin commits and stable-branch promotion are upstream-only.
The fork uses upstream's install lock, not the removed npm shrinkwrap, and keeps its immutable
installer. It uses upstream's pre-commit hook and `npm run check`.

Anthropic native tool changes follow upstream's inline definitions and fixed initial tool list,
including same-name redefinitions. The fork retains request-wide strict-schema budgets and passive
cache tracing. ChatGPT OAuth follows upstream's mandatory callback listener and port-conflict
failure while keeping the fork's cancellation, state validation and cleanup safeguards. Cloudflare
Claude-ID normalization remains necessary for older bundled and remote catalogs; the generator
shares that helper rather than duplicating upstream's replacement.

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

Open the PR with `gh pr create --repo fitchmultz/pi`, wait for green CI, review, and merge.
CI is the upstream workflow plus tmux, so the real-terminal restart test runs, and a macOS job
runs the restart and `background_command` tests.

## Install and activate

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
catalog is frozen at staging time. Before activating, compare its model IDs with the selected
release so an upgrade does not silently downgrade model data. Settings, credentials, sessions and
extensions are never edited. `node scripts/install-fork.mjs --help` lists every option.

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

### Cutover from the 0.99 fork

Do the first 1.0 install from a fork checkout (`npm ci --ignore-scripts`,
`npm run hydrate:model-data`, then
`node scripts/install-fork.mjs --selector "$(npm root -g)/@earendil-works/pi-coding-agent"`, so it
activates the selector that `pi` and `pi update --fork` use; on Termux omit `--selector`). A 0.99
`pi update --fork` holds `<selector>.lock` while it runs the 1.0 installer, which needs the same
lock, so it fails with `Lock file is already being held` and changes nothing. Later updates can use
`pi update --fork`.

Sessions started by the 0.99 fork must quit and relaunch to run on 1.0. `/restart` from such a
session is refused by the new worker and stays on 0.99. Relaunch with `pi --session <path|id>`:
`pi -c` opens the directory's most recently modified session, which can be another live session
when several share the directory. Keep the 0.99 release on disk until the new release is verified;
to roll back, `--rollback` (or flip the selector to `<selector>.previous`) and fully relaunch.

## Testing

- `npm run check` after code changes.
- `./test.sh` runs all non-e2e tests offline in an isolated home; `./test.sh -- <command>` runs a
  focused command the same way. Node and npm resolve before HOME isolation so version-manager
  shims keep working.
- Restart terminal tests need tmux and a built CLI; set `PI_TEST_CLI` to test an installed release.
