# Extension module import measurement

## Verdict

Independent asynchronous imports are faster on this synthetic Linux workload. Bundled CLI startup to a successful RPC `get_commands` response changed from 767.73 ms to 625.16 ms. The TypeScript-heavy, low-wait control has no measurable end-to-end improvement.

These are fresh source-build measurements for [issue 250](https://github.com/fitchmultz/pi/issues/250), not installed macOS measurements. The historical issue-body samples came from the old installed runtime. None of those samples is used as the before side here. No result predicts the saving for the owner's private extension set or recovers a presumed 200 ms.

## Inputs and boundaries

- Before source is admission `origin/main` at `c17adbc400319887c5ab34fce1ed2a59be746da4`.
- After runtime source is the loader change in this PR. [Identity hashes](identity.json) identify both loaders, dependency locks, model-data manifests, and CLI entries. The archive includes complete built companion file maps. A final rebuild after formatting produced identical measured loader JavaScript and bundled CLI entry hashes.
- Both worktrees have independent `npm ci --ignore-scripts` installations from the same unchanged lock. Both use the same hydrated public model data and coherent local companion builds.
- Toolchain is Node 24.22.1, npm 11.19.1, jiti 2.7.0, TypeScript 7.0.2, and esbuild 0.28.2. Host is Debian 13, Linux x86-64, with two available CPUs. One-minute load during the matched run ranged from 0.46 to 1.41. No builds or test suites ran during that comparison.
- Six synthetic TypeScript extensions register six tools, six commands, and six distinct flags. Asynchronous imports wait for 60, 50, 40, 30, 20, and 10 ms. Every factory waits for 2 ms. The low-wait control instead has 2,000 typed declarations per module and a zero-delay timer.
- Each side gets one untimed fresh-process warmup per case, then five alternating before/after samples. Each product run is a fresh process. Filesystem and jiti transform caches remain warm and separate per side and workload. Factories and module evaluation still execute on every run.
- Comparative runs have no CPU profiler, `PI_TIMING`, or `JITI_DEBUG`. Synthetic import and factory receipts are part of both fixtures. Fixture creation, dependency loading in the parent, and final receipt validation are outside the timed region.
- The micro timer wraps the real built loader's first `loadExtensions` call, including lazy jiti setup and factories. RPC timing starts immediately before argument preparation and spawn, and ends at the matching successful `get_commands` response. It includes the actual CLI launcher and worker. A preceding `get_state` must also succeed. Shutdown and transcript validation are not timed.
- The network-denying repository preload, isolated HOME and agent directory, `--no-session`, and explicit extension paths prevent provider calls or access to personal resources.

## Matched results

Each cell is median and minimum-to-maximum milliseconds across five fresh processes. No sample was discarded. [All result rows](results.json) and the [raw evidence archive](raw-evidence.tar.gz) retain the commands, environment, source hashes, successful responses, and import receipts.

Per-run stdout JSONL stores the fixture result and the actual parsed RPC messages, not a verbatim child stdout stream. Import JSONL was retained directly. The standalone smoke also retains verbatim CLI response JSONL. The archive includes a SQLite import of all 99 attempts; its measured medians and ranges match the JSON analysis.

| Workload | Boundary | Before ms | After ms | Verdict |
| --- | --- | ---: | ---: | --- |
| Asynchronous imports | Loader | 361.16 (349.92 to 398.86) | 201.87 (200.76 to 228.56) | Faster |
| Asynchronous imports | Bundled CLI RPC | 767.73 (751.21 to 833.03) | 625.16 (612.82 to 651.69) | Faster |
| Asynchronous imports | Unbundled CLI RPC | 1102.30 (1064.19 to 1117.29) | 909.59 (885.79 to 961.09) | Faster |
| TypeScript-heavy, low-wait | Loader | 168.20 (158.55 to 171.13) | 159.42 (147.25 to 168.34) | No clear change |
| TypeScript-heavy, low-wait | Bundled CLI RPC | 574.18 (532.37 to 608.35) | 585.49 (526.80 to 588.82) | No clear change |
| TypeScript-heavy, low-wait | Unbundled CLI RPC | 904.01 (825.04 to 961.72) | 876.49 (858.11 to 969.95) | No clear change |

The bundled user-boundary reduction is 142.57 ms, or 18.6%, not the micro result's 44.1%. The micro boundary excludes launcher/worker bootstrap and uses an unbundled loader context; its median is not a component fraction of bundled startup. All 60 measured product runs passed. They completed 360 module evaluations and 360 factories. All 40 measured RPC starts returned both successful responses and all six commands in order. There were zero measured failures. Twelve warmup runs also passed.

## Limiter and timing diagnostics

Separate instrumented processes used Node CPU profiles, `JITI_DEBUG=1`, `PI_TIMING=1`, and the synthetic receipts. Both launcher and worker profiles are retained with PID-specific names. These runs do not contribute to the table.

The asynchronous baseline had one active module evaluation. The candidate had six. Warm bundled diagnostics recorded approximately 212 ms of summed module waits and 13 ms of factory work on the baseline. The candidate retained approximately 214 ms of summed overlapping waits and 13 ms of sequential factory work. Its longest requested wait is still 60 ms. The extensions timing namespace changed from 264 ms to 111 ms in those diagnostic runs. These single instrumented samples explain overlap, not an additional comparative latency claim.

Cold TypeScript-heavy profiles show synchronous jiti/Babel transformation. One baseline diagnostic logged six transforms of approximately 467, 176, 141, 201, 138, and 132 ms. Concurrent promises do not put those transforms on multiple threads. Warm worker profiles still show module compilation and bootstrap work outside the synthetic waits. The unchanged factory chain, the longest module wait, and single-threaded compilation bound the saving. The low-wait control's overlapping ranges do not establish a speedup.

`PI_TIMING` now reports one `module imports` wall-time entry per batch, followed by per-extension factory entries. Summing individual overlapping import durations would overstate startup time. Per-module compile details remain available through separate jiti diagnostics.

## Behavior and compatibility

Import outcomes occupy discovery-order array positions. All imports settle before any factory starts. Factories, registrations, successful extension output, and errors remain sequential in discovery order. Failed imports cannot create unhandled rejections while another factory runs.

Module-level side effects can interleave and run before factories. Extensions must not use another extension's factory as a prerequisite for their top-level evaluation. This is an intentional consequence of concurrent imports, not a claim that all JavaScript module side effects are independent. Cross-extension registration and event setup belong in factories.

The change keeps existing per-path jiti instances, aliases, virtual modules, TypeScript resolution, module-cache settings, cache-generation checks, validation, failure messages, and factory discard/commit behavior. Tests cover actual TypeScript top-level await, a shared TypeScript dependency, public TypeBox aliases, JavaScript, CommonJS, mixed import/factory failures, event subscription cleanup, and cached runtime freshness.

The new prompt regression runs a real faux-provider request through the suite harness. It asserts exact tool declaration order and exact system-prompt bytes, not just extension counts. No paid provider or live cache-hit claim is involved. The embedded path is exercised by a built Linux standalone CLI under pinned Bun 1.3.14.

The installed jiti package and registry latest were both 2.7.0 when checked. Its [release notes](https://github.com/unjs/jiti/releases/tag/v2.7.0) cover the virtual-module, static-loader, and TypeScript-path APIs used here. No dependency, lock, optional peer, package export, or support floor changes. The shipped artifact's debug banner says 2.6.1 despite its 2.7.0 package manifest; both sides use identical artifact hashes.

No official-package migration is part of this core fork change. A fresh installed macOS, Windows, Android, or private-corpus latency qualification was NOT RUN. Node 22.19.0 floor tests and Linux standalone checks are functional qualification, not cross-platform performance evidence.

## Reproduction

Start with separate worktrees, independent frozen dependencies, and identical hydrated public model data. Build both with `npm run build:offline`. Do not link their dependency trees or select an installed runtime.

```sh
python3 docs/performance/issue-250/measure.py \
  --before /path/to/before --after /path/to/after \
  --out /path/to/new-results --repeat 5

python3 docs/performance/issue-250/measure.py \
  --before /path/to/before --after /path/to/after \
  --out /path/to/new-baseline-profiles --repeat 1 --side before --profile

python3 docs/performance/issue-250/measure.py \
  --before /path/to/before --after /path/to/after \
  --out /path/to/new-candidate-profiles --repeat 1 --side after --profile
```

Use a new output directory. The driver refuses to overwrite a retained import transcript. It invokes the repository's [real loader/RPC fixture](../../../scripts/performance/fixtures/extension-imports.mjs) with the existing network-denying preload. The archive includes a reconstructed measured fixture: the current file with its sole later cleanup (`let responses` to `const responses`) undone. The original generated extension sources, import receipts, and RPC responses were retained directly.

## Verification record

See [verification](verification.md) for commands, exits, skips, failed attempts, cleanup, and the model admission receipt. Raw synthetic JSONL and failed-attempt logs remain in the archive and the task workspace. No owner journal, request log, account cache, selector, installed package, or live session was accessed or changed.
