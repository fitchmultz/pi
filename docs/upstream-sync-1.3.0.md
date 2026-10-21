# Upstream 1.3.0 integration — 2026-10-15

This is the historical 1.3.0 integration record. The subsequent
[2026-10-21 consolidation](upstream-consolidation-2026-10-21.md) records the newer
pinned upstream target, native retry/dialog/worker/identity decisions, consumer
inspection and PR-only delivery scope. Results below remain specific to this
older integration; they are not evidence for the newer candidate.

## Scope and measured baseline

Integrates eight upstream commits through `4954d760504c11df9b2cbdc040346107b6a8153d`
into fork `ea49ac297c4fba9296f6b7a19ec5d89fda36e008`. The common ancestor is
`5ab7fe74c400097b386662205cd93900695b8a71`. The owner authorized fork PR delivery,
merge and immutable runtime activation; no upstream issues, PRs or comments are authorized.

Before edits, ancestor-to-fork divergence was 419 paths, +39,001/-6,089 lines:

| Category | Paths | Added | Deleted |
| --- | ---: | ---: | ---: |
| Production package source | 141 | 10,234 | 3,377 |
| Tooling, configuration, manifests and locks | 54 | 2,535 | 2,015 |
| Tests, fixtures and conformance support | 179 | 23,320 | 600 |
| Documentation and guidance | 45 | 2,912 | 97 |

Classification follows the [previous integration record](upstream-sync-2026-10-15.md).
Reproduce the raw inventory with `git diff --numstat 5ab7fe74c ea49ac297`.
Incoming upstream changes affect 53 paths, +644/-226, but only two production
owners: message replay and interactive custom UI. The rest is tests, release
metadata, documentation and catalog tooling. Commit counts are not a measure of
remaining implementation duplication.

The pre-edit `npm run check` and offline build passed. The full offline suite
passed all runnable packages except six Env suites blocked by the missing native
daemon in the fresh worktree. Building it with `npm run build:daemon --workspace
@earendil-works/pi-env` repairs that setup prerequisite; it is not a product fix.
The baseline AI/coding-agent/Chord counts were 1,492/3,255/527 passing tests;
Durable passed 1,280 in each retention mode. Live-provider/platform skips are not passes.

## Actual divergence and preservation

[FORK.md](../FORK.md#fork-features) remains the capability/owner/test map. The
source comparison and executable verification retain these entry paths:

| Reachable workflow | Contract retained | Verification owners |
| --- | --- | --- |
| CLI/TUI restart and native working-session SDK/CLI | Same journal, complete queues/branches/settings/resources, readiness rollback and no replay | `restart-*`, `suite/working-session*` |
| Detached shell tools | Durable workers/logs, cancellation and completion across exit/resume | `background-command*`, bundled smoke |
| Deferred browser/macOS instruction discovery | Prior-turn instructions, stable declarations, selected-tool suppression and eager fallback | `suite/instruction-groups`, `suite/prompt-cache-prefix`, `default-tools-setting` |
| Native read/edit and compact activity | JSON selection before limits; byte-safe edits; native accessible cards/settings | `read-json`, `edit-byte-safety`, `compact-view` |
| Model/auth/cache paths | Credential isolation/fallback, scoped readiness, selected providers, cache diagnostics and retained signatures | Model-runtime/auth/cache suites |
| Frozen installs and standalone extension imports | Exact catalogs, owned store, rollback, package exports and project trust | Installer/updater tests, public consumers, compiled-extension tests |
| Chord/Durable/Env/MCP/Codemode/evals/telemetry | Public package, protocol, storage, daemon and sandbox contracts | Respective offline package suites |

No incoming equivalent replaces these fork-only capabilities. Chord and Durable
remain exact coding-agent dependencies at 1.3.0. External dependency lock entries
are unchanged. Legacy Kimi/Cloudflare hydration and runtime-overlay repairs remain:
a newer Nix pin does not protect cached or fetched legacy catalogs. Publishing
workflows remain disabled; Nix automatic writes remain upstream-only.

Upstream's thinking removal and own-overlay handle replace no fork-specific
production implementation: the baseline transform had zero fork divergence, and
the custom UI path still needs its working-session admission gate. Historical
session reasoning remains available; only cross-model request replay omits it.

## Proven failures and fixes

### Upstream fixes, verified independently

A native Anthropic request previously serialized a different model's readable
reasoning as visible assistant text. Upstream now drops it while preserving the
visible answer and same-model signatures. A real custom UI/TUI probe also showed
that closing a lower overlay removed the upper overlay and routed input to the
finished component. Upstream now removes the interaction-owned handle. Across
these offline payload and terminal-state probes, eight failing observations
became zero, with all 15 assertions passing. No live provider call was used.

### Model switching could leave only one output token

The native Chat Completions adapter produced a Kimi reply with 80,000 reasoning
characters, visible `Done.`, and 20,005 reported tokens. Replaying it into the
16,385-token GPT-3.5 target correctly removed the foreign reasoning, but output
budgeting still trusted the source model's usage and requested only one token.
A short source reply produced byte-identical target messages but requested 4,096.

The shared simple-stream clamp now supplies its target model to the estimator.
Only matching provider/API/model usage anchors apply; the remaining suffix uses
canonical replay transformations. Original message indices, timestamp admission,
failed-retry handling and same-model signatures remain covered. Both identical
target payloads now request 4,096 tokens. Target-less estimator calls and the
separate historical UI/compaction estimators retain their contracts.

The pure transform implementation moved unchanged into `utils/` so estimation
can reuse it without violating the existing entry-graph restrictions. Its old
public `api/transform-messages` path re-exports the same functions and type;
runtime and strict TypeScript consumer imports verify both. There is still one
implementation, not a second replay policy or a relaxed import budget.

### Custom UI initialization leaked components and erased drafts

Public SDK/runtime probes used `ctx.ui.custom`, the shipped `CancellableLoader`,
and native terminal input. Completing synchronously or from a resolved cache
promise before factory fulfillment left the returned loader undisposed. Disposal
count changed from 0 to 1; over the same 180 ms observation its animation callback
count changed from 1→3 to 1→1. This is cleanup evidence, not a latency benchmark.

While an async factory initialized, the still-visible editor accepted
`new typed draft` after `original `. Both successful close and factory rejection
restored the older `original ` snapshot. Draft capture now occurs only when the
replacement actually mounts; pre-mount completion/rejection restores nothing.
Both paths retain `original new typed draft`. The working-session gate and
upstream overlay ownership remain intact.

### Catalog compatibility validation crashed on npm 12

The new upstream checker destructured `npm pack --json` as an array. Actual npm
12.2.0 returns a package-keyed object; the executable checker failed with
`object is not iterable` before reading the catalog. It now reuses the existing
validated pack parser. The offline CLI regression exercises both output formats,
real tar extraction, catalog overlay semantics and the actual TypeScript compiler,
including rejection of an unsupported API and unsafe metadata.

The repository's `min-release-age=2` policy can independently refuse a newly
published package. It was not disabled. Offline CLI/compiler tests plus actual
registry pack metadata establish this repair, not a claim that the live catalog
publication pipeline ran or that every historical release was compiled.

## Measured simplification, without a deletion quota

| Change | Before → after | What it proves |
| --- | --- | --- |
| Custom-UI test setup | Two equivalent fixtures → one shared fixture | Removes duplicate setup while retaining both native focus/overlay cases and adding lifecycle coverage |
| npm pack validation | One validated caller plus one broken parser → two callers of one validator | Shared validation, not a source-size or speed improvement |
| Replay policy | One implementation → one byte-identical relocated implementation plus a public re-export | Canonical behavior reuse; no import-budget exception or duplicate filtering |
| Chord release notes | Four redundant/misclassified Unreleased bullets → zero | Protocol, compression, schema and child-lock behavior are already upstream; runtime behavior is not removed |

No performance improvement is claimed. New bug handling and regression tests add
code. No arbitrary speed target or deletion target was imposed.

## External runnable verification

From the repository root, install with `npm ci --ignore-scripts`, hydrate model
data with `npm run hydrate:model-data`, then run:

```sh
npm run check
npm run build:offline
npm run build:daemon --workspace @earendil-works/pi-env
./test.sh -- node node_modules/vitest/dist/cli.js --run --root packages/ai \
  test/context-estimate.test.ts test/transform-messages-cross-model-thinking.test.ts
./test.sh -- node node_modules/vitest/dist/cli.js --run --root packages/coding-agent \
  test/interactive-mode-status.test.ts test/suite/instruction-groups.test.ts \
  test/suite/prompt-cache-prefix.test.ts test/suite/working-session.test.ts
./test.sh -- node --test scripts/check-model-catalog-compat.test.mjs \
  scripts/package-artifacts.test.mjs scripts/update-model-catalog-pin.test.mjs
./test.sh
./test.sh -- npm run check:package-install
```

For packaged Node and Bun boundaries (choose the host platform):

```sh
./scripts/build-binaries.sh --skip-install --skip-build \
  --platform darwin-arm64 --out /tmp/pi-sync-1.3-standalone
PI_TEST_COMPILED_CLI=/tmp/pi-sync-1.3-standalone/darwin-arm64/pi \
  env -u BASH_ENV PATH="/usr/bin:/bin:$PATH" ./test.sh
./test.sh -- node scripts/smoke-test-background-command-bundle.mjs \
  packages/coding-agent/dist/bundle/cli.js
./test.sh -- node scripts/smoke-test-codemode-binary.mjs \
  packages/coding-agent/dist/bundle/cli.js
./test.sh -- node scripts/smoke-test-codemode-binary.mjs \
  /tmp/pi-sync-1.3-standalone/darwin-arm64/pi
```

The standalone output directory is task-owned and replaced by its build command.
Use the clean-PATH form on hosts whose GNU coreutils aliases change Env process
names. These commands are runnable acceptance evidence, not self-review assertions.

## Verification record and limits

Verified on macOS arm64, Node 24.21.0 and Bun 1.3.14:

| Check | Result |
| --- | --- |
| `npm run check` | Passed; 1,543 files, no fixes or diagnostics |
| Offline workspace build and standalone build | Passed |
| Full isolated `./test.sh` with standalone input | Passed, including native restart and compiled extension resolution |
| AI / coding-agent / Chord | 1,507 / 3,262 / 527 tests passed |
| Durable, ordinary and immediate retention | 1,280 tests passed in each run |
| Env | 100 passed; two external-environment cases skipped |
| Script suite | 87 passed, one platform case skipped |
| Isolated public package consumers | All ten passed |
| Bundled background command | Worker completed after CLI exit with exact raw output |
| Node and Bun Codemode smoke | Both local SSE tool-call/reply round trips passed |
| Public custom-UI runtime probe | All four lifecycle/draft scenarios passed |
| Independent reviews | Integration/UI/catalog review findings resolved; separate AI review had no findings |

Expected failure fixtures print diagnostic errors; the suite exit status was zero.
Consumer installation retains the existing transitive `node-domexception`
deprecation notice. CI and installed-runtime results belong to the fork PR and
delivery record. Required checks and actionable review findings must be resolved
before merge; fresh catalog comparison and immutable installed-runtime tests must
pass before activation. The prior release remains available for rollback.

Offline payloads do not establish live provider acceptance, billing or cache hits.
Nix and non-host operating systems need their CI/platform checks. Windows and
Termux-device behavior are not qualified by macOS tests. The
pre-existing example-only Gondolin dependency reports a node-forge advisory with
no available npm fix; no exploit in Pi's supported runtime was demonstrated, and
this integration does not change that dependency.
