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

The commands below describe the current implementation, not permission to run it.
`sync-upstream.sh` can commit, push, and create a PR automatically, including on
`--continue`; do not use it for planning-only work. Implementation, Git delivery,
runtime activation, and paid provider tests require their respective authorization.

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

### Update an existing fork installation

```sh
pi update --fork
```

This fetches `fitchmultz/pi` main once into a temporary checkout, prints and pins
its commit, installs frozen dependencies without lifecycle scripts, hydrates model
data, and delegates build, validation, and selection to that commit's installer.
It needs no existing source checkout. It runs trusted fork code and downloads
from GitHub, npm, and model catalog sources. Running sessions, settings, credentials,
and extensions are unchanged. Failures before selection leave the old runtime
selected; normal success/failure removes the temporary checkout. Fully relaunch Pi
or use a selector-following native restart afterward and verify the loaded identity.

Supported platforms are macOS/Linux/Termux arm64/x64, with Node >=22.19 and npm
installed alongside Node, Git with `archive --mtime` support, bash, tar, gzip, and
tmux. On macOS/Linux the command resolves `npm root -g` using that Node/npm
installation; it never assumes a fixed npm prefix. Termux instead uses the private
`~/.local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent` selector
and `~/.local/bin/pi`, leaving npm's system prefix unchanged. The package must
already be an immutable fork **symlink** resolving to the running Pi package, with
the executable symlink pointing through it to `dist/bundle/cli.js`. The selector
must be writable; `.previous`, if present, must also be a symlink.
Windows, Bun, ordinary npm directories, standalone/managed installers, other
package managers, and mismatched prefixes are rejected rather than migrated.
`--fork` cannot combine with other update targets, positional sources, or `--force`.

For initial setup on another supported machine, use a separate, user-owned prefix
rather than replacing an ordinary npm directory. The one-time setup below is for macOS/Linux and still needs
a checkout; subsequent `pi update --fork` calls do not:

```sh
work=$(mktemp -d)
git clone --depth=1 --branch main https://github.com/fitchmultz/pi.git "$work/pi"
cd "$work/pi"
npm ci --ignore-scripts
npm run hydrate:model-data
unset npm_config_prefix
export NPM_CONFIG_PREFIX="$HOME/.local/share/pi-fork/npm"
selector="$NPM_CONFIG_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent"
node scripts/install-fork.mjs --ref "$(git rev-parse HEAD)" --selector "$selector"
# Only after successful installation; ln refuses to overwrite an existing bin.
mkdir -p "$NPM_CONFIG_PREFIX/bin"
ln -s ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js "$NPM_CONFIG_PREFIX/bin/pi"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
pi --version
```

Keep the prefix and PATH exports in your shell startup configuration. Remove the
temporary checkout after success. If installation fails, stop before creating the
bin symlink. Keep the old installation and fork releases for rollback.
For an existing custom prefix, use the same prefix environment that originally
installed it. Do not point npm at another installation merely to bypass a failure.

### Stage and select a reviewed commit

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
release using the frozen production dependency lock and those local tarballs.
Installed SDK, CLI, extension imports, native checkpoint restore and
real-terminal restart tests must pass before the release receives a validation
receipt. It retains the archive, commit, tarballs and build identity. No
hand-made workspace dependency links are used.

The checkout installer also supports Termux on Android: it preserves the native
shell/exec environment, isolates temporary files, and installs the lockfile-pinned
TypeScript compiler and declaration files into the disposable build. If Android
blocks the Linux compiler's startup fanotify probe, it builds an Android compiler
from the npm artifact's exact source commit, with only that probe disabled (inotify
remains available). Go verifies source/module checksums; the shared module cache
and checkout lockfile are not modified. This fallback requires Go >=1.26, plus
clang on x64 (`pkg install golang clang`). No npm lifecycle scripts are enabled.
macOS/Linux continue using their official compiler artifacts. Restart sockets fall
back to Termux's writable short temporary path when needed. The `pi update --fork`
bootstrap preserves that same native shell/exec environment.

Android blocks hardlinks as well. Session conversion and optional Unix servers use
the native exclusive rename syscall through Python 3's standard library
(`pkg install python`). They fail rather than overwrite a destination or fall back
to a non-atomic move. macOS/Linux keep their hardlink publication path.

The integration uses upstream request-boundary execution and provider transports.
Live native steering, async tool successors, and the parallel native context-window
framework are removed. Steering and follow-up queues still deliver at request
boundaries. Independent cache controls, durable shell jobs, checkpoints, and
managed restart remain; see the [integration policy](#integration-policy).

Cloudflare AI Gateway Claude models use Anthropic's hyphenated IDs in generated
and remote catalogs. models.dev and pi.dev list dotted names, which the gateway's
`/anthropic` passthrough forwards unchanged and Anthropic rejects.

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
selected or Pi is fully launched again. Source/worktree entrypoints and a
release's concrete `dist/bundle/cli.js` stay at their own location.

Restart acknowledgment means queued, not ready. Verify the replacement process,
loaded package directory, same session identity, tools and real provider operation.
Omitting `-e` preserves explicit extensions. A failed or unready candidate
returns to the exact prior worker, extensions and selection policy once; it
does not undo file edits. `/reload` refreshes settings, resources, and extension
code; use a fresh process for core changes or already-loaded package dependencies.
A running older launcher needs one full CLI launch to acquire this behavior;
launcher changes also take effect only at a full launch. See
[Managed Restarts](packages/coding-agent/docs/restart.md).

To return to an earlier installer-validated release, use `--rollback <identity>`
with the same `--selector <path>` used for installation (required for a custom
npm prefix), and an ordinary restart when following the selector. If an explicit runtime is
pinned, use `--runtime <rolled-back-packageDir>` or fully relaunch Pi. Keep
previous runtimes and extension files intact outside explicit pruning. Legacy
releases without receipts remain untouched; their previous selector target is
preserved for manual selection and native startup rollback.

To reclaim space, `npm run install:fork -- --prune --keep <count>` deletes
validated releases older than the newest `<count>`. It keeps the selected and
`.previous` releases, releases a running process visibly uses (open files,
native modules, working directory or command path), and directories without a
receipt, including legacy releases and installations in progress. A session
that loaded only JavaScript through the selector is not visible, so keep enough
releases for running sessions or restart them before pruning.

## Upstream-first policy

Upstream public APIs and architecture are the default. Preserve approved outcomes,
not fork implementations: use equivalent upstream behavior and remove the duplicate
path. Adapt only real approved gaps. Do not disable upstream capabilities to keep
fork internals, or preserve an obsolete API because old tests assert its shape.
Behavior, cache stability, safety, and installed-consumer evidence decide parity.
Ask about material unresolved behavior differences, not settled choices.

This file is the canonical integration policy. Git history records implementation
history; session research notes are supporting evidence, not another policy.

### Integration policy

The previous integration merged all 93 outstanding upstream commits through
`6a4af07d6145c88dad4e3472acebe75cc57af88f` (0.99.1) into fork baseline
`9430ac72ae93952e211afbf95265b607e570cf93`, preserving both ancestries.
The following approved outcomes govern implementation and review. Source integration
does not select a runtime: merging, installation, and paid tests retain separate
authorization and verification gates.

The current integration merged all 12 upstream commits after that target through
`1b347794e2a630e4359f2584f4eea388145d0ddf` into fork baseline
`dfbb1d48cfd8951b3589fc6bb43b57757c369575`, preserving both ancestries.
It includes upstream durable Packages 16–18, the lightweight `pi-ai/models`
entry, and immediate stored-credential availability for native providers.
Experimental durable conversations retain upstream's pinned-turn execution
semantics; ordinary AgentSession tools retain the fork's strict admission guard.
Refreshes of the same definition object with the same executor and owner preserve
execution identity. A fresh definition object/receiver or changes to the executor,
owner, arguments, schema, sampling, or execution mode revoke prepared calls.
Description overrides retain live bindings, including caller-supplied base tools.
Reload aborts active work and replaces its runner. Native extension
resolution accepts iterable conditions on the declared Node floor.
The durable root graph budget accounts for the one extra `pi-ai/utils/estimate`
module used by the fork's bounded declaration retention; upstream's forbidden
barrels and provider dependencies remain forbidden.

| # | Approved outcome and boundary |
| --- | --- |
| 1 | Adopt upstream public namespace/name APIs and migrate internals; no competing public registry or compatibility union. |
| 2 | Integrate first-class upstream MCP, codemode, search, registry, OAuth, resources, and CLI. Assess the separate adapter independently; do not change personal server/auth configuration. |
| 3 | Remove live native steering, async tools, automatic successors, and detach/resume core machinery. Use upstream request-boundary execution; keep independent stateless cache controls. |
| 4 | Use upstream-based, summary-free Posthorse rollover, with a targeted early/after-reset overflow fix. Do not retain a parallel native context-window framework. |
| 5 | Preserve durable background shell jobs, status, logs, survival across Pi exit, and completion delivery through ordinary receipts/messages. |
| 6 | Preserve working-session checkpoints and safe sleep: exact queues, tool selection, ingress, quiescence, and refusal behavior. Adapt to upstream without retired native fields; do not promise arbitrary process or draft serialization. |
| 7 | Preserve managed restart, safe-boundary and pending-input protection, and one-attempt rollback after failed startup. |
| 8 | Convert settled old sessions once into new copies, preserving originals. Refuse unsafe in-flight or uncertain work and never replay it. Resume through a fresh provider request, not live continuation; no permanent old runtime. |
| 9 | Preserve targeted cache protections around upstream with offline regression gates. Budget live cache-hit/latency checks separately; bound retained history and allow resets required by correctness, security, provider/schema changes, or rollover. |
| 10 | Preserve grouped on-demand full instructions at extension level through upstream APIs; remove the duplicate core group registry. Discovery must not automatically widen callable permissions. |
| 11 | Preserve an optional compact-density view on upstream rendering, including nested codemode, images, cards, and themes. |
| 12 | Restore upstream extension-code `/reload`; keep managed restart separately for core or clean-process changes, with lifecycle and cache safeguards. |
| 13 | Preserve background subagent usage/cost attribution without an explicit wait; deduplicate later result accounting. |
| 14 | Preserve live PTY RPC-to-TUI handoff and return on upstream RPC; ordinary pipes cannot attach. |

Posthorse uses its official-host compaction-hook path for summary-free rollover.
The host offers early and after-reset overflow recovery without native context-window
primitives. Qualify the exact emitted host and extension revisions together; stock
host limitations or a version string alone do not identify this integration.

Grouped instructions are a replaceable builtin extension, not a core registry.
CLI sessions include it; SDK consumers opt in with `instructionGroupsExtension`.
Discovery delivers owner-supplied full instructions and never expands callable
permissions. Same-batch use is refused until an instruction-bearing request has
occurred. See [extensions](packages/coding-agent/docs/extensions.md).

Native MCP provides lazy-by-default connections with explicit eager profiles,
account-bound catalogs, scoped discovery, resources, prompt commands, browser
OAuth, and complete hook-permitted result artifacts. The separate adapter remains
independently managed for other hosts and capabilities such as MCP Apps,
elicitation, and additional transports and auth flows. Its `/mcp` command replaces
the builtin session connector; configuration, credentials, and names are not
transparently shared. The builtin `pi mcp` CLI offers explicit copy-only adapter
import. This integration does not cut over personal servers or credentials,
remove the adapter, or qualify separately deployed profiles. See
[MCP](packages/coding-agent/docs/mcp.md#extensions-and-sdk-hosts).

Old native-window sessions require the standalone
[`pi convert-session`](packages/coding-agent/docs/session-format.md) command before
resuming in this runtime. Conversion writes a new file, preserves the original,
and refuses unsafe or ambiguous work. Stop the old session writer first; do not
restart a live old-format session directly into this runtime.

### Continuing contracts

The active-path index is keyed by entries revision and leaf. Child appends extend
it in O(1); navigation, reload and validated reconciliation rebuild it once.
Bounded newest-first metadata queries scale with entries visited, while complete
branch/tree/export results remain output-sensitive. Retained metadata strings
are detached from journal-line backing storage on both scan and append.

Context-usage cache hits inspect shallow message/tool array and element identities,
internal message revisions, journal/branch state, prompt options, model and usage
anchor, never archived payloads. SDK messages and tools are immutable inputs:
replace edited objects or arrays; nested in-place edits are not observed until
replacement, `refreshContext()` after journal changes, or another tracked change.
Provider usage applicability follows canonical entry identity, retaining the
reported baseline when context handlers alter the sent payload. Heuristic
fallback counts opaque signatures and schemas and uses session-local comparable
input-density samples (`4 × request estimate / (input + cacheRead + cacheWrite)`)
with chars/token clamped to [1, 4], default 4; output tokens do not calibrate input.
Unknown post-compaction usage
remains unknown for display, not for internal preflight.

Persisted context projections retain at most 16 MiB of pristine serialized active
record bodies; each projection decodes its own mutable messages. Compaction and
branch changes discard inactive cache records, while archived payloads remain lazy.
Journal generation and digest checks still reject changed history; external source
changes require validated reconciliation, not an unchecked append-tail shortcut.
Request provenance excludes admitted but unpersisted input. Unchanged boundary
previews lazily reuse the projection with independent per-handler messages and
freshly read queues; automatic compaction's full `branchEntries` is lazy.
Handler-free `emitContext` passes through request-owned messages without cloning;
idle background monitoring reuses immutable receipt IDs until journal revision or
session identity changes. These optimizations do not change provider payloads,
input persistence timing, completion acknowledgement, or runtime selection.

Extension event handlers exceeding 100 ms and custom footer renders exceeding
16 ms produce one non-fatal diagnostic per loaded extension and kind. Timing
includes awaited time, does not cancel work or alter handler results, and uses
the existing interactive, print and RPC extension diagnostic paths.

Session performance work is consolidated in PR #162; PR #163 is superseded, not
an additional merge. One bounded serialized cache serves context projection,
including #163's selective payload reads. Independent `forkBranch()` siblings and
writer-derived indexes retain exclusive publication and fsync. Every published
record and LF separator is verified before index adoption; mismatches rebuild
from authoritative bytes. Borrowed unpublished siblings retain their source
identity for validation. The consolidation keeps #162's provenance, append/retry,
receipt, catalog, and Codex protections rather than replacing them with the
alternative decoded-body cache.

OpenAI Responses (API keys and Sign in with ChatGPT) and legacy Codex Responses
price exact `gpt-6-astra` at 6x standard only when the terminal response confirms
`service_tier: "ultrafast"`. This includes every input, cached-input, cache-write,
and output component after standard long-context pricing is selected. Missing,
unknown, or `default` returned tiers do not confirm Ultrafast; existing Fast,
priority, and flex fallback behavior is unchanged. Sol preview is not included.
The 8x included-allowance consumption rate is not a monetary estimate.
Sources: [Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode)
and [pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=ultrafast),
verified September 29, 2026.

The pinned OpenAI SDK already accepts `ultrafast`. Inspect requested
`service_tier` through `onPayload` (`before_provider_request` in extensions) and
returned `response.service_tier` through `onProviderStreamEvent`
(`provider_stream_event` in extensions). These existing raw hooks preserve absent
and unknown values without treating them as confirmation. They are not persisted
tier metadata. Direct OpenAI uses HTTP/SSE; legacy Codex supports SSE and WebSocket.
No retired diagnostic whitelist, transport, header, or new configuration is needed.

The target does not waive these independent outcomes. Reuse upstream equivalents
where available; adapt existing tests to the chosen behavior rather than retaining
old machinery solely to keep tests unchanged.

| Outcome | Verification |
| --- | --- |
| Newly delivered queued images normalize like idle prompts | Queue/admission tests prove one awaited normalization without races. |
| Structured JSON read extraction | JSON path/field extraction occurs before output limits. |
| Provider startup refresh, ambient authentication, opt-in stored-credential isolation | Refresh, credential selection, availability, and failure-isolation tests. |
| Atomic local file publication and durable external usage | Publication failure safety, journal persistence, and deduplicated billing tests. |
| Frozen fork delivery and immutable installation | Reviewed merge ancestry, frozen locks/catalogs, installer tests, installed-consumer and platform qualification, rollback. |
| Offline provider tests by default | Isolated tests hide ambient provider credentials; live tests require explicit authorization, including `PI_LIVE_PROVIDER_TESTS=1` where applicable. |

### Integration and documentation checklist

- Keep the main worktree untouched during integration; preserve merge ancestry,
  reviewed resolutions, frozen dependency/model inputs, and immutable rollback.
  Verification must not rewrite tracked inputs. Do not invoke remote CI unless asked.
- Trace each approved outcome through callers, extensions, persistence, provider
  serialization, and UI. Remove superseded code and update behavior tests in the
  same change. Prove conversion preserves originals and refuses unsafe work without
  replay; prove checkpoint/restart admission and pending-input safety.
- Gate cache changes on rendered payload/prefix regressions, independently of live
  steering or async execution. Offline evidence is not a measured provider cache
  hit. Validate additions, removals, description/reactivation changes, inline
  Anthropic schemas, between-request effort, historical hidden loadouts, and
  immutable Codex snapshots where retained; bound history and document resets.
- Validate the actual installed consumer, worker and WASM assets, and tmux UI
  lifecycle, including reload disposal/reinitialization, background accounting,
  compact rendering, and PTY handoff. Qualify supported platforms separately;
  TypeScript 7 uses a disposable compiler on Termux, with a pinned-source Android
  build when its Linux artifact is blocked; fixture validation is not qualification
  on real Termux hardware.
- Update operational product docs alongside implementation, not before it:
  extension/name/discovery SDK and event contracts; JSON/message/session formats
  and conversion; compaction/Posthorse; model/cache/WebSocket behavior; reload,
  restart, slash commands, packages, providers, and RPC; checkpoints, background
  accounting, handoff, and user entrypoints. Update injected restart guidance in
  `packages/coding-agent/src/cli/restart-worker.ts` at that same cutover.
- Record exact tested revisions and remaining gaps in delivery evidence. Do not
  turn design approval or offline checks into runtime, platform, or live-cache
  qualification. Preserve frozen artifact identities through installation.

Experimental Pico/micro remain opt-in; ordinary AgentSession extensions use the
normal host. Install stock Pi separately if needed and verify before selecting it.
Preserve fork releases and sessions.
