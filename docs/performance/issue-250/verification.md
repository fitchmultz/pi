# Issue 250 verification

## Model admission

The active chat configuration was verified by the coordinator through a supported owner-authenticated, read-only chat API GET at `2026-10-24T13:23:15.983749+00:00`.

```json
{"provider":"openai","modelId":"gpt-6.1-sol","thinkingLevel":"xhigh","contextWindow":300000,"fastMode":null}
```

The response also reported `connectionReady=true` and `rootRunBusy=true`. Its configurationVersion SHA256 was `c52404be6ba45b2e0427d98acc645cf5eeba33d251e1acd2e798807cd4d3d5ea`. The coordinator retains `actual-model-evidence.json`. This is coordinator-supplied canonical AgentDoc configuration evidence, not a guessed model self-description or an independent guest API read. No account, provider, connection, default, or chat configuration was changed.

## Scope and process

The task used cloud-only worktrees and branch `perf/issue-250-pi` from freshly fetched `origin/main` at `c17adbc400319887c5ab34fce1ed2a59be746da4`. It did not use a shared host checkout. The original main tree was `42e293e2279941d758780d8530ce1c112a82496e`.

Pstack was read at `94f83d6fb0581e0602e467f7fafdfd9f87c4b402`, starting with the Pi adapter, then poteto-mode, poteto-agent, benchmark-checklist, Perf issue, Opening a PR, and Babysit. The adapter's scope rule skips automatic how, architect, arena, swarm, interrogate, and no-comments panels. No unresolved whole-design choice required those workflows. This is one isolated code owner, not a second program coordinator. Actual independent GitHub review is a separate gate.

Model the Domain shaped the ordered array of settled module results. Laziness Protocol removed the one-caller combined import/factory wrapper rather than adding a scheduler. Test Behavior Not Implementation shaped the real jiti, faux-provider prompt, and standalone CLI tests. Explain the Number kept profiled runs separate and rejected a CPU-control speedup claim. Sequence Work into Verifiable Units separated reproduction, loader change, boundary proof, comparative measurement, and delivery.

Standalone adapter cleanup inspected changed hunks and surrounding contracts before commit. It kept cache-generation validation, error text, factory discard/commit behavior, required issue comments, and the one comment explaining sequential factories. It removed the obsolete one-caller wrapper and corrected a mutable binding in the measurement fixture. Cleanup is not represented as independent review.

## Executed checks

Raw logs and comparative command/environment records are retained with the evidence artifact.

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` in both isolated roots | Exit 0. Existing engine/deprecation/audit notices retained. No dependency or lock edits. |
| `npm run hydrate:model-data` | Exit 0. Public generated data copied unchanged to the baseline and used by both builds. |
| `npm run build:offline` in both roots | Exit 0. |
| New regression against baseline loader | Exit 1, expected. Actual maximum active imports was 1 instead of 3. |
| Targeted loader, cache, discovery, runner, lazy-jiti, and SEA-option tests | Exit 0. Six files, 98 tests. |
| `npm --prefix packages/coding-agent run build` | Exit 0. Final rebuild retained identical measured JavaScript and bundle entry hashes. |
| `npm run check`, then the enabled pre-commit hook on the final code | Exit 0. Formatting, lint, pinned/runtime deps, TS imports, entry budgets, install lock, compiler, and browser smoke all passed. |
| Final unchanged `./test.sh` under the qualified subreaper/capability wrapper | Exit 0. Coding-agent: 3,416 passed, 52 policy skips. Both Durable retention modes, worker runtime, Env conformance, and every other workspace completed successfully. |
| Corrected strict regression, including full request capture and successful assistant response | Exit 0. All three cases passed. |
| Five alternating comparative samples per side for all six cases | Exit 0. All 60 measured runs and 12 warmups passed. |
| Separate baseline and candidate profiles | Exit 0. Not used as comparative latency samples. |
| Bun 1.3.14 Linux standalone build | Exit 0. Official binary download hash verified. |
| `PI_TEST_COMPILED_CLI=... ./test.sh -- node node_modules/vitest/dist/cli.js --run --root packages/coding-agent test/compiled-extension-packages.test.ts` | Exit 0. Both real compiled CLI tests passed. |
| Retained standalone RPC smoke | Exit 0. Six imports, six ordered factories, and two successful responses. Actual synthetic JSONL retained. |
| Initial loader, discovery, and cache tests under Node 22.19.0 | Exit 0. Three files, 38 tests. Official Node archive hash verified. |
| Final strict prompt regression and discovery tests under Node 22.19.0 | Exit 0. Two files, 34 tests. |
| `node scripts/check-package-install.mjs` | Exit 0. Ten isolated public-package consumers, including actual SDK imports and CLI smoke checks, from one coherent local artifact set. No package published. |
| Locked Env daemon build with task-local Rust 1.88.0 | Exit 0. Prerequisite for the full offline suite. |
| JSON-to-SQLite measurement comparison | Exit 0. SQL counts, medians, and ranges equal the original JSON analysis. It includes all 99 retained attempts across the invalid, valid diagnostic, and matched sets. |

## Failed attempts and environment repairs

- The initial RPC benchmark fixture registered the same flag from every extension. Actual CLI validation rejected five conflicts. Those timings were rejected. The fixture now uses distinct flags. The complete failed attempt and import transcripts remain in `baseline-profile/` in the archive.
- The initial candidate prompt test omitted the required bindings object from `bindExtensions`. That fixture error was corrected to `{}`. The failed and passing logs remain separate.
- Debian Rust 1.85.1 could not build pinned dependencies that require Rust 1.88. The task installed a separate Rust 1.88.0 toolchain without changing dependency versions or locks. The first failed build and successful locked build are retained.
- The first full offline attempt could not spawn Go for an existing compiler fixture. Go was installed as a cloud test prerequisite. No product check was relaxed.
- The next full attempt exposed existing process-tree checks under this container's `sleep infinity` PID 1. Orphaned descendants remained zombies and still satisfied `kill(pid, 0)`. Root's DAC capabilities also bypassed permission-denied fixtures. The same Chord manager tests failed on untouched baseline source without a reaper and passed all nine tests under `tini -s`. Untouched baseline tools, config, background-command, and sandbox-guard tests then passed all 124 tests with a subreaper and capabilities dropped. No account or global configuration was changed.
- The first capability-drop probe cleared only the bounding set, which left inherited/ambient capabilities effective. The qualified wrapper clears all three sets. It runs the unchanged test command as `setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs tini -s -- ./test.sh`. It does not alter a checker, assertion, timeout, budget, or support requirement.
- Cleanup found that assertions inside the faux-provider callback could be converted into provider errors. The regression now captures the actual request and asserts outside the callback, also requiring a successful `ready` response. This exposed the fixture's omission of the four default tools. The expectation now includes the exact complete built-in-plus-extension tool order. The first qualified full run was stopped after that known fixture failure; its log is retained. The corrected strict regression passed directly and under Node 22.19.0 before the final full rerun.
- A foreground commit attempt hit its caller's 120-second tool deadline while the hook was still checking. Inspection confirmed no commit was created. The retained log is not counted as a successful hook. The retry uses an untimed managed command; hooks remain enabled.

## Limits and retained evidence

This is the pre-delivery code-ready snapshot. Subsequent exact-head CI and independent review results belong to the PR itself; this artifact does not assert that review has completed.

No installed macOS runtime, private extension corpus, Windows device, Android device, paid provider, deployment, activation, live restart, or package publication was tested or changed. Offline provider/e2e tests skipped by repository policy are NOT RUN, not passes. No generated contract or schema changed, so regeneration of unchanged schemas and reference docs is not applicable.

The archive retains raw comparative commands, environments, synthetic Pi RPC responses, import JSONL, profiles, source fixtures, dependency/build identities, and failed attempts. Task-owned evidence also remains under `/workspace/evidence/issue-250`. No private transcript was available or searched. The concise task trail is not a claim of completing a cross-model audit-trail workflow.

Native cloud GitHub is the supported delivery interface. No local gh-personal profile, credential rewrite, or GitHub MCP fallback is used. The assigned Babysit mode is drive. The PR must remain OPEN with auto-merge OFF. Merge, runtime installation, activation, publication, and deployment are not authorized.
