# Performance results and reproduction

The fork removes repeated work from native file tools, TUI rendering, model metadata, provider stream handling, Chord/MCP transport, sessions, Durable, Env, background jobs, evals and packaging. The recorded fixtures show large reductions on those paths. A matched rerun confirmed the branch-preparation, current-directory listing and long-token wrap/preview gains. AI tool validation (+33%), transform (+5.4%) and prose preview (+6.1%) were slower in all four matched pairs, with overlapping ranges and no isolated source attribution. One deliberate trade-off is slower: the native Bash tool and executor now keep the spill-file write queue at 64 KiB instead of letting it grow to 6.9-10.1 MiB, and writing 64 MiB of command output took about 28% longer. Startup and Biome showed no clear change.

The older [recorded results](#recorded-results) are source-owner measurements of two measured source trees on one workstation, not of the final runtime: later prompt-cache, model-catalog and upstream v1.2.0 integration changes were not timed. Dated sections identify their own workloads and measurement status. These results do not show that every CLI invocation, provider, device or downstream adapter becomes faster. Functional tests remain the authority for behavior, safety, cancellation and mutation isolation.

## Session listing (2026-10-24)

`SessionManager.list()` and `listAll()` reuse complete per-journal scan results under unchanged source revisions and date-parser context. Counts, names, activity dates, previews, and full user/assistant search text remain exact; the source scanner is authoritative. See the [cache contract](../packages/coding-agent/docs/session-listing.md) for invalidation, cleanup, permissions, and concurrent-write limits.

On the larger synthetic Linux workload, **warm-cache** picker load/search/render/select fell from **2318.49 to 48.19 ms median**. All 20 fresh processes passed, with matching semantic witnesses. [Results, samples, environment, source/workload hashes, loads, and commands](session-listing-performance-results.json) identify the corrected candidate measured as an uncommitted tree based on `0998f135`; that ancestor's original product tree is not the new candidate. Values below are median (minimum–maximum), milliseconds, five trials per side and size.

| Workload | Operation | Before | Candidate |
| --- | --- | ---: | ---: |
| 12 files | Cold list and cache population | 92.33 (87.04–99.19) | 107.23 (95.46–110.86) |
| 12 files | Warm complete list | 62.96 (56.92–72.37) | 3.18 (2.92–4.02) |
| 12 files | Warm current-project list | 16.06 (14.14–21.37) | 1.86 (1.81–2.60) |
| 12 files | Warm picker load/search/render/select | 77.88 (73.86–89.81) | 13.23 (11.99–17.26) |
| 64 files | Cold list and cache population | 1783.98 (1665.48–2232.17) | 1944.78 (1835.70–2183.97) |
| 64 files | Warm complete list | 1649.65 (1550.38–1754.97) | 11.98 (11.71–19.98) |
| 64 files | Warm current-project list | 394.39 (383.48–425.70) | 4.79 (3.96–5.29) |
| 64 files | Warm picker load/search/render/select | 2318.49 (1644.74–2372.02) | 48.19 (44.65–53.37) |

Cold initialization is not improved: it scans complete journals and adds cache publication work, and both candidate cold medians are higher with overlapping ranges. The cache also duplicates complete searchable text on disk. The historical **2284.40 → 51.91 ms warm-cache** result belongs only to the [original `0998f135` qualification][listing-original], not the changed runtime.

The retained fixture uses 12 files × 128 messages and 64 files × 512 messages across four project directories. Seven of every eight messages contain synthetic tool output; the rest retain complete searchable Unicode text and late-row markers. Each process times these separate operations:

| Operation label | Timed work |
| --- | --- |
| Cold list and cache population | First `listAll()` with an empty derived cache |
| Warm complete list | Second complete `listAll()` |
| Warm current-project list | `list()` for one of the four projects |
| Warm picker load, search, render, and selection | Real picker all-project loading through the listing API, full-text query, render, and selection; waits for complete results |

Run five serial fresh-process pairs per size, alternating before/after order. Both roots get freshly written, filesystem-warm synthetic inputs; only the candidate's warm operations use a populated derived cache. Imports, fixture generation, assertions, and result hashing are outside the operation clocks. The fixture checks exact cold/warm metadata, message counts, search and selection, progress, and semantic witnesses. The picker clock excludes application startup and terminal-emulator display.

```sh
# In each isolated root, before timing; use identical frozen model data.
npm ci --ignore-scripts
node packages/ai/scripts/hydrate-model-catalog.ts "$CATALOG"

# From the candidate checkout. RESULTS must not already exist.
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" \
  --groups session-listing-12,session-listing-64 --repeat 5 --out "$RESULTS"
```

These are synthetic Linux workloads, not measurements of the owner's installed macOS runtime or private corpus. Warm costs still include discovery, source-revision checks, cache decoding, and complete search text; text-heavy journals, other filesystems, and cold caches can behave differently. Session-open parsing and per-keystroke search normalization are not optimized here. Static review against the Node 22.19.0 filesystem API contract is not runtime qualification on every supported platform. Source/log reviews and archived tests do not establish current-head CI, provider, or platform passes; skipped tests remain skips.

The original [measurement manifest][listing-manifest] retains the measured source hashes, commands, samples, loads, and witnesses. Other historical evidence remains at the same immutable ancestor: [model admission][listing-model], [verification and failed-attempt/container notes][listing-verification], [CPU profiles][listing-profiles], [CLI terminal captures and synthetic journals][listing-cli], and [date-context reproducer][listing-dates]. These records describe the original runtime, not the subsequent reductions.

[listing-original]: https://github.com/fitchmultz/pi/blob/0998f135b599be18c07069d9848b5b65012c95ea/docs/performance/issue-251/README.md
[listing-manifest]: https://github.com/fitchmultz/pi/blob/0998f135b599be18c07069d9848b5b65012c95ea/docs/performance/issue-251/measurements/manifest.json
[listing-model]: https://github.com/fitchmultz/pi/blob/0998f135b599be18c07069d9848b5b65012c95ea/docs/performance/issue-251/model-evidence.json
[listing-verification]: https://github.com/fitchmultz/pi/blob/0998f135b599be18c07069d9848b5b65012c95ea/docs/performance/issue-251/verification.md
[listing-profiles]: https://github.com/fitchmultz/pi/tree/0998f135b599be18c07069d9848b5b65012c95ea/docs/performance/issue-251/profiles
[listing-cli]: https://github.com/fitchmultz/pi/tree/0998f135b599be18c07069d9848b5b65012c95ea/docs/performance/issue-251/cli
[listing-dates]: https://github.com/fitchmultz/pi/tree/0998f135b599be18c07069d9848b5b65012c95ea/docs/performance/issue-251/dates

## Turn-end context reads (2026-10-14)

A long-running session can retain tens of thousands of archived entries while its active context is small. Boundary readers previously copied and indexed that entire ancestry for each preview. Pending-queue readers paid this cost even though they needed no projected messages. Context-usage reads and finalization also walked the ancestry again.

Empty-draft previews now use the live manager with lazy projection fields. The manager incrementally maintains the active path, selected raw context entries and settings; each projection still creates fresh derived messages and containers. Navigation or a replaced entry list rebuilds the retained state. Nonempty drafts keep eager validation, and canonical context still refreshes after every boundary.

The retained `sessions.mts` fixture now includes two pending-only readers, a context-usage reader, and a context-message/continuation reader. The synthetic comparison used baseline `2c0c79405`, 100,000 archived entries, a faux provider, identical dependency locks/model data, and diagnostics enabled for boundary runs. Three fresh-process pairs alternated root order; each operation had three warmups and 15 measured samples. All 18 processes passed and corresponding semantic witnesses matched. [Recorded inputs, hashes and process medians](turn-end-performance-results.json) identify the measured candidate.

| Operation | Baseline median (range), ms | Candidate median (range), ms |
| --- | ---: | ---: |
| Whole faux prompt, context-reading boundary hooks | 129.1 (117.5–140.0) | 1.51 (1.43–2.06) |
| Whole faux prompt, no-op boundary hooks | 44.3 (37.3–51.4) | 1.33 (0.85–1.55) |
| Whole faux prompt, no boundary hooks | 14.3 (14.0–18.6) | 0.78 (0.63–1.40) |
| First context-usage read after an append | 12.35 (11.00–12.56) | 0.67 (0.56–0.91) |
| Warm compacted-context projection | 11.08 (6.00–13.79) | 0.00154 (0.00142–0.00171) |

Values summarize the three process medians, not provider latency. Boundary/context runs started at one-minute load 18.7–19.6 on the shared workstation; projection runs spanned 10.0–18.9. Same-leaf scalar-cache reads remained tiny with overlapping ranges (0.016–0.021 ms before, 0.019–0.022 ms after for 100 reads). Short active paths with many off-branch entries were already fast. No absolute no-warning guarantee under arbitrary system load is implied.

```sh
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" \
  --groups sessions-boundary-100000,sessions-context-100000,sessions-projection-100000 \
  --repeat 3 --out "$RESULTS/turn-end"
```

These results are separate from the older measurements below. Setup and source-root isolation follow the same reproduction instructions.

## Recorded results

### Measured trees and conditions

- Baseline: `c329e624e73ba2086bd3ce15e091d667879dca9c`. Both measured trees were uncommitted, so file maps in [`performance-results.json`](performance-results.json) identify them.
- First comparison: the candidate tree before the prompt-cache accounting change. `candidate.measuredSourceMap` records 123 frozen file hashes, including changed files and the shared lock/catalog inputs. Native edit/read/grep, image and TUI primitive candidates ran in per-domain trees that held only that domain's changes; their owner files are byte-identical in the later trees, but those rows were not re-timed after integration. Exact-edit and diff rows ran on the first edit revision; the final follow-up changed only fuzzy offset mapping, which exact-match workloads never reach, and the fuzzy row was re-timed on it.
- Matched qualification: the first-comparison candidate plus the prompt-cache accounting change (`core/cache-stats.ts`, `settings-selector.ts` and `interactive-mode.ts`). The first comparison's tools, sessions and background fixtures load those modules only through the package index at import time, outside timed regions; no timed operation calls them. `qualification.roots` lists every file in the runner's source scope that differs from the baseline in each root.
- Not measured: changes after the qualified tree, including the Cloudflare prompt-cache capability and lifetime defaults, native cache-warmer retention/authentication/pricing repairs, the refreshed model catalog and the nine-commit upstream merge through `d6370b72d0a478a31741a6c44ae7ecdcbd01d0fd` (v1.2.0 and follow-up Chord/Env fixes). Upstream release notes describe separate upstream measurements; none is attributed to this performance effort. Both comparisons used `package-lock.json` SHA-256 `762b0da32d2418f5f474f661587bbdd3bc823a99abcb42840957422b68cb391f` and the hydrated model catalog with manifest SHA-256 `15ddb5a96461d83a3b43d702987c1bc40864ad6622b1c9cbe92621847cbd29fe`.
- Host: Node 24.21.0, npm 11.19.0, macOS (Darwin 27.0.0) arm64, Apple M5 Pro (Mac17,9), 18 logical CPUs, 64 GiB.
- First-comparison runs were serial, task-owned, fresh Node processes with a warm filesystem on a shared workstation that was not idle. One-minute load at process start: 9-25 for baselines; 32-35 for the first integrated batch (AI, TUI, Chord/MCP, sessions, catalog, Codex, and the ls/resource/job-listing/spill controls); 10-15 for every other candidate. The final fuzzy-edit, build, pack and Nix pack runs have no recorded load. No sample was discarded.
- Fixtures: the first comparison used the original research fixtures listed by content hash in `scripts/performance/provenance.json`, before their adaptation into this runner. The matched qualification used the retained runner itself; `qualification.runner` records the SHA-256 of all 31 runner files and names the seven that received the qualification selectors and fixture-only smoke repairs before timing. Re-run both roots with the retained runner rather than comparing new numbers with these.

### Reductions

First comparison. Values are median (minimum-maximum) milliseconds unless noted; n counts logged rows per side, and Time is the change in median. **Isolated**: per-domain candidate tree. **High load**: candidate load 32-35 against baseline 9-22. **p50**: each value is one process's logged p50; its internal samples were not emitted, so no raw range exists. **Matched**: confirmed by the matched qualification below.

| Area | Operation | n | Baseline | Final | Time | Conditions |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Native tools | Exact edit, 32 targets in 7.2 MB | 7/7 | 1,191 (1,187-1,301) | 149 (146-160) | -87% | Isolated |
| | Edit with display diff and unified patch | 7/7 | 1,317 (1,253-1,508) | 191 (187-221) | -86% | Isolated |
| | Fuzzy edit, 32 targets | 7/7 | 4,168 (4,052-4,873) | 715 (297-1,242) | -83% | Isolated |
| | Read head of a 32 MiB file | 7/7 | 36.2 (34.9-65.2) | 18.4 (17.0-20.8) | -49% | Isolated |
| | Grep with context | 7/7 | 28.9 (28.1-34.3) | 22.8 (21.1-32.4) | -21% | Isolated |
| Images | PNG resize, 1600x1000 to 800x500 | 7/7 | 125 (112-156) | 81.8 (66.6-99.5) | -35% | Isolated |
| AI | Streaming JSON, 65,536 characters | 7/7 | 389 (364-413) | 295 (242-377) | -24% | High load |
| | Model overlay read, 10,000 models | 7/7 | 212 (198-222) | 1.80 (1.61-2.53) | -99.2% | High load |
| | Codex, 50,000 heartbeats per request, two cached requests | 7/7 | 1,874 (1,799-2,262) | 266 (123-364) | -86% | High load |
| TUI (ms/op) | 16 KB editor re-render, unchanged | 5/5 | 1.26 (1.25-1.32) | 0.0222 (0.0205-0.0246) | -98% | Isolated, alternating trials |
| | 50 KB plain wrap | 5/5 | 3.45 (3.33-3.52) | 1.03 (0.994-1.04) | -70% | Isolated, alternating trials |
| | Hidden tree filter, 1,000 x 1,000 | 5/5 | 43.7 (38.1-48.7) | 2.45 (2.19-5.99) | -94% | High load |
| | Streaming syntax highlight | 5/5 | 5.07 (4.96-5.68) | 0.244 (0.139-1.25) | -95% | High load |
| Chord/MCP | Frame validation, 100,000 inputs | 7/7 | 1,018 (926-1,105) | 15.5 (12.6-32.3) | -98% | High load |
| | Publication FIFO, 100,000 callbacks | 7/7 | 1,169 (651-9,761) | 2.65 (1.83-5.56) | -99.8% | High load |
| | MCP stdio, 8 MiB in 4 KiB chunks | 7/7 | 954 (909-1,151) | 5.14 (4.87-5.44) | -99.5% | High load |
| | MCP SSE, 8 MiB in 4 KiB chunks | 7/7 | 3,839 (2,152-6,210) | 8.14 (7.17-16.7) | -99.8% | High load |
| Sessions | Branch preparation, 100,000 entries | 1/1 | 1,184 | 15.2 | -99% | p50, high load; matched |
| | Session name x100, 100,000 entries | 1/1 | 52.2 | 0.005 | -99.99% | p50, high load |
| | Fork, write and reload, 10,000 entries | 1/1 | 647 | 22.0 | -97% | p50, high load |
| | Current-cwd listing, 30 sessions x 10,000 entries | 1/1 | 245 | 73.5 | -70% | p50, high load; matched |
| Durable | 10,000 retained contexts, 600 s retention | 3/3 | 8.07 (7.91-8.41) | 0.271 (0.265-0.621) | -97% | p50 |
| | Memory history, 65,536 revisions, recent read (µs) | 3/3 | 640 (606-680) | 0.668 (0.517-0.767) | -99.9% | Per-process averages |
| | 16 MiB unterminated line | 3/3 | 256 (244-257) | 12.3 (8.66-13.1) | -95% | p50 |
| Env | In-memory client, 16 MiB partial line | 7/7 | 266 (251-280) | 4.86 (2.76-8.69) | -98% | |
| | Release daemon, 16 MiB partial line | 15/15 | 250 (239-258) | 33.6 (30.8-41.7) | -87% | 3 processes x 5 |
| | Rust scanner, 1,000,000 lines | 15/15 | 34.8 (33.9-37.3) | 23.3 (21.9-40.8) | -33% | 3 processes x 5 |
| | Rust frame ingestion, 1,000 x 512 KiB | 3/3 | 44.2 (43.9-44.4) | 20.2 (19.8-22.2) | -54% | |
| Background | Acknowledged-job monitor, 1,000 jobs | 9/9 | 46.5 (44.5-48.7) | 1.00 (0.873-1.22) | -98% | |
| Evals | Offline eval CLI including startup, 1,000 pairs | 3/3 | 911 (890-1,028) | 387 (321-555) | -58% | |
| Telemetry | Reference adapter, 1,000 retained-array updates | 3/3 | 5.10 (4.84-7.98) | 0.597 (0.554-0.620) | -88% | Opt-in adapter only |
| Build/pack | Clean ten-package build, serial to two-child queue | 3/3 | 6,118 (6,103-8,797) | 4,585 (4,404-7,275) | -25% | Candidate build harness |
| | Ten-package pack | 1/1 | 3,705 | 1,787 | -52% | Final source, one pair |
| | Exact eight-package Nix pack | 3/3 | 3,352 (3,031-4,560) | 2,285 (1,593-2,314) | -32% | Final source |

The paired build used the candidate queue harness; one clean build with the final build script took 4,660 ms and produced byte-identical dist trees. The first three pack pairs (median 4,227 to 2,045 ms) predate the shared-helper extraction, so the final pack source has one pair. Pack archives, names and manifests matched exactly. The Nix row covers the install-phase pack subset, not a Nix derivation build.

### Matched qualification

On 2026-10-12 the retained runner timed 25 cases in 200 fresh processes. All 200 passed, and every case produced identical output witnesses in all eight of its processes. Each case ran serially in four rotations that alternate which root starts: before, after, after, before, before, after, after, before. `BEFORE` was a baseline checkout whose 716 tracked product source files and ten built dist trees match the baseline build; it also carried the candidate's build and pack scripts, which no case executes. `AFTER` was the qualified tree above with a fresh offline build and release Env daemon. Both roots used the same lockfile, model catalog and installed dependency files. Those inputs and the runner files were hashed before and after timing and did not change. One-minute load at process start: 9.2-9.7 for Bash, 6.9-9.4 for startup, 6.9-34.1 for Biome, 10.5-28.4 for the controls and 23.2-28.0 for the daemon controls.

Each process yields one value: the median of its emitted samples, or its one logged operation, average or median where the fixture emits nothing finer. Tables show the median (minimum-maximum) of the four process values per root, in milliseconds unless noted. **Slower** or **Faster** requires all four rotation pairs to move the same way and the two roots' process ranges not to overlap; anything else is **No clear change**. The runner's outer process time, which includes import, setup and hashing, is not used.

| Case | Clock | Samples per root | Baseline | Final | Time | Slower pairs | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Startup to RPC `get_state`, `dist/cli.js` | `spawn` return to the matching successful response | 4 x 9 | 316 (312-336) | 316 (314-328) | -0.3% | 2/4 | No clear change |
| Startup to RPC `get_state`, `dist/bundle/cli.js` | Same | 4 x 9 | 220 (218-231) | 221 (218-223) | +0.4% | 2/4 | No clear change |
| Bash tool, 64 MiB | Native call to public return | 4 x 1 | 132 (128-152) | 169 (159-183) | +28% | 4/4 | Slower |
| Bash tool, 64 MiB | Native call to spill stream `close` | 4 x 1 | 132 (128-152) | 168 (158-182) | +28% | 4/4 | Slower |
| Bash executor, 64 MiB | Native call to public return | 4 x 1 | 84.3 (81.5-85.1) | 109 (104-112) | +29% | 4/4 | Slower |
| Bash executor, 64 MiB | Native call to spill stream `close` | 4 x 1 | 84.9 (82.2-85.9) | 108 (104-112) | +28% | 4/4 | Slower |
| Biome full check, native binary | Wrapper spawn to exit | 4 x 1 | 1,847 (1,760-1,953) | 1,837 (1,736-1,957) | -0.5% | 2/4 | No clear change |
| Biome full check, forced WASM fallback | Wrapper spawn to exit | 4 x 1 | 49,219 (44,118-61,691) | 48,595 (47,613-50,657) | -1.3% | 1/4 | No clear change |

Startup ran each root's built CLI in RPC mode with no session, a temporary HOME and agent directory, network calls denied and no personal extensions or settings. Each process timed nine starts after two warmups. Earlier scratch startup figures used a different command and are not comparable.

The Bash rows are the measured cost of bounding memory. With a normal file sink, the baseline's spill-file write queue reached 6.9-10.1 MiB (median 8.4 MiB for the tool and 9.2 MiB for the executor); the final code's queue never exceeded 64 KiB, Node's default high-water mark. Writing 64 MiB took 28-29% longer, and every rotation pair was slower. The baseline executor returned before its spill stream closed in all four processes; the final executor returned after close in all four. The tool returned after close in both roots. Every process wrote exactly 67,108,864 bytes with the same SHA-256, and the display, truncation and structured-result witnesses matched. Stream `close` is not an `fsync` or crash-durability guarantee. The 20 ms delayed-sink backpressure control was not part of this rerun.

Biome ran each root's `scripts/biome-check.mjs` wrapper without `--write` over one shared payload: a clean detached checkout of the baseline commit. The fixture hashed the payload's 1,967-file Git inventory, including `biome.json` and its Grit plugin, before and after every run; it never changed. The locked Biome packages are identical in both roots. The fallback row forces the unsupported-platform branch, which checks one file at a time through Biome's Node WASM bindings. The witness is the wrapper's exit status, not its diagnostics. The slowest baseline fallback process (61.7 s) started at load 34.1.

The controls below are the 30 first-comparison increases selected for the rerun, plus the gains measured by the same cases. The first-comparison column repeats the earlier unmatched result; its fixtures, loads and process layout differ, so compare absolute values only within the matched columns. Session values are per-process medians over 15 runs at 100,000 entries, 5 runs for listings and 7 runs for working-state copies.

| Control | First comparison | Matched baseline | Matched final | Time | Slower pairs | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| AI transform (ms/op) | 0.440 to 0.670 (+52%) | 0.479 (0.456-0.491) | 0.504 (0.479-0.580) | +5.4% | 4/4 | No clear change |
| AI token estimate (ms/op) | 0.385 to 0.635 (+65%) | 0.435 (0.364-0.500) | 0.435 (0.382-0.572) | +0.1% | 3/4 | No clear change |
| AI tool validation (ms/op) | 0.0408 to 0.0577 (+41%) | 0.0420 (0.0333-0.0573) | 0.0560 (0.0432-0.0642) | +33% | 4/4 | No clear change |
| AI frame reduction (ms/op) | 0.0832 to 0.157 (+88%) | 0.136 (0.121-0.170) | 0.0903 (0.0713-0.125) | -34% | 0/4 | No clear change |
| Shared EventStream queue, 100,000 events | 10.6 to 14.4 (+36%) | 11.1 (10.3-11.8) | 11.1 (10.5-11.7) | +0.7% | 3/4 | No clear change |
| Codex 3,000-message cached pair | 15.4 to 17.2 (+12%) | 16.0 (15.7-16.2) | 15.6 (15.0-16.0) | -2.5% | 0/4 | No clear change |
| Codex 1,000 heartbeats | 3.56 to 3.90 (+9.5%) | 3.60 (3.45-3.66) | 3.61 (3.47-4.18) | +0.1% | 2/4 | No clear change |
| ASCII long-token wrap (ms/op) | 1.46 to 0.675 (-54%) | 1.53 (1.50-1.53) | 0.570 (0.546-0.579) | -63% | 0/4 | Faster |
| ANSI long-token wrap (ms/op) | 1.33 to 0.922 (-30%) | 1.41 (1.39-1.45) | 0.503 (0.492-0.517) | -64% | 0/4 | Faster |
| Prose wrap (ms/op) | 0.401 to 0.893 (+123%) | 0.426 (0.412-0.445) | 0.422 (0.390-0.436) | -1.0% | 2/4 | No clear change |
| Unicode wrap (ms/op) | 0.991 to 2.06 (+108%) | 1.01 (1.00-1.02) | 1.01 (0.990-1.10) | +0.1% | 2/4 | No clear change |
| ASCII long-token preview (ms/op) | 1.45 to 0.801 (-45%) | 1.64 (1.51-1.70) | 0.630 (0.592-0.658) | -62% | 0/4 | Faster |
| ANSI long-token preview (ms/op) | 1.43 to 1.27 (-11%) | 1.49 (1.45-1.68) | 0.610 (0.585-0.634) | -59% | 0/4 | Faster |
| Prose preview (ms/op) | 0.455 to 1.38 (+204%) | 0.465 (0.430-0.488) | 0.493 (0.479-0.504) | +6.1% | 4/4 | No clear change |
| Unicode preview (ms/op) | 0.970 to 2.90 (+199%) | 1.09 (1.02-1.20) | 1.16 (1.03-1.20) | +6.3% | 2/4 | No clear change |
| Chord JSON validation and copy | 29.7 to 58.6 (+97%) | 27.9 (26.9-31.6) | 27.5 (26.1-27.9) | -1.4% | 2/4 | No clear change |
| Codemode tool metadata render | 9.14 to 10.3 (+12%) | 6.65 (5.81-6.81) | 6.57 (6.23-7.12) | -1.3% | 1/4 | No clear change |
| Branch preparation, 100,000 entries | 1,184 to 15.2 (-99%) | 851 (757-890) | 11.1 (10.7-12.6) | -99% | 0/4 | Faster |
| Compaction preparation, 100,000 entries | 48.0 to 77.8 (+62%) | 54.9 (34.6-69.4) | 35.8 (33.4-41.7) | -35% | 0/4 | No clear change |
| Prompt boundary, 100,000 entries, no hooks | 18.6 to 29.7 (+60%) | 24.3 (12.1-27.7) | 19.5 (16.6-25.7) | -20% | 1/4 | No clear change |
| Prompt boundary, 100,000 entries, no-op hooks | 53.4 to 117 (+118%) | 73.0 (53.9-89.0) | 53.4 (50.5-74.6) | -27% | 1/4 | No clear change |
| Same-leaf context usage x100, 100,000 entries | 0.0163 to 0.0209 (+28%) | 0.0191 (0.0181-0.0290) | 0.0200 (0.0195-0.0214) | +5.0% | 2/4 | No clear change |
| New-leaf context usage, 100,000 entries | 23.0 to 55.5 (+141%) | 32.8 (29.9-36.7) | 27.6 (21.8-31.7) | -16% | 1/4 | No clear change |
| Current-cwd listing, 30 x 10,000 entries | 245 to 73.5 (-70%) | 164 (157-182) | 73.6 (64.8-96.2) | -55% | 0/4 | Faster |
| List all sessions, 30 x 10,000 entries | 158 to 192 (+22%) | 168 (162-187) | 179 (174-183) | +6.9% | 3/4 | No clear change |
| Complete working-state copy | 11.6 to 17.2 (+49%) | 12.3 (11.3-12.4) | 12.3 (11.2-12.8) | 0.0% | 2/4 | No clear change |
| Working-session memory copy | 9.02 to 11.1 (+23%) | 9.62 (9.34-9.99) | 9.79 (9.19-10.7) | +1.8% | 2/4 | No clear change |
| Memory history current read, 65,536 revisions (µs) | 0.381 to 1.37 (+258%) | 0.788 (0.691-0.937) | 0.806 (0.757-1.09) | +2.4% | 2/4 | No clear change |
| `ls`, 10,000 entries (tool unchanged) | 11.4 to 48.4 (+323%) | 25.6 (10.9-45.3) | 27.2 (16.3-54.5) | +6.6% | 3/4 | No clear change |
| Resource loader, 250 skills (unchanged) | 35.4 to 63.3 (+79%) | 70.6 (67.2-76.0) | 72.0 (66.9-100) | +2.0% | 3/4 | No clear change |
| Background job listing, 1,000 completed jobs | 47.9 to 89.1 (+86%) | 137 (120-161) | 148 (80.4-212) | +8.3% | 2/4 | No clear change |
| `OutputAccumulator` 64 MiB spill (not the Bash tool) | 114 to 151 (+32%) | 120 (96.6-122) | 116 (92.8-148) | -3.6% | 2/4 | No clear change |
| Release daemon 16 MiB read text | 9.45 to 15.4 (+63%) | 19.4 (16.6-28.1) | 15.5 (12.4-173) | -20% | 1/4 | No clear change |
| Release daemon 16 MiB read binary | 6.03 to 10.7 (+78%) | 9.50 (8.20-19.3) | 13.4 (8.62-26.4) | +41% | 3/4 | No clear change |
| Release daemon 16 MiB write | 6.19 to 11.4 (+85%) | 13.6 (11.5-23.6) | 18.2 (8.57-28.8) | +34% | 2/4 | No clear change |
| Release daemon list files, 10,000 files | 9.21 to 11.4 (+24%) | 15.3 (13.9-16.5) | 14.1 (11.5-19.5) | -7.8% | 1/4 | No clear change |
| Release daemon list directory, 10,000 files | 61.9 to 55.8 (-9.9%) | 117 (90.7-137) | 81.9 (61.3-133) | -30% | 0/4 | No clear change |

Matched CPU time showed no clear change either: AI transform +5.3%, token estimate +3.5%, tool validation +29% (3/4 pairs slower), frame reduction -8.4%, EventStream queue -1.6%, Codex cached pair +1.8% and 1,000 heartbeats +0.7%. Three controls were slower in all four pairs but stayed within overlapping ranges: AI tool validation (+33%), AI transform (+5.4%) and prose preview (+6.1%). Four were faster in all four pairs, also within overlapping ranges: AI frame reduction (-34%), the Codex cached pair (-2.5%), compaction preparation (-35%) and the daemon directory listing (-30%). The daemon binary read (+41%) and write (+34%) ran at load 23-28 and did not move consistently. Watch the three consistently slower controls in later runs.

Before timing, three functional smoke runs failed and were kept. The 20-entry branch smoke found nothing to compact under the full retention budget (baseline, exit 1). The boundary witness differed because the faux provider's token estimates include generated paths (final root). The `ls` check required a details object that the baseline omits for an untruncated listing (baseline, exit 1). Each repair changed only the fixture: a smoke-only compaction budget, a boundary witness without `durationMs` and the faux `input` and `totalTokens` fields (raw usage is still logged), and optional `ls` details. A last smoke run of the 11 remaining cases passed all 22 attempts. `qualification.smokeAttempts` lists every attempt.

### Unmatched and unchanged observations

These first-comparison increases have no matched rerun and so establish neither a regression nor a gain: context usage at 10,000 entries (new leaf +29%, same leaf +14%; one p50 each under high load); retained-context p50 with zero retention at 0 and 1,000 contexts (+75% and +19%, ranges overlapping) and with 600 s retention at 0 contexts (+8.7%); current history reads at 8,192 revisions (+15%); Env tail reads (+4.6%); the 256 KiB short-line control (+5.5%); and the release daemon at 1 MiB and 4 MiB: text read +44% / +52%, binary read +91% / +82%, write +72% / +126%, file listing +33% / +26%, and the 1 MiB long line +12%. At 16 MiB the matched rerun found no clear change for the same read, write and listing operations.

Unchanged within overlapping ranges: PNG-to-JPEG fallback 301 to 289 ms, JSON read selection 7.12 to 6.80, faux agent 6.15 to 6.15, Codemode sandbox 52.0 to 53.4, compiled schema 9.41 to 9.64, split summaries 201 to 204, 16 KB typing 1.44 to 1.40 ms/op, Unicode typing 0.842 to 0.795 ms/op, eval CLI with 100 pairs 103 to 101, and 10,000 contexts with zero retention 0.285 to 0.298 (p50).

### Work and memory counts

These are deterministic counts from the first comparison, not latency claims.

- Background monitor: steady-state job/state reads 2,000 to 0 for 1,000 acknowledged jobs; receipt entries unchanged.
- Env client, 50,000-name listing run: `Buffer.from` calls 19,973,128 to 350,000; request histogram unchanged.
- Rust: frame ingestion allocations 5,000 to 4,000 (1,049,238,000 to 524,950,000 bytes); scanner allocations 2,000,090 to 9.
- MCP HTTP 503: bytes pulled to build the bounded error 8,388,608 to 12,288; the first 8,192 characters are unchanged.
- SQLite, 30 document deltas: SQL calls 210 to 150 and string-binding bytes 1,431 to 771; task replacements 150 to 120 calls. WAL growth is unchanged, and no-op writes still issue zero SQL calls.
- Trade-offs: queued JSON frames use more transient heap (median 56,270,736 to 136,608,504 bytes) while CPU falls from 418 to 213 ms per operation. The two-child build raises median sampled RSS by 1.65% and the highest observed peak by 23%; no memory reduction is claimed.

### Behavior witnesses

- Native reads, grep and edits: every printed result hash and length matches; diff rows also match display, unified patch and first changed line. Images match bytes, MIME type and dimensions.
- Chord/MCP: frame truth table, FIFO order, exact stdio result, SSE payload/id and the HTTP 503 prefix are asserted. Eval CLI journal bytes and hashes match. Pack and Nix archives match exactly.
- Weaker first-comparison witnesses: the original TUI checksum is cumulative rendered length, so exact rows rest on owner and differential tests. AI, sessions, daemon, report and telemetry rows rely on fixture assertions without a full output hash.
- Matched qualification: every case emits semantic output witnesses. Bash checks the exact spill bytes and hash plus display, truncation and structured output. Startup checks only a successful `get_state`, and Biome only the wrapper's exit status. The session list witness excludes activity-clock ordering, which owner tests cover. The AI queue witness is an aggregate, not a FIFO-order proof. The spill control is the synchronous `OutputAccumulator` push path, not the Bash tool. The faux provider reports zero cache usage, so no run here supports a prompt-cache hit claim.

## Setup and commands

Use separate isolated worktrees with their own package-manager-managed dependency installations. Do not link `node_modules` between roots. Node 24.21+ supplies native TypeScript stripping, synchronous resolver hooks and `node:sqlite` used here. Earlier runtimes must independently qualify those APIs. `rg` must already be on PATH for grep; the fixture refuses automatic downloads.

```sh
# In each selected checkout. No arbitrary dependency lifecycle scripts.
npm ci --ignore-scripts
# Source APIs importing providers require hydrated model JSON, including .manifest.json.
# CATALOG is the same verified frozen models.all.json for both roots; this hydration is offline and untimed.
node packages/ai/scripts/hydrate-model-catalog.ts "$CATALOG"

# From the checkout containing these retained fixtures. --list does not import/run product code.
node scripts/performance/run.mjs --list
node scripts/performance/run.mjs --repo "$AFTER" --groups tools,images,ai,tui,bridges,sessions,durable,env-client,evals,telemetry,background --smoke --out "$RESULTS/smoke"
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" --groups tools,images,ai,tui,bridges,sessions,durable,env-client,evals,telemetry,background --repeat 3 --out "$RESULTS/paired"
# TUI's original paired probe used five alternating trials.
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" --groups tui --repeat 5 --out "$RESULTS/tui"
# A case name can replace a group: e.g. edit-fuzzy, codex-burst-50000, background-monitor.
```

`BEFORE`, `AFTER` and `RESULTS` are caller-selected absolute directories, not configuration/account/session paths. The output directory must not already exist. Before spawning, the runner saves the attempt's command, load, exclusive log and `running` status. Sanitized complete stdout/stderr lines are appended as they arrive. Completed verification is `passed`; spawn/exit/verification errors are `failed`. An interrupted `running` or `verifying` attempt is unverified, distinct from unattempted cases absent from results. After an error, inspect the saved manifest/log and rerun only the failed/unverified/unattempted case names into a new directory; do not overwrite or silently reuse changed inputs.

The runner executes one child at a time and alternates root order on successive repeats. Each child has a temporary HOME, agent directory and temp directory; provider/auth variables, `NODE_OPTIONS`, shell startup hooks and user npm configuration are not inherited. Network fetch/WebSocket/HTTP/TCP calls fail; faux Codex sockets and injected in-memory HTTP responses stay local. Local Unix sockets are permitted for the background-command lease. No provider, Docker, SSH, authentication or real session data is needed. Evals replaces only the existing Docker boundary through a resolver hook; actual CLI/plan/report/persistence run and their generated `.eval` directory is removed afterward.

The native source resolver from **the selected root** resolves workspace imports. The retained hook maps `/pi-performance-source/` imports into that same root. No stale dist fallback, production source copies or new dependency/framework is introduced. The `source` export condition is intentionally omitted: the locked `@vitest-evals/core` package advertises an unshipped source entry. Workspace imports still resolve to source; third-party dependencies use their shipped public entries.

## Workloads and timing boundaries

`--list` is the exact input/command inventory. `--smoke` deliberately shrinks inputs/repetitions and never establishes a gain. Below are full-size defaults; `--repeat` creates independent fresh-process trials in addition to each fixture's internal samples.

| Group / retained fixture | Input and samples | Warmup and measured region |
| --- | --- | --- |
| `tools` / `tools.mjs`, `cpu.mjs` | 32 MiB LF text; head/middle/10-line page; 8 MiB JSON selection; one grep hit/context. Edits: generated ~7.16 MB text, 32 targets, exact/fuzzy/diff. 7 samples | No explicit operation warmup. Excludes fixture/import/GC; includes native operation plus original checksum/assertion overhead. Diff checks content, display, unified patch and first changed line |
| `images` / `cpu.mjs` | Deterministic 1600×1000 RGBA palette encoded as PNG, resize to 800×500; base64 budgets 4,718,592 and 50,000; 7 samples | Photon/fixture loading excluded; original operation includes output digest. In-process WASM owner; not worker/terminal/provider latency |
| `ai` / `ai.mjs` | 65,536-character content, 64-character JSON deltas; 128 tools × 8 fields, 3,000 messages; 100,000-event queue control. 7 samples × 3 operations (queue ×1) | One operation warmup per selected case; GC/setup excluded; assertions included. Fixed synthetic timestamps make witnesses reproducible |
| `ai` / `catalog.mjs`, `codex.mjs` | Catalog overlays 30/3,000/10,000 models; 100/10/10 reads, 7 samples. Codex: 3,000×1,024-byte messages or 20×128 bytes with 1,000/50,000 heartbeat events/request; 2 cached requests/pair, 7 samples | Catalog offline refresh excluded, no separate read warmup. Codex one pair warmup; real conversion/continuation/queue with mock sockets. Retained-payload mutation and full/delta envelopes checked |
| `tui` / `tui.ts` | 16 KB stream/editor/input/prose, 64 KB Mermaid control; hidden tree depth 1,000 × 1,000 visible leaves. Mostly 40 operations, tree 5 | Components prepared before measurement; unchanged-prefix highlights counted separately. Exact final render witnesses exclude timing/highlight counters. Null terminal: no emulator/write throughput claim |
| `tui` primitives | 40-char draft 10,000 unchanged/cursor operations; 16 KB draft 40 unchanged/cursor/ASCII-typing operations; 14,000 UTF-16-unit Unicode draft 40 typing operations; 50 KB plain/ANSI wraps ×40; 10 KB Input movement ×100 | Initial render plus up to 40 warm operations per phase. Retains original paired probe's inputs and controls without copied source. Growth from warm typing is part of the fixture |
| `sessions` / `sessions.mts` | 10,000/100,000 archived entries, 128-byte payload; projection/name/branch/boundary/context ×15 runs. 10,000-entry controls: fork, list (30 files) and split ×5 runs, working-state copies ×7 runs | Three warm operations per phase. Each logged value is the median of its phase's runs. Setup outside timing. Complete-working-state copying stays validated; split uses two delayed faux summaries, not model parallelism |
| `durable` / context/history/lines | 0/100/1,000/10,000 completed context-reading conversations, retention 0/600,000 ms; 120 root samples. History 1,024/8,192/65,536 revisions, base each 32, ancient/recent/current ×1,000 reads. 1/4/16 MiB terminated/partial lines ×7 | Scheduler fixed clock; one root warm task, seed time separate. Historical warm read; line warm read/open/validation/close excluded. Fixed 256 KiB short-line control includes per-line assertions |
| `durable` / storage | 1 KiB/1 MiB document payload, 30 scalar changes/no-ops and task replacements | Public SQLite facade instrumented: SQL calls, UTF-8 binding bytes, WAL growth. Not a wall-time benchmark. No-ops must remain zero SQL/WAL |
| `env-client` / `env-client.mjs` | 3-byte reads ×1,000; 524,289-byte full-tail reads ×50; unsorted 50,000 Unicode names ×7; 1/4/16 MiB partial lines ×7 | In-memory Connection-shaped fixture only; no warmup. Counts requests and Buffer conversions; assertions/hash outside elapsed intervals. Excludes protocol/daemon/filesystem/SSH |
| `env-daemon` / `env-daemon.mjs` | Release daemon over local pipes: 1/4/16 MiB, 1,000/1,000/10,000 files; 5 samples/operation | One warm operation; startup separate. Text/binary/write/long-line/scan/list checks. Client CPU is not daemon CPU |
| `env-scan` / `env-scan.rs` | 1,000,000 `é😀\n` lines, 64 KiB chunks ×5; 512 KiB incoming frames ×1,000 control | Actual selected decode/scan/frame modules; fresh scratch crate. Build/setup outside printed scanner intervals. Counting allocator overhead included; no uninstrumented throughput claim |
| `background` / `background.mjs` | 1,000 acknowledged terminal jobs, receipts in groups of 20; 9 boundary scans, 2 warmups | Real extension/faux foreground run holds delivery lease. Separate untimed job/state read count; durable receipt count/IDs checked. No jobs launched |
| `bash` / `bash.mjs` | Actual Bash tool/executor with deterministic drain-respecting Node producer: 64 MiB, 64 KiB tiles; normal sink and 20 ms delayed fs `_write`/`_writev` sink. Smoke uses 128 KiB | One operation/process, no warmup. `publicReturnMs` runs from just before the native call to its public return; `persistedCompletionMs` ends at the spill stream's `close` event. Both exclude payload generation, hashing, import and process startup, and include the real producer plus per-write queue/memory instrumentation. Compare throughput by persisted completion: the baseline executor can return before its spill file is complete. Stream close is not an `fsync` or crash-durability guarantee. Checks final spill bytes/hash and displayed/structured output; also reports bytes and stream state at public return. The 20 ms sink is a backpressure control, not a throughput comparison. Default private file creation/high-water mark are untouched |
| `qualification` / existing fixtures | `ai-common-controls`: transform/estimate/validate/frames only. `history-current-65536`: `--current-only`, 1,000 current reads at 65,536 revisions. `ls-10000` (500-entry limit), `resources-250` (skill reload) and `background-1000` (listing completed jobs) ×7 runs; `spill-64mib` ×3. `startup-bundled`: `dist/bundle/cli.js`. `env-daemon-controls-16777216`: 16 MiB text/binary reads and write, 10,000-file listings, without the long-line and scan operations | Same clocks as the parent fixtures; `ls`/resource/listing/spill runs time one operation each with GC, setup and witness outside. The full `history` and `env-daemon-*` defaults are unchanged |
| `evals` / report/persistence | 100/1,000/10,000 pairs and 0/1/10 MiB sessions ×7. Persistence: 100/1,000 paired arms, 3 fresh CLI samples +1 warmup | Report setup/hash/validation excluded. CLI includes process startup and actual persistence; local missing-report arms and expected blocked-pair exit 1. No Docker/model calls |
| `telemetry` / `telemetry.mjs` | 10,000 spans; 10 snapshots; one retained 10,000-element array with 20/1,000 scalar updates | No explicit warmup; original callback/assertion overhead included. Opt-in in-memory reference adapter, not normal CLI instrumentation |

## Build, pack, Rust, startup and matched qualification

These expensive groups are opt-in and require an exclusive task-owned CPU lane; unrelated host activity must still be recorded. Build runs remove only generated `packages/*/dist` for the ten runtime packages; use disposable isolated roots. Prebuild offline before pack/startup. Model hydration must be identical across compared roots and completed before timing.

```sh
node scripts/performance/run.mjs --repo "$AFTER" --groups build --repeat 3 --out "$RESULTS/build"
# Compare pack algorithms over one identical already-built payload, not different product revisions.
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" --artifact-repo "$PAYLOAD" --groups pack --repeat 3 --out "$RESULTS/pack"
# Exact Nix install-phase subset. Fix the payload to the built after root.
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" --artifact-repo "$AFTER" --groups nix-pack --repeat 3 --out "$RESULTS/nix-pack"

# In each measured root; pinned toolchain and locked release dependencies, setup outside timing.
cargo +1.96.0 build --release --locked --offline --manifest-path packages/env/daemon/Cargo.toml
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" --groups env-daemon,env-scan --repeat 3 --out "$RESULTS/env-native"

# Matched qualification as recorded: four rotations per case.
# Normal-sink throughput; bash-tool-slow and bash-executor-slow are the separate backpressure control.
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" --groups bash-tool-normal,bash-executor-normal --repeat 4 --out "$RESULTS/bash-normal"
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" --groups startup,startup-bundled --repeat 4 --out "$RESULTS/startup"
# One fixed clean Git payload; wrapper and dependencies come from each selected source root.
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" --artifact-repo "$PAYLOAD" --groups biome --repeat 4 --out "$RESULTS/biome"
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" --repeat 4 --out "$RESULTS/controls" \
  --groups ai-queue-control,codex-cached,codex-burst-1000,tui-wrap,tui-preview,bridge-metadata,bridge-json,sessions-branch-100000,sessions-boundary-100000,sessions-context-100000,sessions-list,sessions-working,ai-common-controls,history-current-65536,ls-10000,resources-250,background-1000,spill-64mib
# Uses each root's release daemon.
node scripts/performance/run.mjs --before "$BEFORE" --after "$AFTER" --groups env-daemon-controls-16777216 --repeat 4 --out "$RESULTS/daemon-controls"
```

- `artifacts.mjs` invokes the public production build/artifact API. Clean build elapsed includes subprocesses; dist SHA-512 covers relative names, bytes and permission bits. Source changes can legitimately change build hashes; compare build algorithms over the same source before claiming equivalent artifacts. Pack elapsed excludes digest validation; tarball/manifest hashes must match when `--artifact-repo` fixes the complete payload. Package manifests/README/assets also affect tarballs; keep the whole payload root fixed.
- `env-scan.mjs` copies only the selected daemon Cargo manifest/lock/toolchain into its own scratch crate and compiles the selected source modules; it adds no dependencies or production export. Uses existing Cargo/Rustup caches offline. Missing pinned toolchain/cached dependencies is a setup failure, not permission to substitute another compiler or enable networking. `env-daemon` and `env-daemon-controls-16777216` use the measured root's release binary; record its build qualification/hash separately.
- Isolated startup uses the real built CLI's RPC `get_state`, 2 fresh-process warmups and 9 samples per fixture process. Each sample starts when `spawn` returns and stops at the matching successful `get_state` response. CLI profile helper remains available as a public command; CPU profiles must use PID-unique names so launcher/worker cannot overwrite one another. Do not interpret post-ready background work as startup. Portable isolation intentionally does not load personal extensions/settings; configured-startup measurements require separately sanitized receipts and exact external extension revisions.
- The retained startup command adds a network-denial preload and fully isolated HOME/cwd. This differs from historical scratch startup runs: collect both roots with this command rather than transplanting their old numbers. Fixture hashes and timing boundaries must match any published comparison.
- Biome runs each selected root's production wrapper without `--write`, over the fixed `--artifact-repo` scan cwd; paired runs require this option. Native dependency resolution remains owned by the selected wrapper. Before timing, the fixture records the fixed payload's complete Git inventory/content hashes plus explicit Biome config/Grit hashes; it checks identity again after the scan. Input witnesses reject changed payloads across roots/repeats. Use a clean disposable Git payload with no ignored files in configured scan paths; the recorded run used a clean detached checkout of the baseline commit. Forced unsupported-platform fallback uses a local preload, not Android device qualification. Full scan includes startup; inventory/hashing is outside that operation interval. Separate static initialization/load evidence from wall-time gain; native wrapper/direct baseline ranges can overlap.
- `nix-pack.mjs` reproduces exactly eight named tarballs through the selected root's `pack-nix-packages.mjs`; a baseline predating that driver runs the exact former public install-phase npm recipe. The final driver derives its own root, so set `--artifact-repo` to the after root. Archives/names must match. This qualifies local packaging only, not an actual Nix derivation or all Nix platforms. The fleet consumer now uses the public artifact API; the obsolete shim is retired rather than duplicated here.

## Evidence and interpretation

`manifest.json` records the exact revision, measured source-file SHA-256 map (including hydrated provider JSON), dependency lock, fixture hashes, workload args, Node/OS/CPU/RAM, per-process starting load, attempt status/command, full sanitized JSON records and log filenames. Manifest replacement is atomic. Logs contain full stdout/stderr from completed children; interrupted logs retain completed lines received so far. Root/payload/temp/harness paths are replaced with placeholders; no settings/accounts/session contents are read or retained. `provenance.json` identifies original proven research fixtures by their content hashes and the exact baseline; the retained files are the reproduction source, never a required private scratch path.

Each fixture emits `verification` with input and output SHA-256. The runner requires at least one witness, compares corresponding witnesses across roots/repeats, checks source identity after each process, and fails on changed output/source or a nonzero fixture exit. Witnesses hash actual results/rendered rows/semantic scalars; original independent assertions cover byte/text/count/order contracts. They are not a complete conformance suite. Timing/allocation/highlight/SQL/read counters are intentionally excluded from semantic hashes because these are optimization targets. Build output changes and unfixed-payload pack comparisons are explicitly not asserted equal; their hashes are still recorded.

[`performance-results.json`](performance-results.json) keeps every first-comparison row behind the results above (n, median, range, raw values when there are 50 or fewer, sample kind, measurement set and starting load). Its `qualification` section keeps every matched row with per-process values, every emitted raw sample, starting loads, the result rule, both roots' source maps and artifact hashes, the runner's fixture hashes and every smoke attempt. Rows marked `summary` hold one logged median per process because the fixture did not emit its internal samples.

Use operation rows, not the runner's process `elapsedMs`, for source-owner timings. The outer elapsed includes import/setup/cleanup/hashing and is only diagnostic. Summarize medians and ranges of raw samples; report sample/trial counts and controls. Heap deltas, client RSS and process-wide `maxRSS` are diagnostics, not precise allocation ownership or aggregate daemon/build process-tree memory. Do not claim live-provider latency, all-platform/device gains, current external MCP-adapter gains, normal-CLI Env/Durable/reference-telemetry gains, or production Codemode metadata gains from these microbenchmarks.
