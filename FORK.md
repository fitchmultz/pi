# fitchmultz/pi — custom Pi fork

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi).

## Remotes and history

- `origin`: upstream `earendil-works/pi`; fetch only.
- `fork`: personal `fitchmultz/pi`; reviewed delivery.
- Local `main` tracks `fork/main`, with `branch.main.rebase=false`.
- Merge upstream normally. Preserve custom ancestry; never rebase or force-push it.

Native main protection requires `build-check-test`, an up-to-date branch, and
blocks force pushes and deletion. Git delivery and runtime activation are separate.
No fork maintenance command publishes packages or upstream releases.

## Updating from upstream

```sh
./sync-upstream.sh                       # pin upstream origin/main
./sync-upstream.sh --ref <upstream-ref>   # pin a branch, tag or commit
```

The command fetches the upstream target once and creates a task branch from
`fork/main` under `../worktrees/pi/`, relative to the main checkout's parent.
It never merges into the invoking checkout or changes the installed runtime.
Repo-local rerere records resolutions, with automatic staging disabled.

A clean merge proceeds through frozen dependency installation, explicit provider
registry generation, model-data hydration, verification, commit and PR creation.
Conflicts preserve the native merge and print its exact worktree and resume command.
Review each resolution and stage its explicit paths, then run:

```sh
./sync-upstream.sh --continue <worktree>
```

Continuation retains the pinned target even if upstream advances. Failed
verification leaves the merge available for correction and another continuation.
After ordinary reviewer-fix commits, republish with `--pr <worktree>`. Run local
GPT, Ponytail and Claude reviewers after PR creation; fix or rebut findings and
require green CI before merging. Merge approval remains a separate decision.
After merging, fast-forward local `main` to `fork/main` and remove unused task
worktrees. Preserve reviewer evidence and session journals.

## Verification and frozen inputs

```sh
npm ci --ignore-scripts
npm run hydrate:model-data               # once when preparing a new snapshot
npm run verify:fork                      # full verification
npm run verify:fork -- --suite runtime   # focused native lifecycle verification
```

Verification checks the existing catalog, builds offline, runs nonmutating checks,
and runs isolated tests against the real bundled CLI. tmux is required; terminal
coverage cannot silently skip. Use `./test.sh` for the complete isolated suite or
`./test.sh -- <command...>` for focused tests. Node/npm resolve before HOME
isolation so version-manager shims do not lose their installation. `npm run format`
is the explicit formatting command; hooks never format or restage files.

CI hydrates once and freezes the commit plus ignored model data using the existing
source archive helper. Linux Node 22.19 full validation and macOS Node 24 runtime
validation consume that same archive. The required `build-check-test` aggregates
both lanes. The `fork-source-<commit>` artifact retains `source.tar.gz` and
`source.commit` for 30 days. Intentional generator changes belong in the reviewed
Git diff; validation must not regenerate tracked inputs.

## Immutable installation and activation

After merging, wait for the merged main commit's CI and download its frozen input:

```sh
gh-personal run download <main-CI-run-id> --repo fitchmultz/pi \
  --name fork-source-<merged-commit> --dir /path/to/frozen-source
npm run install:fork -- --ref <merged-commit> \
  --source-archive /path/to/frozen-source/source.tar.gz --stage
```

The installer checks the adjacent `source.commit` and compares the extracted
source against that Git tree using a temporary index, allowing only the frozen
model-data files in addition. It validates that data, builds in a temporary source
directory, packs native workspace tarballs, and installs a
production npm consumer into a new release. Installed SDK, CLI, extension imports,
native checkpoint restore and real-terminal restart tests must pass before the
release receives a validation receipt. It retains the archive, commit, tarballs
and build identity. No hand-made workspace dependency links are used.

Releases live under `~/.local/share/pi-fork/releases/<identity>`, where identity
includes the commit, catalog digest, Node version, platform and architecture.
Existing releases are never rebuilt or overwritten. Without `--source-archive`,
local staging uses the exact Git ref and the checkout's already-hydrated catalog;
it does not fetch or regenerate metadata. Deployed delivery uses the CI artifact.

Select the printed identity, then activate its printed package directory:

```sh
npm run install:fork -- --activate <identity>
pi restart --runtime <printed-packageDir> \
  --message "Verify the updated runtime and continue"
```

Without `--stage`, installation validates and selects in one command. Selection
atomically replaces the package symlink under `~/.local/share/npm-global`; the
previous target is retained at that symlink's `.previous` sibling. Settings,
credentials, extensions and real session journals under `~/.pi` are unchanged.
Never use `npm link` to select a mutable checkout.

Restart acknowledgment means queued, not ready. Verify the replacement process,
loaded package directory, same session identity, tools and real provider operation.
Omitting `-e` preserves explicit extensions. `/reload` does not apply code changes.
Launcher changes take effect at the next full CLI launch. See
[Managed Restarts](packages/coding-agent/docs/restart.md).

To return to an earlier installer-validated release, use `--rollback <identity>`
and native restart with its package directory. Keep previous runtimes and extension
files intact. Legacy releases without receipts remain untouched; their previous
selector target is preserved for manual selection and native startup rollback.

## Fork patch intent

Keep patches at native boundaries and remove them when upstream provides the same
behavior and passes the corresponding contracts. The table identifies continuing
intent; Git history remains the detailed change record.

| Intent | Contract / verification | Removal condition |
| --- | --- | --- |
| Fresh context windows without losing journal history | `interactive-context-window`, `context-window-system-state` tests | Upstream exposes equivalent context-window primitives used by Posthorse. |
| Native checkpoint and managed restart, including tool selection and pending UI input | `checkpoint*`, `restart-*`, `interactive-shutdown-admission` tests; checkpoint/restart docs | Upstream round-trips the same session state and passes bundled lifecycle tests. |
| Normalize newly delivered queued images like idle prompts | `agent-session-queued-images`, queue/admission/checkpoint suites | Upstream normalizes once at an awaited delivery boundary without queue races. |
| Structured JSON read extraction | `read-json.test.ts` | Upstream supports the same JSON path/field extraction before output limits. |
| Provider startup refresh and ambient account authentication | `provider-startup-refresh`, `ambient-auth`, `model-runtime-auth-options`, availability tests | Upstream preserves refresh, credential selection and failure isolation contracts. |
| Safe fork delivery with frozen inputs and immutable installation | Sync/installer script tests, required CI and installed runtime smoke | Upstream tooling supports this fork's separate review, delivery and activation workflow. |

Experimental Pico/micro remain opt-in; ordinary AgentSession extensions use the
normal host. Install stock Pi separately if needed and verify before selecting it.
Preserve fork releases and sessions. Posthorse requires the fork's native context
window primitives and is not supported by the stock host.
