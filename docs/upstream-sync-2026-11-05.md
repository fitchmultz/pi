# Upstream integration: 2026-11-05

## Baseline

The fork integrates upstream `d9af3d73afb3b2c02c7a833d7ca9f3875e5fff6e` from
`earendil-works/pi` main into fork main `f5e3dbe5f93db38f40da65fa2378d28b778835bf`,
which was 56 commits behind and 895 ahead. The merge base is the previous integration's
upstream commit, `4d72d05bcd1ea9d26f36f6567be10d00ae6bb5f7`.
The merge preserves both histories, without rebasing or force-pushing.

## Conflict decisions

The merge had 11 conflicted paths. The coding-agent, Durable and schema changelogs combine
both branches' unreleased entries, fork entries first in each subsection; released sections
remain unchanged. The other decisions are below.

| Area | Resolution and reason |
| --- | --- |
| Workflows | Keep the fork's `ci.yml` and the deleted `preview-packages.yml`: upstream's changes add release-tag package publishing. Upstream's new `p2-cloud-bundle.yml` uploads p2's web UI to upstream's R2 bucket with upstream credentials, so it is not added. |
| Runtime exit | Keep the working-session gate, strict finalization and shutdown disposition. Add upstream's wait for credential writes after the session is disposed ([#11692](https://github.com/earendil-works/pi/issues/11692)). Ordinary quit still does not wait for tools that ignore cancellation. |
| Imports | Compaction keeps the fork's `NestedToolCalls` import and the MCP builtin its `WorkingSessionSaveEvent` import; both add upstream's `sliceHead`. Interactive mode keeps `ManagedRestart` and adds upstream's `addMcpServerConfig`. |
| Read | Plain-text reads use upstream's streaming. JSON selections still parse the whole file, page the formatted selection with selection-specific notices, and refuse images. |
| Cache notices | Back-to-back cache warms collapse into one line with the cumulative cost, as upstream does. The notice is added as chat activity, so compact and hybrid views group it. |
| Durable SQLite | Use upstream's batched statements (`CommitState`, `PendingWrites`). `checkAdmission` runs the same checks and writes in a transaction that always rolls back, refusing only `SQLITE_TOOBIG`. `PendingWrites` skips record-ID claims that storage already holds; see [Performance](#performance). |

Four files outside the conflicts changed:

- `packages/coding-agent/test/auth-login.test.ts`, new upstream: the Ctrl+C stub now intercepts
  only network catalog refreshes. The fork synchronizes a saved login through a local refresh
  (`allowNetwork: false`), which the stub otherwise aborted.
- `packages/coding-agent/docs/extensions.md`: the `createReadStream` note says JSON selections
  read the whole file.
- `scripts/performance/fixtures/durable-storage.ts`: uses the batched `Storage.commit` call and
  asserts that every write is stored. Since upstream's group commit changed the call, fork main
  refused each of the fixture's task writes and failed its final check.
- `packages/durable/test/sqlite-commit.test.ts`: a task update must write no `record_ids` row,
  and a new ID in the same call must still be claimed. The case fails on upstream's `commit.ts`
  and passes with the filter.

## Performance

SQL counts come from `scripts/performance/run.mjs --groups sqlite-1,sqlite-1024`, 30 writes each.
The fork main column runs the same fixture against fork main's sources.

| Workload | Fork main | Merge |
| --- | --- | --- |
| Document deltas: SQL calls | 150 | 150 |
| Document deltas: string-binding bytes | 771 | 1,543 |
| No-op writes: SQL calls and WAL bytes | 0 | 0 |
| Task checkpoint replacements: SQL calls | 120 | 120 |

WAL growth is identical at 1 KiB and 1 MiB payloads. Without the claim filter, the task
replacements took 150 calls: one `record_ids` insert per update of an existing task. Upstream
binds ID lists and rows as JSON arrays, which adds the binding bytes; the statements are the same.

The tools fixture timed reads on both trees: 32 MiB of text and 8 MiB of JSON, two alternating
passes of seven runs on a shared workstation. The medians are indicative, not a qualified
benchmark. Outputs were byte-identical.

| Read | Fork main (ms) | Merge (ms) |
| --- | --- | --- |
| File head | 16.8-17.0 | 16.7-17.5 |
| Middle page | 15.2-16.3 | 16.0 |
| 10 lines from the start | 9.0-9.3 | 12.6 |
| JSON selection | 5.9-6.1 | 6.0-6.1 |

Fork main buffered the whole 32 MiB file on every text read; the merge's heap and buffer growth
stayed under 13 MiB.

## Verification

- `npm ci --ignore-scripts`, `npm run build` and `npm run check`: passed. The installer lock
  needed no regeneration.
- Focused coding-agent suites for read, truncation, cache warming, credentials, auth, MCP, Radius,
  Bash spill, compact view, restart, working sessions, the model runtime and runtime exit:
  42 files, 731 tests passed.
- Durable: 15 files, 429 tests passed; with `PI_DURABLE_DOCUMENT_RETENTION_MS=0`, 8 files,
  285 tests; the Workers suite, 4 files, 51 tests.
- Schema: 8,746 passed, 9 expected failures, 2 skipped. AI validation: 181 tests passed.
- Not yet run for this integration: the full `./test.sh`, p2's checks and suite, CI and the
  active-consumer inspection.

The local evidence directory is `/tmp/pi-upstream-sync-2026-11-05/`. It contains the logs and
performance output. These offline checks do not claim live-provider or all-device qualification.
