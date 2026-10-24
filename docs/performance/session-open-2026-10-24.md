# Session opening measurements, 2026-10-24

Opening a session now scans each decoded chunk once and joins fragments only at a complete record or EOF. Native `JSON.parse`, UTF-8 decoding, full history, branches, metadata, migration and newline-repair rules are unchanged. Listing and extension loading are outside this change.

The baseline was `c17adbc400319887c5ab34fce1ed2a59be746da4`. Measurements used Linux x64, two CPUs, Node 24.22.1, npm 11.19.1, independent locked dependency installations and identical frozen model data. Each case used five alternating fresh-process A/B pairs with warm filesystem pages. Profiles ran separately. No private journal was accessed.

Both synthetic v3 journals contain 321,650,722 bytes. The giant has 2,078 entries and a 230,300,766-byte tool-result line. The control has 43,844 entries and a 21,375-byte maximum line. The measured large text is ASCII. A separate reported-scale Unicode/escaping fixture passed complete-record equivalence through the public SDK under Node 24.22.1 and the Node 22.19.0 support floor. The Node 22 bundled CLI opened it with the expected state and byte-identical journal.

## Results

Values are medians with minimum to maximum ranges. MB means decimal megabytes.

| Boundary and metric | Before | After |
| --- | ---: | ---: |
| Giant, manager open, ms | 19,260 (19,144 to 19,963) | 833 (780 to 842) |
| Giant, manager load high-water RSS, MB | 1,467 (1,452 to 1,694) | 784 (783 to 785) |
| Giant, retained manager heap after GC, MB | 333.27 (333.27 to 333.28) | 334.32 (334.32 to 334.32) |
| Giant, bundled CLI RPC readiness, ms | 19,647 (19,309 to 19,978) | 1,348 (1,303 to 1,372) |
| Giant, CLI process-lifetime peak RSS, MB | 1,500 (1,491 to 1,505) | 828 (822 to 1,029) |
| Control, manager open, ms | 1,136 (1,101 to 1,184) | 934 (907 to 1,053) |
| Control, CLI RPC readiness, ms | 1,972 (1,879 to 2,366) | 1,730 (1,647 to 1,967) |
| No-session CLI RPC readiness, ms | 605 (592 to 616) | 595 (577 to 617) |

The giant-record improvement is clear in every pair. The CLI control ranges overlap, and the no-session control shows no clear change. The manager retains the complete history rather than reducing model context or dropping fields. Control post-GC heap stayed at 340.48 MB, but its post-GC RSS increased from 492.70 to 521.86 MB. Not every memory metric improves.

Manager latency covers `SessionManager.open()` only. Its high-water RSS includes imports but stops before validation. Retained state is measured after forced GC with the manager still live. CLI measurements use the real built Node launcher/worker bundle, not the Bun standalone executable. Latency includes process creation through a successful native `get_state`; GNU time reports the lifetime high-water RSS through shutdown, not summed launcher/worker RSS. All CLI runs used `-ne --offline` in a network namespace with no external route, a synthetic HOME and no provider requests. All 50 processes passed, manager witnesses matched and CLI journals remained byte-identical.

## Cause and limits

The baseline repeatedly flattened and searched a growing pending line. Independent manager and actual CLI worker profiles identified that loop and GC as the dominant cost. After the fix, native JSON parsing and UTF-8 decoding dominate. The existing synchronous API and native parser remain sufficient; no cache, new parser, record limit or storage format was added.

These are synthetic Linux findings, not measurements of the original private macOS corpus or an installed runtime. Complete records still must fit V8's string limit. Unicode-heavy giant strings can require wider retained representations; the ASCII result is not a general memory bound. Windows and Termux-device qualification are not established here.

[Raw commands, all samples, profiles, exact identities, attempts and synthetic journals](issue-254-raw/README.md) are retained separately from this dated summary.
