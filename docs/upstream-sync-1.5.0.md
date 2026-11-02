# Upstream integration, v1.5.0

## Goal and references

Bring Mitch's fork to upstream main at v1.5.0 without losing the capabilities in
[FORK.md](../FORK.md). For each fork path that upstream now covers, compare the two
implementations: adopt upstream's when it is at least as good and delete the fork path; keep the
fork's when it is materially better, and record why. Fork-only capabilities stay, adapted to
v1.5.0's internals.

- Fork baseline is `0a0e06fb18ba206866d4051870c8f5cb420c9be9`.
- Upstream target is `3e0eec29f50e7861e9db91f2d12723267411b4f3`, 18 commits after official v1.5.0
  (`f9a26365568127461c47a07a37dcb42c140a3ac5`).
- The previous upstream baseline is `e7a0df27c09d11bf4161d3605246cbf57a129cb2`.
- The incoming range contains 115 commits. This is a merge, not a squash.

## Integration decisions

| Boundary | Decision and reason |
| --- | --- |
| Tool argument validation | Adopt upstream's pi-schema validation, which replaces the fork's TypeBox validator. pi-schema dropped optional nulls only through properties and items, so `{ value: null }` in an `anyOf` object branch became `{ value: "null" }`. Port the fork's union handling into pi-schema's first coercion pass: when a union rejects the value, drop the nulls for the first branch that then accepts it. The fork's two `validation.test.ts` cases failed on upstream and pass now; a new `coerce.test.ts` case fails on upstream's `coerce.ts`. |
| Chord validation | Adopt upstream's pi-schema frame validator and delete the fork's compiled TypeBox validator. On the Fold8 (Node 24.22.2), 400,000 checks of mixed valid and invalid frames took 15 ms with upstream's validator and 50 ms with the fork's; both made the same decisions. Keep the fork's malformed-frame and extra-field regressions. The retained `bridge-frame` performance fixture predates protocol 4 frames and fails on both trees; the ad-hoc comparison used current frames. |
| Assistant rendering | Adopt upstream's Markdown slot reuse and block cache, replacing the fork's content runs. Upstream re-ran every Markdown transformer for every block on each streamed update. Keep the fork's guarantee: a block whose text and stream state are unchanged keeps its rendered lines. With 1,500 streamed updates after a 30 KB thinking block, updates took 2.0-2.7 ms with upstream's code and 0.73-0.78 ms with the retained skip. The fork's `assistant-message.test.ts` case covers it. |
| Durable commits | Adopt upstream's group commit and batched `Storage.commit`. Upstream's writer fails the Session on any refused batch, so keep the fork's admission check before a commit joins the group. Upstream's Session storage cache did not forward `checkAdmission`, which silently skipped admission; the cache now forwards it. `harness-storage-failure.test.ts` failed without the forwarding. Keep SQLite's claim of new record IDs only, on top of the batched commit. |
| Durable scheduling | Adopt upstream's idle scopes and wake handling. Restore `harness-context.test.ts` to upstream's version: one fork case depended on the fork's storage-read order, the other differed only in row counts from upstream's tail cache. |
| Env watch overflow | Adopt upstream's frame-limit check for the same issue (#10516). Keep the fork's `remote.test.ts` regression. |
| Examples | Upstream removed the sandbox example; remove it with the fork's macOS adaptation and its guard tests. |
| Path comparison | Adopt upstream's `pathsEqual` helpers in the fork-only working-session directory check. |
| Fork-only paths | Keep the fork's `--working-session`, `/compact-view`, `pi update --fork`, background `codemode`, keybinding-hint additions, path hyperlinks, read JSON selection and the other features listed in FORK.md, adapted to upstream's new hints, trust and self-update code. |
| Dependencies | Keep the fork's reviewed SDK pins and TypeBox 1.3.37. Built-in tools keep TypeBox schemas, as upstream's do. Regenerate the root lock and the coding-agent install lock. |

## Local verification record

On the Fold8 (Termux, Node 24.22.2): `npm run build:offline` and `npm run check` passed. Focused
suites passed for every overlapping package: the full Chord (2,897 tests) and pi-schema (8,708)
suites, Durable storage, harness, group-commit and compaction tests, the TUI Markdown and wrapping
tests, the coding-agent rendering, branch-summary, package-manager and path tests, and pi-ai
validation. The `tui-stream` performance case measured the same before and after the merge.
