# Upstream consolidation — 2026-10-21

## Scope and fixed references

This pass prepares one review-ready PR against `fitchmultz/pi:main`. It does not
merge, release, select or activate a runtime, restart sessions, or publish to
upstream. External consumer repositories were inspected read-only.

| Reference | Exact commit |
| --- | --- |
| Fork baseline | `997a2575e0dde7c6690024184feec970d395f9b4` |
| Upstream target | `cae9fd28a2d3d515c83ea495093e3768cc8efab6` |
| Common ancestor | `396ecd7b8f3a146b8af98206d18df1bcc2c08f4e` |

The pinned target includes the replication-scaffold revert after `4c25119f5`;
that earlier reconnaissance SHA is not the integration target. The PR keeps
upstream synchronization and fork consolidation in separate commits. Its final
head and exact-head CI links are recorded in the PR, avoiding a self-referential
commit hash here.

## Method and inventory

Compared ancestor→fork, ancestor→upstream, and upstream→candidate trees, then
traced exported APIs, concrete callers and existing tests. Commit counts and
three-dot diffs alone do not establish redundant implementation. The retained
capability/owner/test inventory remains in [FORK.md](../FORK.md).

Before editing:

| Category | Fork paths | Fork added | Fork deleted | Incoming paths | Incoming added | Incoming deleted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Production package source | 154 | 11,593 | 3,797 | 48 | 1,924 | 555 |
| Tests, fixtures and conformance support | 193 | 25,921 | 664 | 39 | 1,304 | 587 |
| Tooling, configuration, manifests and locks | 59 | 2,784 | 2,031 | 6 | 38 | 23 |
| Documentation and guidance | 50 | 3,311 | 97 | 13 | 70 | 5 |
| Total | 456 | 43,609 | 6,589 | 106 | 3,336 | 1,170 |

Reproduce with `git diff --numstat --no-renames <ancestor> <fork-or-upstream>`.
Classification precedence: `/test/`, `.test.`, `/src/testing/` and
`scripts/performance/fixtures/` are tests/support; remaining `/src/` paths are
production; Markdown, `docs/`, `.pi/prompts/` and `.pi/skills/` are documentation;
the remainder is tooling. Ignored hydrated provider catalogs are not Git source.
The final categorized comparison is recorded with the PR's exact head.

## Replacements and their evidence

| Old path or mechanism | Native owner now used | Verification and preserved boundary |
| --- | --- | --- |
| Retry-private `sleep` timer/listener and `RetrySleepAbortError` | `pi-ai/src/utils/sleep.ts` and `operationSignal()` | `retry.test.ts` runs real timers and the actual helper: completed/aborted listener cleanup, custom Error/string/null reasons, pre-abort, optional signal, fractional/zero delays, callback order and callback failures. Retry still returns its normalized aborted assistant message without leaking a custom cancellation reason. |
| Immediate codemode capacity rejection | Upstream FIFO reservation/admission in the common script start path | `codemode-worker-admission.test.ts` plus `suite/agent-session-codemode-background.test.ts`: actual worker ownership, abort/timeout, foreground/background queue sharing, prompt launching receipts and deferred store/usage delivery. |
| One-slot selector/input/editor fields and inline hide/show ownership | Upstream dialog stack | `interactive-mode-extension-dialogs.test.ts` and `interactive-mode-status.test.ts`: concurrent/hidden dialogs, nested custom prompts, component disposal before mount, editor drafts and focus. Working-session factory admission remains. |
| Coding-agent provider attribution module | Native pi-ai `ClientIdentity`, default identity and `withClientIdentity()` | Native identity/provider tests, SDK client-identity tests and availability regression; custom-provider dispatch retains the exact post-hook headers object. Google adapters keep one shared streaming engine. |
| Missing `pi-ai/models` extension alias/virtual export | Upstream loader aliases and virtual module mapping | `suite/regressions/11156-pi-ai-models-virtual-module.test.ts`; packaged/standalone extension boundaries remain separately tested. |
| Unused Chord SQLite replication scaffold | Upstream removal | No production caller outside the removed scaffold was found. Chord SQLite tests remain; native Durable IndexedDB storage is additive, not a substitute for memory/SQLite storage. |

Only the first row retires a **fork-patched duplicate retry helper**.
The worker/dialog-stack fixes themselves improve inherited upstream mechanisms. The attribution module
had no fork delta before this pass; its removal is an upstream API migration, not
an invented fork-specific deletion. Existing shared edit policy, Chord JSON/output
and SQLite drivers, native prompt/context APIs and npm artifact production already
had native owners and were not recreated.

The retry tests were first run against the old implementation, then unchanged
against the native-helper replacement: 45 tests passed on the original fork in
both configurations. On the integrated tree, upstream's additional cases bring
that to **48 passing before and after**. An attempted dialog snapshot removal also
passed 53 cases, but review identified a missing public-API case; that attempted
consolidation is withdrawn as described below.

This is behavior comparison, not a speed benchmark. The retry production file
changes by +5/-26 lines. Tests add coverage;
no deletion quota is used. Sharing the helpers adds two small modules to Durable's
static source graph; identity adds two more. The measured root graph is baseline
72 → synchronized 74 → consolidated 76; AI `./models` remains 20 and the shared
edit-diff entry remains one file. Existing forbidden barrel/image imports remain
forbidden, rather than relaxing those boundaries.

### Intentional upstream behavior changes

- Saturated codemode calls wait FIFO instead of rejecting immediately. The wait
  counts toward `timeout_ms` and has a 60-second ceiling. The process-wide worker
  limit defaults to two and can be configured with `PI_CODEMODE_MAX_WORKERS`.
  Background calls still publish their launching receipt without waiting for a slot.
- Concurrent dialogs return to the underlying dialog rather than orphaning its
  promise. Native custom-dialog draft restoration remains. The fork captures the
  draft at mount, not factory entry, and retains asynchronous-factory disposal,
  overlay ownership and save admission.
- Native identity changes default User-Agent/attribution and when attribution
  becomes visible to header hooks, as documented by upstream. Cache tracing and
  retention preparation are not replaced or silently disabled.
- Other incoming fixes remain native: MCP BOM handling, terminal exit restoration,
  clipboard process groups, autocomplete regex escaping, Markdown math/table
  boundaries, retry error matching, summary output limits and split-turn compaction
  instructions. Retired model fixtures follow upstream's supported catalog IDs.

### Withdrawn candidate: custom-dialog draft restoration

The stack retains the same editor object, but that alone does not replace draft
restoration. A supported extension can open inline `ctx.ui.custom()`, call
`ctx.ui.setEditorText("preview")`, then close the component. Existing behavior
restores the pre-dialog draft; removing the snapshot retains `"preview"` instead.
A new public-API regression failed against the attempted removal (expected
`"original draft"`, received `"preview"`) and passes against the retained sync
implementation. The entire nine-case working-session/dialog file passes with
restoration retained.

Upstream `cae9fd28` also retains the snapshot; deleting it would add divergence
and change behavior, not adopt an equivalent upstream implementation. The removal
in intermediate commit `d12aa565` is withdrawn rather than silently accepting that
change. The fork still needs mount-time capture to preserve typing during async
factory initialization, late-component disposal after early completion, and
working-session factory admission. Those retained lifecycle cases fail against an
unadapted upstream transplant. The stack adoption and these small fork adaptations
are distinct from retirement of a redundant mechanism.

No legacy ABI, new framework, generalized buffer abstraction or speculative hook
was added. No latency or end-to-end speed improvement is claimed.

## Why the remaining differences stay

| Area and reachable caller | Why the apparent native replacement is not equivalent |
| --- | --- |
| Working-session SDK/CLI, managed restart and input/queue admission | Journal resume does not capture all branches, pending queues, mode buffers, resources and settings or attest a completed exit. Native input listeners cannot replay held input into the dispatcher by themselves. |
| Background codemode and detached `background_command` | Upstream worker admission is process-local scheduling, not deferred receipt/usage/store delivery or durable shell jobs across exit. MCP's similarly named background helper has a different owner and lifetime. |
| Instruction groups and browser discovery | Native named prompt sections provide eager fallback, not prior-turn lazy activation with stable tool declarations and branch-aware repair. |
| Compact activity, JSON read, path hyperlinks | Ordinary native cards, byte reads and explicit Markdown links do not supply these approved presentation/selection behaviors. Auto-links cover prose and inline code, not fenced code blocks. |
| Credential isolation/fallback, scoped refresh and availability diagnostics | Standard provider auth does not suppress unrelated stored-credential resolution or preserve per-provider readiness under overlapping refresh. The new mutable identity wrapper must forward `getAvailability()`. |
| Provider registration drain | Startup readiness, synchronous runner binding, action overrides and error delivery differ. Similar loops do not justify merging their ownership or changing completion ordering. |
| Cache trace/warming, usage and replay estimates | Public hooks do not observe final serialization/consumed attempts. Warming depends on prepared auth/retention, and cross-model budgeting must count only native replay. Tool-only persisted usage and detached nested records remain owned by the fork. |
| Atomic private rewrites and streaming snapshot I/O | Upstream private creation is not alias-safe locked replacement with fsync/mode preservation. Whole-document JSON strings do not preserve bounded I/O buffering for large snapshots. The parsed tree remains resident; this is not constant-memory snapshot processing. |
| Native tool spill, edit and shell cancellation | Backpressure/complete close, untouched byte preservation and stop-before-kill process groups are separate contracts. Shared Durable edit policy and native private creation already serve the callers. |
| Custom-dialog draft and factory lifecycle | The native stack owns visibility/focus, but upstream still restores the draft. Public `setEditorText()` during a dialog demonstrates that restoration is observable. Keep the fork's mount-time capture, late disposal and working-session admission rather than removing the snapshot or reverting to upstream's entry-time capture. |
| TUI input/layout and ANSI wrapping | Existing native decoding, segmentation and tracking are already reused. Replacing the retained adaptations loses UTF-16 cursor positions, paste-marker atomicity, draft layout reuse or byte-identical OSC payloads. |
| Chord/Durable/Env/MCP/evals | Public protocols, document/task schemas, retention, framing and platform I/O differ. IndexedDB does not replace memory/SQLite optimizations; line accumulators have different boundaries. |
| Immutable fork install, package exports and build tools | Official version updates do not provide exact source/catalog identity, selector ownership and validation/rollback. Chord and Durable exports/dependencies must remain paired with their real consumers. |

The prior performance fixtures and measurements in [performance.md](performance.md)
identify historical workloads, not measurements of this candidate. Retaining those
unchanged owners does not claim newly measured gains. A future replacement must
compare the same workloads and preserve the same contracts.

## External consumer evidence

Source-only inspection at immutable commits; all five checkouts remained clean.
No consumer installs, builds, tests, runtime activation or publications were run.

| Repository | Inspected SHA | Concrete boundary |
| --- | --- | --- |
| `fitchmultz/pi-posthorse` | `896dd7defaa2b5d83f96e495e41ed3ecee3cd961` | Public boundary compaction/context, `findCutPoint`, file mutation queue and custom-run preparation. Current upstream already provides modern idle-custom-run preparation; older published-release caveats do not establish a current upstream gap. |
| `fitchmultz/pi-pstack` | `ac04c9b0504a368ea20bcfd7dfdd2a5239dbe20d` | Public discovery/tool inventories; background shell capability is optional, not equivalent to persistent periodic wakes. |
| `fitchmultz/pi-subagents` | `1646ab895e25fb56847ad669733c55807bc8ff3c` | Public lifecycle and finalized tool usage; optional compact rendering and explicit fork background/discovery inventory. Its detached runner is not replaced by process-local background codemode. |
| `fitchmultz/pi-agent-browser-native` | `341a9cfd685cc6d24f10eb50a619f4082462c6c7` | `pi:instruction-groups` collector with eager named-section fallback; journal publication/ownership and branch cleanup remain extension-owned. |
| `fitchmultz/pi-cursor-sdk` | `f337dc4bb7cea936c52e69a7fe08e7e376c8467b` | `src/cursor-provider-binding.ts` keys a WeakMap receipt by `before_provider_headers`' exact object and consumes it through provider `options.headers`. Native preparation must not clone it after the hook. |

These current consumers do not require the retired context-window, pending-call,
idle-checkpoint or immediate `recordUsage` APIs. That does not establish safe
migration of every historical journal or qualify unknown installed versions.
Wildcard peers, declared support floors and configured CI are not runtime evidence.
The candidate's native provider regression covers the located header-identity
boundary; it does not claim to run Cursor's service or consumer compatibility suite.

## Verification procedure and limits

Baseline Linux x64: Node 24.22.0, npm 11.19.1, Bun 1.3.14. Dependencies were installed
with `npm ci --ignore-scripts`; reviewed root `prepare` and model-data hydration
were run explicitly. Baseline and candidate used byte-identical hydrated catalogs;
the sorted relative-path SHA-256 manifest hashes to
`8a8344175a72d0554316c3699611d1f9d3173b4491ad57b0ac7202a358d1ec6d`.
The only incoming lock addition is upstream's exact dev-only
`fake-indexeddb@6.2.6` for its native IndexedDB tests; its package scripts were
inspected and dependency lifecycle scripts were not enabled.

Baseline `npm run build:offline` passed. `npm run check` failed on retired model IDs
in existing fixtures; the full offline AI run reproduced four such failures with
1,638 passing and 864 skipped tests. Upstream's fixture updates address those exact
catalog removals rather than weakening assertions. Coding-agent's baseline also
failed its existing Copilot-default assertion (`gpt-5.4` was retired); incoming
`gpt-6.1-sol` passes that same assertion against the unchanged catalog. The first full-suite attempt
also lacked Go for the existing Termux compiler fixture; installing the prerequisite
allowed that fixture to pass. Other baseline failures were investigated without
changing assertions or deadlines:

- Bun's real-worker abort case passed unchanged on a focused rerun and three
  captured abort attempts; timeout/close controls passed. One process exited after
  13.9 seconds despite cancellation settling at 485 ms, so load-sensitive process
  exit is a credible risk. The original log lacks status/signal metadata; it does
  not establish whether the failure was a timeout or SIGABRT.
- Durable's immediate-retention journal-order test exhausted polling before its
  first worker call, not at the journal assertion. The unchanged case passed three
  low-load reruns with `PI_DURABLE_DOCUMENT_RETENTION_MS=0`.
- SSH setup failed because `/run/sshd` was absent in the container. Native
  `sshd -t` confirmed the missing privilege-separation directory. Creating it
  root-owned with mode 0755 repairs the prerequisite, not product code.

The candidate full suite runs separately from local builds/checks to avoid that
concurrent CPU load. Baseline failures are not silently relabeled as passes.

Commands from the candidate root:

```sh
npm ci --ignore-scripts
npm run prepare
npm run hydrate:model-data
npm run check
npm run build:offline
npm run build:daemon --workspace packages/env
./test.sh -- node node_modules/vitest/dist/cli.js --run --root packages/ai \
  test/retry.test.ts test/identity.test.ts test/models-runtime.test.ts
./test.sh -- node node_modules/vitest/dist/cli.js --run --root packages/coding-agent \
  test/codemode-worker-admission.test.ts test/suite/agent-session-codemode-background.test.ts \
  test/interactive-mode-extension-dialogs.test.ts test/interactive-mode-status.test.ts \
  test/sdk-client-identity.test.ts test/sdk-stream-options.test.ts test/suite/working-session.test.ts
./test.sh
./test.sh -- npm run check:package-install
./scripts/build-binaries.sh --skip-install --skip-build \
  --platform linux-x64 --out /tmp/pi-consolidation-standalone
PI_TEST_COMPILED_CLI=/tmp/pi-consolidation-standalone/linux-x64/pi ./test.sh -- \
  node node_modules/vitest/dist/cli.js --run --root packages/coding-agent \
  test/compiled-extension-packages.test.ts
```

In a root Linux container, run permission-sensitive tests under `tini -s -- setpriv
--bounding-set=-dac_override,-dac_read_search --inh-caps=-dac_override,-dac_read_search
--ambient-caps=-dac_override,-dac_read_search ./test.sh`. This drops DAC bypass and
reaps detached children; it does not skip permission assertions. Build prerequisites
include tmux, fd, Go and a sufficiently recent Rust toolchain for the Env daemon.

Final command outcomes, independent review and exact-head CI belong to the PR
verification record. Skipped live-provider, external SSH, compiled-target and
platform tests are not passes. Linux offline tests do not establish provider billing,
cache hits, Windows or Termux-device acceptance. Applicable CI must finish at the
final head before calling the PR review-ready; no merge or runtime activation is
part of this task.
