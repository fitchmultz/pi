# fitchmultz/pi — custom Pi fork

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi).

## Remotes and history

- `origin`: upstream `earendil-works/pi`; fetch only.
- `fork`: personal `fitchmultz/pi`; reviewed delivery.
- Local `main` tracks `fork/main`, with `branch.main.rebase=false`.
- Merge upstream normally. Preserve custom ancestry; never rebase or force-push it.

Main protection blocks force pushes and deletion. Verification runs locally against
frozen source and model data. Git delivery and runtime activation are separate.
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
require passing local verification for the final revision before merging. Merge
approval remains a separate decision. Keep the main checkout untouched and remove
unused task worktrees when no active work depends on them. Preserve reviewer
evidence and session journals.

## Verification and frozen inputs

```sh
npm ci --ignore-scripts
npm run hydrate:model-data               # once when preparing a new snapshot
npm run verify:fork                      # full verification
npm run verify:fork -- --suite runtime   # focused native lifecycle verification
```

Full verification checks the hydrated catalog, builds offline, runs nonmutating
checks and isolated tests against the real bundled CLI. Runtime verification
builds offline and runs focused restart and checkpoint tests without repeating
the platform-independent checks. tmux is required; terminal coverage cannot
silently skip. Use `./test.sh` for the complete isolated suite and
`./test.sh -- <command...>` for focused tests. Node/npm resolve before HOME
isolation so version-manager shims do not lose their installation. `npm run format` is the
explicit formatting command; hooks never format or restage files.

CI runs Linux Node 22.19 full verification on PRs, main and manual dispatch.
macOS Node 24 runs focused runtime verification on PRs and manual dispatch.
Each lane hydrates model data independently, so they verify the same commit
against potentially different live catalog data. CI uploads no source artifact.
Local installation freezes its own commit and hydrated catalog. Intentional
generator changes belong in the reviewed Git diff; verification must not
regenerate tracked inputs.

## Immutable installation and activation

Hydrate model data in the checkout, then stage the exact reviewed commit. If
merging changes the commit ID, stage and validate the merged commit before
activation.

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
commit=$(git rev-parse HEAD)
npm run install:fork -- --ref "$commit" --stage
```

The installer creates a source archive from that Git commit and the checkout's
already-hydrated model data; it does not fetch or regenerate metadata. An
optional `--source-archive` reuses a separately frozen archive with an adjacent
`source.commit`, checking its source tree against the selected commit. The
installer validates model data, builds in a temporary source directory, packs
native workspace tarballs and installs a production npm consumer into a new
release. Installed SDK, CLI, extension imports, native checkpoint restore and
real-terminal restart tests must pass before the release receives a validation
receipt. It retains the archive, commit, tarballs and build identity. No
hand-made workspace dependency links are used.

Releases live under `~/.local/share/pi-fork/releases/<identity>`, where identity
includes the commit, catalog digest, Node version, platform and architecture.
Existing releases are never rebuilt or overwritten. Deployed delivery uses the
locally qualified frozen archive.

Select the printed identity, then restart through the installed `pi` command:

```sh
npm run install:fork -- --activate <identity>
pi restart --message "Verify the selected runtime and continue"
```

Without `--stage`, installation validates and selects in one command. Selection
atomically replaces the package symlink under `~/.local/share/npm-global`; the
previous target is retained at that symlink's `.previous` sibling. Settings,
credentials, extensions and real session journals under `~/.pi` are unchanged.
Never use `npm link` to select a mutable checkout.

An ordinary restart re-resolves the original installed package symlink, so it
loads a newly selected release even when its version string is unchanged.
Use `pi restart --runtime <printed-packageDir>` only to try a staged release
without changing the selector or to deliberately pin that concrete worker.
The pin survives later ordinary restarts until another explicit runtime is
selected or Pi is fully launched again. Source/worktree and direct release
launches stay at their own location.

Restart acknowledgment means queued, not ready. Verify the replacement process,
loaded package directory, same session identity, tools and real provider operation.
Omitting `-e` preserves explicit extensions. A failed or unready candidate
returns to the exact prior worker, extensions and selection policy once; it
does not undo file edits. `/reload` does not apply code changes. A running older
launcher needs one full CLI launch to acquire this behavior; launcher changes
also take effect only at a full launch. See
[Managed Restarts](packages/coding-agent/docs/restart.md).

To return to an earlier installer-validated release, use `--rollback <identity>`
and an ordinary restart when following the selector. If an explicit runtime is
pinned, use `--runtime <rolled-back-packageDir>` or fully relaunch Pi. Keep
previous runtimes and extension files intact. Legacy releases without receipts
remain untouched; their previous selector target is preserved for manual
selection and native startup rollback.

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
| Native async tools, steering and automatic Responses successors | `native-async*`, `native-steering`, `astra-native-protocol` and native session/context usage tests | Upstream preserves original-call durability, successor input snapshots and measured context through the same lifecycle. |
| Exact tool namespaces and client-side discovery | Tool identity/search/namespace, retained projection and native renderer/export tests | Upstream keeps registered, wire and displayed identities consistent across discovery, execution and replay. |
| Atomic local file publication and durable external usage | Publication, `extension-record-usage`, persistence and checkpoint billing tests | Upstream provides the same publication and journal accounting guarantees. |
| Safe fork delivery with frozen inputs and immutable installation | Sync/installer script tests, local platform qualification and installed runtime smoke | Upstream tooling supports this fork's separate review, delivery and activation workflow. |

Experimental Pico/micro remain opt-in; ordinary AgentSession extensions use the
normal host. Install stock Pi separately if needed and verify before selecting it.
Preserve fork releases and sessions. Posthorse requires the fork's native context
window primitives and is not supported by the stock host.
