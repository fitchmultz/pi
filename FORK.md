# fitchmultz/pi — personal Pi fork

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi), rebuilt on upstream
v1.0.0. It is upstream plus the features below. Everything else follows upstream behavior and APIs.

## Fork features

| Feature | Implementation | Docs |
| --- | --- | --- |
| Managed restart (`pi restart`, `/restart`) | Launcher/worker split (`src/cli-launcher.ts`, `src/cli/launcher.ts`, `src/cli/restart-protocol.ts`) and the `restart` builtin extension, with small CLI/TUI lifecycle seams | [restart.md](packages/coding-agent/docs/restart.md) |
| `background_command` | `background-command` builtin extension and its worker | [background-command.md](packages/coding-agent/docs/background-command.md) |
| `discover_tools` instruction groups | `instruction-groups` builtin extension (public 1.0 APIs only) | [instruction-groups.md](packages/coding-agent/docs/instruction-groups.md) |
| `read` JSON selection (`json: { path, fields }`) | Core `read` tool patch (`src/core/tools/read.ts`, `read-json.ts`) | [sdk.md](packages/coding-agent/docs/sdk.md#json-selection-with-read) |
| Compact activity view (`compactView: false \| true \| "hybrid"`) | Small interactive-mode renderer patch | [settings.md](packages/coding-agent/docs/settings.md) |
| `pi update --fork` | Updater that builds pinned `fitchmultz/pi` main and activates it through `scripts/install-fork.mjs` (`src/utils/fork-update.ts`, `package-manager-cli.ts`) | [Install and activate](#install-and-activate) |
| Termux (Android) support | Installer compiler/environment handling, `test.sh`, and short Unix-socket paths for restart and the experimental server | [Install and activate](#install-and-activate) |
| Overflow recovery through compaction hooks when nothing is old enough to summarize (Posthorse early and after-reset rollover) | Small core patch: `prepareCompactionForExtension()` (`src/core/compaction/compaction.ts`) plus overflow handling in `_runAutoCompaction()` and `_checkCompaction()` (`src/core/agent-session.ts`) | [compaction.md](packages/coding-agent/docs/compaction.md#session_before_compact) |
| File and credential safety | Atomic auth/settings/journal rewrites, canonical credential locks, UTF-8 and boundary-safe edits, HTML journal guard, and private shell spill logs | [Changelog](packages/coding-agent/CHANGELOG.md#unreleased) |

Owner-approved keeps still being ported (each lands with its own row): opt-in provider credential
isolation (`ignoreStoredCredentials`), GPT-6 Astra Ultrafast pricing, slow-extension diagnostics,
Cloudflare AI Gateway and pi.dev Claude IDs, the fork's native-MCP capabilities on 1.0 MCP,
prompt-cache protections with offline regression gates, the live PTY RPC-to-TUI handoff, and
confirmed credential/data-loss and small bug fixes that 1.0 still lacks.

The fork also keeps its own delivery tooling: `scripts/install-fork.mjs`, the isolated `./test.sh`,
fork policy text in `AGENTS.md`/`CONTRIBUTING.md`, a macOS CI job for restart and
`background_command`, and no upstream publishing, binary or issue-analysis workflows. It uses
upstream's pre-commit hook and `npm run check`.

## Conventions

- Add fork features as builtin extensions in `packages/coding-agent/src/extensions/<name>/`,
  registered in `src/extensions/index.ts`, using public extension APIs.
- Patch core only when no public seam exists. Keep the patch small and list it in the table above.
- Default to upstream architecture. Do not re-add a dropped feature without the owner's approval.
- Behavior covered by upstream replaces the fork version; delete the fork path.

Dropped in the 1.0 rebuild, each confirmed by the owner: working-session checkpoints and safe
sleep, `pi convert-session`, the old session-performance internals, `pi.recordUsage`, atomic
write/edit publication (`publishLocalFile`), `/topview`, Responses web-search metadata, cache-miss
cause details, `forkBranch()`/`getBranchState()`, `ambientAuth`, retry events,
`unregisterCommand`, `preservePending`/`persistOnCancel`, the busy-state helpers,
`getCompactionSettings`, `registerBashCwdHook`, `--session-cwd`, and the sync-upstream,
verify-fork, bench-session, task-cost and profiling scripts.

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
and runs the real-tmux restart test against the installed CLI. The release identity is
`<commit>-<catalog sha256 prefix>-node<version>-<platform>-<arch>`, so the catalog is frozen at
staging time. Before activating, compare its model IDs with the selected release so an upgrade does
not silently downgrade model data. Settings, credentials, sessions and extensions are never
edited. `node scripts/install-fork.mjs --help` lists every option.

Do not run `pi update` (self) on a fork installation: it installs the official npm package over the
selector. If that happens, `--activate` a fork release again.

Running sessions keep their runtime. To load a newly selected release, fully relaunch Pi, or run
`pi restart` from a session that follows the selector. `pi restart --runtime <package dir>` tries
a staged release without selecting it. See [restart.md](packages/coding-agent/docs/restart.md).

`pi update --fork` does the fetch, build, stage and activate steps for you from the latest
`fitchmultz/pi` main. It only updates an existing selector installation and leaves the previous
release selectable at `<selector>.previous`. On Termux the selector is
`~/.local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent` with `~/.local/bin/pi`.

### Cutover from the 0.93 fork

Sessions started by the 0.93 fork must quit and relaunch (`pi -c` or `pi --session <file>`) to run
on 1.0. `/restart` from such a session is refused by the new worker and stays on 0.93. Keep the 0.93
release on disk until the new release is verified; to roll back, `--rollback` (or flip the selector
to `<selector>.previous`) and fully relaunch.

## Testing

- `npm run check` after code changes.
- `./test.sh` runs all non-e2e tests offline in an isolated home; `./test.sh -- <command>` runs a
  focused command the same way. Node and npm resolve before HOME isolation so version-manager
  shims keep working.
- Restart terminal tests need tmux and a built CLI; set `PI_TEST_CLI` to test an installed release.
