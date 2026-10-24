# Session listing measurement record

This work addresses [pi#251](https://github.com/fitchmultz/pi/issues/251). Measurements use synthetic valid journals in an isolated Debian Linux cloud workspace. They do not measure Mitch's installed macOS runtime or private sessions.

## Results

Warm source listings and the complete source picker operation are faster on both synthetic workloads. Cold initialization is not improved. Every semantic witness matches across all 20 processes, with zero fixture errors.

Times are medians with minimum to maximum ranges in milliseconds. Each side has five fresh-process trials per size.

| Input | Operation | Before, ms | Candidate, ms |
| --- | --- | --- | --- |
| 12 files, 22,466,376 bytes | Cold list and cache population | 93.37 (83.44 to 99.00) | 106.84 (97.37 to 117.14) |
| Same | Warm complete list | 74.55 (59.41 to 82.92) | 4.92 (4.20 to 11.82) |
| Same | Warm current-project list | 15.85 (14.82 to 21.25) | 2.33 (1.99 to 3.23) |
| Same | Warm picker load, search, render, and selection | 87.58 (78.51 to 104.06) | 17.41 (13.45 to 19.01) |
| 64 files, 949,059,244 bytes | Cold list and cache population | 1857.22 (1739.45 to 2548.89) | 2012.96 (1814.34 to 2629.54) |
| Same | Warm complete list | 1710.35 (1624.01 to 1778.35) | 17.89 (16.37 to 19.95) |
| Same | Warm current-project list | 438.87 (392.06 to 463.51) | 8.32 (5.22 to 10.23) |
| Same | Warm picker load, search, render, and selection | 2284.40 (1766.37 to 2536.29) | 51.91 (49.49 to 58.75) |

The workloads return 1,536 and 32,768 messages, with 83,168 and 1,780,096 search characters respectively. Progress advances once per source candidate and publishes sorted partial results. The before and candidate result hashes match at both sizes.

The [raw manifest](measurements/manifest.json) contains all commands, samples, counters, hashes, loads, and parsed stdout records. The candidate was measured before commit. Its product-source hash map identifies the measured code independently of the shared baseline HEAD value. Documentation and evidence files were added outside the timed region.

A [separate baseline CPU profile](profiles/baseline-summary.json) attributes 603 of 1,587 samples to JSON-line parsing, 310 to UTF-8 decoding, and 241 to line splitting. A [separate warm built-SDK profile](profiles/warm-summary.json) instead spends work on date-context validation (420 of 1,552 samples), cache decoding, and filesystem metadata/open/read operations. It completed [100 full listings](profiles/warm-work.json), returning 6,400 sessions and counting 3,276,800 messages without opening a journal stream. Profiles are not comparative wall-clock samples.

The large warm-list gain is below the input-to-retained-text reduction. It avoids decoding and parsing roughly 949 MB of journal data while still reading complete cached search text and checking each file. It does not imply a similar gain for text-heavy journals, a cold cache, another filesystem, or the owner's private 49 GB corpus.

## Provenance

The admission baseline is `c17adbc400319887c5ab34fce1ed2a59be746da4`, freshly resolved from `fitchmultz/pi` main. Candidate source hashes, dependency-lock hashes, hydrated model-data hashes, fixture hashes, commands, workload arguments, load averages, and every sample are retained in the measurement manifests. Both source roots use separate `npm ci --ignore-scripts` installations and byte-identical model data.

The actual configured coding model is `openai/gpt-6.1-sol` with `xhigh` thinking. The coordinator verified this exact active chat through a supported authenticated read-only owner configuration API. [Model evidence](model-evidence.json) records the timestamp, canonical configuration, and receipt hash. No model, provider, account, connection, or future-chat default was changed.

The issue body's historical samples were collected on 2026-10-23 22:36 to 23:45 PDT under the older installed native selector `403a2713/2005895e` and public dist `045a331e`. They precede the 2026-10-24T13:07:48Z switch to the `c17adbc4` native runtime. They are diagnosis hints only and are not the before side of this comparison.

At `2026-10-24T13:07:48Z`, the installed native selector changed to `c17adbc400319887c5ab34fce1ed2a59be746da4-0d1fed76471a6053-node24.22.1-darwin-arm64`. Public Pi changed to `0.50.0 dist09b93d7fea1539a8e23003be654cc3bd02064d5f0e8487c2ec35f75f02c02b86` from subagents source `4906e67e3a6701a753df3af112304dea2246aeb1`. This work neither installed nor measured those macOS runtimes.

## Workload and clocks

The retained `session-listing` cases use 12 files with 128 messages each and 64 files with 512 messages each. Seven of every eight messages contain synthetic tool output. The remaining messages contain complete searchable user text, including Unicode and a unique late-row marker. Journals are distributed across four project directories.

Each fresh process measures the first `SessionManager.listAll()` with an empty derived cache, a second complete listing, a current-project listing, and a new real `SessionSelectorComponent`. The picker switches to all projects, loads the real listing API with progressive results, accepts a quoted tail-text query, renders the result, and selects the matching session. The picker clock includes those operations, not application launch or terminal-emulator display. The initial current-scope loader is empty in the picker case; project listing is timed separately through the real SDK API. The picker waits for complete all-project results, not just the first partial result. Imports, fixture generation, assertions, and result hashing are outside the reported operation clocks.

There are five paired trials per size. Pair order alternates before/after and after/before to counter drift. All attempts are serial. Both sides have freshly written, filesystem-warm synthetic inputs. Candidate warm operations have a populated derived cache. Baseline has no such cache. This is the intended implementation change, not an unnoticed tuning difference.

The fixture asserts every session count and message count, exact cold/warm metadata equality, the full-text search result, the selected path, progress counts, and a semantic output hash. No result is accepted on timeout or error. Work counters include input bytes, output sessions, message totals, and retained search characters.

The first fixture smoke failed because the fixture used an arbitrary project-directory name instead of Pi's native cwd encoding. The fixture was corrected to use `getDefaultSessionDir()`. That failed attempt is retained with the run evidence.

## Design decisions and independent review

The scanner remains authoritative. A bounded header or tail read cannot preserve exact message counts and full search text. An incremental append index would need to repair incomplete final lines and distinguish rewrites. A complete disposable scan-result cache avoids that additional state machine.

The first cache design used a central per-path directory. Independent review found that deleted journals could leave plaintext behind. The design now puts records in a private directory beside the journals. Enumeration prunes missing sources, including dangling journal symlinks. Picker deletion removes the record and associated temporary publications. Writers check the source revision around publication. A real child-process exit before rename reproduces interrupted-publication cleanup in regression coverage.

Independent review also checked count, name-clear, activity, branch, search, scope, cancellation, symlink-alias, mutation-isolation, and concurrent-writer contracts. Separate read-only follow-up reviews found no remaining actionable findings in the retention and date-context fixes. Those reviewers inspected supplied red/green logs rather than running tests. These source reviews do not replace current-head GitHub reviews or runtime tests.

Standalone cleanup also reproduced a date-context error: an accepted zone-less header cached under UTC had a different authoritative date under Los Angeles. Records now match the parser runtime and timezone context. Real child processes reproduce the red case and verify rescanning and subsequent warm reuse. Context-discovery failure falls back to the source.

The cache adds disk writes and date-context validation on cold scans and duplicates full searchable text. Both cold medians are higher in the final run; their ranges overlap. Cold initialization is not the optimization target. Read-only directories, unsupported dates, and filename/storage limits retain the uncached path. Search normalization and session-open parsing are unchanged. See [the cache contract](../../../packages/coding-agent/docs/session-listing.md).

## Reproduce

Use two isolated source roots and the same frozen model data. Run the candidate's retained harness against both roots.

```sh
# In each root, before measurement.
npm ci --ignore-scripts
node packages/ai/scripts/hydrate-model-catalog.ts "$CATALOG"

# From the candidate root. The output directory must not exist.
node scripts/performance/run.mjs \
  --before "$BEFORE" --after "$AFTER" \
  --groups session-listing --repeat 5 --out "$RESULTS"
```

Profiler runs are separate and are excluded from comparative timings. The fixture supports `PI_LISTING_CPU_PROFILE` when invoked directly with the repository source resolver and the offline source hook. Set `HOME`, `TMPDIR`, `PI_CODING_AGENT_DIR`, and `PI_PERF_REPO` to task-owned synthetic paths. A second built-SDK profile repeats warm listings after cache priming. Profile results count completed work and journal stream reads.

## Verification limits

No dependency, lockfile, package peer, Node support floor, provider contract, or public SDK signature changes. Existing `getFileRevision()` supplies nanosecond file identity. Native Node filesystem APIs used here are available at the repository's Node 22.19.0 support floor. The [Node 22.19.0 filesystem contract](https://github.com/nodejs/node/blob/v22.19.0/doc/api/fs.md#filehandlewritefiledata-options) confirms abortable file-handle writes. This is a core fork change, not an extension host-compatibility change, so an official-Pi extension matrix is not applicable.

The built public SDK and bundled Linux CLI are exercised on synthetic sessions. The real CLI runs in a PTY, searches text that is not the name or first-message preview, resumes the expected journal, and exits successfully without a model prompt. Actual synthetic journals, extension receipts, and the terminal capture are retained. No private journal, request log, installed extension, selector, live session, or account cache was accessed.

Repository checks, the successful full offline suite, package consumers, prior failed attempts, and platform/provider skips are recorded in [the verification summary](verification.md). Current-head CI and enabled GitHub review conclusions are recorded on the PR, separately from these pre-commit artifacts. A skipped platform or provider test is not a pass. No live installation, activation, restart, deployment, package publication, merge, or auto-merge is authorized by this work.
