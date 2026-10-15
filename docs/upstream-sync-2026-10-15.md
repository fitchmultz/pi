# Upstream integration — 2026-10-15

## Scope

Integrates upstream `5ab7fe74c400097b386662205cd93900695b8a71` (14 commits)
into fork baseline `b1823574b565f37628e6a4b92a30796079bbc4d4`.
The common ancestor is `9fe3f371622cad9cc1a3cbf044288abd0252192f`.
This work prepares a fork PR; it does **not** merge, select a runtime, refresh the
primary checkout, or mutate upstream issues or PRs.

## Actual divergence and reachable workflows

Before editing, the ancestor-to-fork tree diff contained 415 paths, +38,138/-6,010
lines. This is not all production code:

| Category | Paths | Added | Deleted |
| --- | ---: | ---: | ---: |
| Production package source | 142 | 10,139 | 3,393 |
| Tooling, configuration, manifests and locks | 54 | 2,527 | 1,979 |
| Tests, fixtures and conformance support | 176 | 22,848 | 543 |
| Documentation, guidance and performance evidence | 43 | 2,624 | 95 |

Reproduce the raw inventory with:

```sh
git diff --numstat 9fe3f371622cad9cc1a3cbf044288abd0252192f \
  b1823574b565f37628e6a4b92a30796079bbc4d4
```

Classification precedence: `/test/`, `.test.`, `/src/testing/` and
`scripts/performance/fixtures/` are test support; remaining `/src/` and
`/daemon/src/` paths are production; Markdown, `docs/`, `.pi/prompts/` and
`.pi/skills/` are documentation; the remainder is tooling. Ignored hydrated
provider data is measured separately, not included in Git line counts.

[FORK.md](../FORK.md#fork-features) is the maintained capability/owner/test map.
The source trace also covered the supporting callers, not just feature names:

| User entry point | Required path and contract | Verification owner |
| --- | --- | --- |
| CLI/TUI restart and SDK/CLI full-state save/restore | Launcher admission, Agent queues, settings/resources, bounded private artifact I/O; exact native handoff without replay | `restart-*`, `suite/working-session*` |
| Detached shell work | Builtin tool → durable worker/logs → idle/batch completion; cancellation and delivery survive exit | `background-command*`, bundle smoke |
| Browser/macOS discovery and eager fallback | Collector, prior-turn instruction gate, selected-tool suppression, branch replay and positional declarations | `suite/instruction-groups`, `suite/prompt-cache-prefix` |
| JSON reads, native edits and compact TUI | Native factories, shared Durable edit policy, native card renderers/settings | `read-json`, `edit-byte-safety`, `compact-view` |
| Model selection/auth, scoped refresh and cache diagnosis | Credential isolation/fallback, saved selection, scoped readiness, passive tracing and cache estimates | Model-runtime/auth/cache suites |
| Immutable update and standalone extensions | Frozen catalogs, owned release store/rollback, public package imports and disabled project preloads | Installer/updater tests, consumer installs, compiled-extension test |
| Chord, Durable, Env, MCP, Codemode, eval and telemetry consumers | Exported protocol/storage/daemon/SDK boundaries, including JSON used by working-state artifacts | Respective package suites and public consumers |

Upstream did not modify coding-agent production code in these 14 commits. It
cannot replace the fork's restart, persistence, background jobs, discovery,
compact view or auth seams. Other retained correctness/performance owners remain
listed in [FORK.md](../FORK.md#retained-correctness-deltas). No deletion quota was
used.

## Reuse and measured comparisons

- **Chord reference admission:** upstream rejects foreign/expired/fabricated
  contexts and preserves holder/factory/root behavior. All eight fork regression
  cases were run against the incoming implementation before deleting the fork
  helper and type coupling. Fork-specific admission policy changed lines went
  from **63 (+25/-38) to 0**. This measures maintenance divergence, not runtime
  speed or total Chord size. The stronger regression matrix remains.
- **Output buffering:** adopted upstream's relocation to public
  `@earendil-works/chord/output`; its public UTF-8 helper also backs Durable's
  internal truncation utilities.
  The old output implementation plus truncate helper was 546 lines; the new
  combination is 557. This is shared ownership, **not** a fork-size or speed
  improvement. Coding-agent's private spill/backpressure accumulator is a
  different contract and remains.
- **SQLite:** added upstream namespaces to every retained fork query; preserved
  unchanged-write avoidance and reduced document reads. The existing 1 MiB,
  30-write fixture produced identical before/after results:

  | Workload | SQL calls, before → after | Bound string bytes, before → after | WAL growth, before → after |
  | --- | ---: | ---: | ---: |
  | Document deltas | 150 → 150 | 771 → 771 | 494,400 → 494,400 |
  | Unchanged documents | 0 → 0 | 0 → 0 | 0 → 0 |
  | Task checkpoint replacements | 120 → 120 | 31,463,931 → 31,463,931 | 1,928,160 → 1,928,160 |

  Both runs used input SHA-256
  `5402401ff8f95ddf7b342842d7dba8740fec905ec26b79ace373add21bd682c1`
  and produced `e9385dee6a654e0abc54c192f5ec9675c9150e2c7815a2001d044dc2ba516993`.
  No latency improvement is claimed. Reproduce on either checkout:

  ```sh
  ./test.sh -- env PI_PERF_REPO="$PWD" node --conditions=source \
    --import "$PWD/scripts/performance/source-hook.mjs" \
    "$PWD/scripts/performance/fixtures/durable-storage.ts" 1024 30
  ```

- **Image regression consolidation:** extended upstream's payload test with the
  fork's image-only-error and input-nonmutation guarantees, then removed the
  duplicate old omission fixture. Combined test source is 247 → 163 lines;
  this is test maintenance reduction, not production performance.
- **Models:** fresh hydration contains 1,609 chat models and 1,706 typed entries.
  Compared with the pre-edit hydrated snapshot: zero IDs added or removed,
  nine metadata entries changed. Model bytes are ignored build inputs; the
  ordinary immutable installer will freeze them when this PR is merged and
  staged. No unmerged runtime was activated.

## Proven failures

### Newly encountered Chord hydration-release hang

A stateful view and a `state: false` method caller share one remote binding.
After the shape arrives but before all snapshots, releasing the last stateful
view leaves the method caller loading forever. Reproduced against pristine
incoming upstream through public host/remote APIs. Unsubscribing now clears
partial state and applies the binding's ready transition. The deterministic
regression covers zero and one received snapshots, a successful method call,
and state rejoining the same binding.

### Discovery disabled during saved-journal resume

A managed session temporarily suppresses a selected browser tool and persists
that suppression. On ordinary resume with `discover_tools` excluded or its
factory removed, owner safety instructions become eager but the selected tool
remains unavailable. Reproduced through public SDK creation, the native resource
loader, an actual saved JSONL journal and a faux provider: the browser action
count is zero and its native call returns `Tool browse not found`. Explicit
allowlists/exclusions, optional tools and separately deselected tools are
negative controls. Native restoration now returns only the selected tools saved
as temporarily suppressed when discovery is inactive or absent. The same failure was reproduced
when settings disable the builtin on reload and is also repaired. The next
unmanaged run retires returned deferrals, so later resume/discovery cannot undo
explicit deselection. Delayed registration uses native pending tools; complete
working-session restoration preserves its exact saved loadout and journal.
Historical declarations remain unchanged. The public SDK reproduction passes
eight selection scenarios; 145 focused tests cover these and the existing
prompt-prefix, working-session and default-tool contracts.

### Upstream fixes verified at executable boundaries

The real Chat Completions adapter previously accepted the partial prefix
`{"path":"README.md"}` from malformed terminal arguments
`{"path":"README.md","offset":.5,"limit":10}`. The merged final parser marks
`argumentsError`, preserves the raw arguments and makes validation reject the
call. This was reproduced with local SSE/fetch responses through both adapters;
no paid provider was used. The checked-in adapter regression protects it.
The initially copied baseline test had an unrelated mock-resolution failure;
it is **not** evidence for the bug. The independent SSE contrast is.

Incoming retry handling also recognizes the temporary-unavailability
error. Anthropic and Bedrock preserve error-result images after the turn's tool
results rather than dropping them. Offline payload tests cover this ordering;
no live provider acceptance is claimed.

## Verification and merge conditions

Verified locally on macOS arm64, Node 24.21.0 and Bun 1.3.14:

| Check | Result |
| --- | --- |
| `npm run check` | Passed; 1,540 files checked, no formatting fixes or diagnostics |
| `npm run build:offline` | Passed all 10 build workspaces; Node/Bun bundles produced |
| Full `./test.sh` with the built `PI_TEST_COMPILED_CLI` | Passed; includes real-tmux Node restart and standalone extension resolution |
| AI / coding-agent / Chord | 1,485 / 3,249 / 527 tests passed |
| Durable, normal and immediate retention | 1,280 tests passed in each run |
| Public package consumer installs | All 10 isolated npm consumers passed |
| Bundled detached background job | Survived CLI exit and produced exact raw output |
| Node and Bun CLI Codemode smoke | Both completed a local SSE tool-call/reply round trip |
| SQLite fixture and SDK resume reproduction | Identical work/output witnesses; all eight resume scenarios passed |

The suite intentionally skips live-provider/e2e and unavailable-platform cases;
these are not counted as passing. Consumer installation emits the existing
transitive `node-domexception@1.0.0` deprecation notice. No dependencies were
changed for this integration. CI and review outcomes are recorded on the PR.

The pre-edit build passed. Pre-edit check and suite failures were limited to
references to the delisted OpenRouter `claude-sonnet-4`; incoming already updates
those references. They are not new regressions or claimed fork fixes.

External runnable regression commands from the repository root:

```sh
./test.sh -- node node_modules/vitest/dist/cli.js --run \
  --root packages/chord test/bindings.test.ts \
  -t 'becomes ready when the state view leaves'
./test.sh -- node node_modules/vitest/dist/cli.js --run \
  --root packages/coding-agent test/suite/instruction-groups.test.ts \
  test/suite/prompt-cache-prefix.test.ts test/suite/working-session.test.ts \
  test/default-tools-setting.test.ts
```

Reproduce the packaged checks after `npm ci --ignore-scripts`,
`npm run hydrate:model-data`, `npm run check` and `npm run build:offline`:

```sh
./scripts/build-binaries.sh --skip-install --skip-build \
  --platform darwin-arm64 --out /tmp/pi-sync-standalone
PI_TEST_COMPILED_CLI=/tmp/pi-sync-standalone/darwin-arm64/pi \
  env -u BASH_ENV PATH="/usr/bin:/bin:$PATH" ./test.sh
./test.sh -- npm run check:package-install
./test.sh -- node scripts/smoke-test-background-command-bundle.mjs \
  packages/coding-agent/dist/bundle/cli.js
./test.sh -- node scripts/smoke-test-codemode-binary.mjs \
  packages/coding-agent/dist/bundle/cli.js
./test.sh -- node scripts/smoke-test-codemode-binary.mjs \
  /tmp/pi-sync-standalone/darwin-arm64/pi
```

Choose the matching platform/CLI path outside macOS arm64. The standalone output
directory is task-owned: the build script replaces its contents.

The PR is mergeable only after configured CI and applicable review requirements
pass and actionable findings are resolved. Chord protocol 4 peers must upgrade
together; synchronous acquisition now uses `hold`, while `get` awaits readiness.
Live paid-provider, Windows, Termux-device and hosted Axiom behavior are not
qualified by offline tests. Local Nix qualification depends on CI because Nix is
not installed on the development host. Merge and runtime activation remain an
explicit later owner action for this task.
