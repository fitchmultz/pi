# Verification record

All commands ran in task-owned cloud Linux source roots with synthetic data. The candidate branch is `perf/issue-251-pi`, based on `c17adbc400319887c5ab34fce1ed2a59be746da4`. Product-source and built-file hashes are in [runtime-artifacts.json](runtime-artifacts.json). Performance samples identify the exact measured source independently of its pre-commit HEAD value.

## Completed local gates

| Gate | Command or control | Result |
| --- | --- | --- |
| Frozen dependencies | `npm ci --ignore-scripts` in both measured roots | Exit 0; same lock hash |
| Full offline build | `npm run build:offline` | Exit 0 |
| Final affected-package build | `npm --prefix packages/coding-agent run build` | Exit 0; bundled CLI and public SDK produced |
| Repository checks | `npm run check` | Exit 0; final run checked 1,608 files with no fixes |
| Affected behavior | `tini -s -- ./test.sh -- node node_modules/vitest/dist/cli.js --run --root packages/coding-agent test/session-manager/list-cache.test.ts test/session-info-modified-timestamp.test.ts test/suite/regressions/7497-session-discovery-symlink.test.ts test/session-selector-search.test.ts` | Exit 0; 32 tests in four files |
| Package consumers | `tini -s -- ./test.sh -- npm run check:package-install` | Exit 0; 10 isolated consumers, no publication |
| Paired performance | `node scripts/performance/run.mjs --before /workspace/pi-251-before --after /workspace/pi-251 --groups session-listing --repeat 5 --out /workspace/reference/qualified-context-listing` | Exit 0; all 20 fresh processes passed; all semantic hashes match |
| Built public SDK | `node /workspace/reference/sdk-final-proof.mjs` | Exit 0; exact cold/warm metadata equality, two cold journal streams, zero warm streams |
| Actual bundled CLI | `python3 /workspace/reference/drive-cli-proof.py` | Exit 0; real PTY full-text query resumed `public-cli-two`; no model prompt, outbound network disabled by the existing offline hook |
| Date-context regression | Real SDK child processes with `TZ=UTC` and `TZ=America/Los_Angeles` | Pre-fix error reproduced; final cached and authoritative local dates agree |
| Warm built-SDK profile | `env -i PATH="$PATH" HOME=/workspace/reference/profile-baseline/home PI_CODING_AGENT_DIR=/workspace/reference/profile-baseline/agent PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 node /workspace/reference/profile-warm.mjs` | Exit 0; 100 listings, 6,400 sessions, 3,276,800 messages, zero journal streams |

Repository checks cover Biome, pinned/runtime dependencies, relative TypeScript imports, entry graph budgets, generated install-lock freshness, TypeScript, and the browser smoke control. No checker cap, assertion, timeout, package peer, or requirement was relaxed.

## Complete offline suite

**Exit 0 on the final product source.** The complete offline suite finished successfully in the owned verification clone. The coding-agent workspace reports 3,432 passed and 51 existing skips. Other provider, environment, and platform skips remain visible in [the complete structured summaries](test-summary.json), including 867 provider tests skipped without API keys and eight environment tests skipped by their existing availability conditions. Pi TUI uses Node's dot reporter; its success is covered by the full command exit, not an invented test count.

All **873 source/dependency identity files** in the measured candidate match the verification clone byte-for-byte. The combined source SHA256 is `de41a10e1eb5b43e2b0c1e34cbdd6e9accd2050ae610966cb30b2be76e0e5c59`. This comparison was repeated after the full suite, with zero mismatches.

The full-suite verification clone is `/workspace/pi-251-verify`. It has a fresh frozen dependency installation, the same public model data, identical product-source bytes, and the task-built native `pi-env` binary at the test harness's expected path. The clone and its Git metadata are owned by UID/GID 65534, so permission tests run as a normal unprivileged user. A task-local subreaper supplies the child-reaping behavior absent from this container's `sleep` PID 1.

```sh
tini -s -- setpriv --reuid=65534 --regid=65534 --clear-groups \
  env HOME=/workspace/reference/unprivileged \
  npm_config_cache=/workspace/reference/unprivileged/npm-cache \
  PATH=/workspace/reference/go/bin:/workspace/reference/test-bin:$PATH \
  bash -c 'cd /workspace/pi-251-verify && npm --prefix packages/coding-agent run build && ./test.sh'
```

This does not change global user, Git, account, provider, model, or runtime defaults. The normal wrapper removes API keys and isolates HOME, TMPDIR, agent resources, compile caches, and native selector targets. Installer tests exercise synthetic targets, not an installed Pi runtime.

## Failed attempts and environment corrections

The task workspace retains the original logs, profiles, journals, terminal captures, receipts, and harness execution journals. Failed attempts were classified before correction. They are not counted as passing gates.

- The first benchmark smoke used the wrong project-directory encoding and returned zero current-project sessions. The fixture was corrected to use `getDefaultSessionDir()`, with no production assertion removed.
- The first baseline regression run failed five tests. Additional privacy tests reproduced two real retention failures. A real cross-process date test reproduced one additional cache error. [Red/green evidence](red-green.json) retains their stdout and the final focused results.
- The first full suite stopped at an existing installer test because `go` was unavailable. A verified task-local Go 1.27.3 distribution supplied that prerequisite.
- A root full-suite attempt exposed two process-tree tests that saw dead children as live because this container's PID 1 never reaps zombies. The agent stopped that already-failing attempt, exit 143. The unchanged nine-test Chord manager file passed under `tini -s`.
- A root/subreaper attempt exposed three existing permission assertions because root bypasses read/write mode restrictions. The agent stopped that already-failing attempt, exit 143. Dropping DAC capabilities alone did not correct this container behavior. All three unchanged permission tests passed under an unprivileged UID.
- Running unprivileged against root-owned source exposed Git ownership checks and an unreadable task-generated `.eval` directory. A separate fully owned clone corrected the environment without changing global Git settings or source permissions.
- The first owned-clone full run exited 1 because `test.sh` removes `PI_ENV_DAEMON`, leaving six environment suites without their native prerequisite at the default path. The same task-built binary was placed at that expected path. All six executable environment suites then passed: 94 tests, eight existing skips. The binary SHA256 is `557073bd6ad4a2c45242b406e7cbfb065c251874113cf5ee121becbfa47f7dda`.

No full-suite result from before the final date-context change is presented as final-source proof.

## Review and platform limits

Three genuine read-only source delegates checked semantics and cache retention. Follow-up reviews confirmed both retention fixes and the date-context fix without remaining actionable findings in those scopes. Delegates did not edit code or claim they executed tests. Current-head GitHub CI, Pi Durable, Cursor, other enabled checks, and review threads are separate gates, recorded on the PR rather than fabricated in this pre-commit artifact.

Linux x64 source, built SDK, bundled CLI, and native test-daemon checks ran. Owner-installed macOS runtimes, private corpora, paid-provider tests, and live activation were not run. Platform- and environment-skipped tests remain skips. No dependency/support-floor or extension import contract changed; the unrelated pi250 work is untouched.
