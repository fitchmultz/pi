# Pi v1.4.0 integration

## Scope and fixed references

This integration prepares one PR against `fitchmultz/pi:main`. It does not merge,
publish packages, install or activate a runtime, or restart existing sessions.
External consumers were inspected read-only. A temporary archive supplied the
consumer test fixture.

| Reference | Exact commit |
| --- | --- |
| Fork baseline after PRs [#229](https://github.com/fitchmultz/pi/pull/229) and [#230](https://github.com/fitchmultz/pi/pull/230) | `25267bb95ce3efb6f94a3e33d7383636680d4dc8` |
| Previously integrated upstream code | `cae9fd28a2d3d515c83ea495093e3768cc8efab6` |
| Official v1.4.0 target | `4a080252f06caf63a525d7873c5d94d3c23887e0` |
| Common ancestor before this merge | `396ecd7b8f3a146b8af98206d18df1bcc2c08f4e` |

The release delta is seven commits across 58 tracked paths. Four contain the
functional changes below. The others audit changelogs, update a catalog assertion,
and set release metadata. Upstream `main` also contained `58c0b02ce`, a next-cycle
changelog update. It is excluded.

The common ancestor predates code already integrated by the fork. The merge
therefore reapplies the exact `cae9fd28..v1.4.0` delta to the reviewed fork tree,
resolves the true conflicts, and records the official tag as a merge parent.
This preserves prior resolutions rather than repeating the older synchronization.

## Native changes and integration decisions

| Release change | Native implementation and retained behavior |
| --- | --- |
| `bd3c9b823`, extension-tool restoration | Replay all system messages on the raw branch, including those before compaction. Activate eligible never-mentioned extension tools. Keep native modifiers, exclusions, pending registration, and recorded removals. |
| `8c4e87389`, grep isolation | Use native `rg --no-config`. The regression also checks explicit literal, case-insensitive, and glob options against an ambient fixed-string config. |
| `02726086d`, truncated tool-call recovery | Use the unchanged native projected-context scan. Omit only the failed assistant and its matching results before the next assistant. Preserve entry identity, raw usage, and background-delivery ownership. |
| `7f225f25d`, classifier images | Use native TypeSafe assets, Clef data URLs, Jev assets, and OpenRouter state-image parts, with their native validation and opt-in headers. Preserve provider normalization, credentials, and chat-only hidden-model overrides. |

### Deferred tools are not newly installed tools

Instruction groups can defer a selected tool before its first declaration.
Upstream sees no system-message mention and otherwise activates that tool as new.
The adaptation counts every historical instruction-group deferral as mentioned.
When discovery is absent or inactive, the existing union of selected deferred
tools remains. Complete working-session restore keeps its saved current selection.

All other restoration follows native history. A tool disabled before any request
can be indistinguishable from a newly installed tool. Following the owner's
native-first decision, such unrecorded state is not reconstructed. Tests of persistent
deselection establish actual native declarations and removals. The instruction
check reads the current system prompt, not old guidance elsewhere in history.
No new selection journal protocol, session-header flag, legacy mode, startup write,
or tool-execution work is added.

Two alternatives were prototyped and withdrawn. A `pi:tool-selection` entry could
preserve future pre-declaration deselections. A header flag could disable native
activation for legacy journals. Both added fork policy beyond the required
discovery adaptation. Neither ships.

### Metadata, catalogs, and fixture compatibility

Workspace versions and internal exact pins move to 1.4.0. External dependency
versions and reviewed lifecycle allowlists are unchanged. The generated coding-agent
install lock and official Nix catalog pin stay aligned. All ten official
1.4.0 changelog sections match the release tag. Fork history from 1.3.0 down stays
byte-identical, including two entries upstream repeats in its release audit.

The new classifier `compat` type exposed one invalid fork test fixture: it spread
a chat model into a classifier. Explicit classifier fields repair the fixture
without changing its assertions or relaxing the public type.

Baseline and candidate catalogs were hydrated separately from free public model
metadata. The comparison found 1,714 baseline entries and 1,716 candidate entries,
with no removed IDs. Clef Omni and Jev 1.14 account for both additions. Classifier
image compatibility and four OpenRouter chat pricing or output-limit updates
account for the changed existing entries. Generated `models.generated.ts` is
unchanged. Hydrated provider data remains ignored.

| Catalog manifest | SHA-256 |
| --- | --- |
| Baseline | `8b6d93c1ced4bba5f0d638dcd5cf5d84f69d7fbaff37d47e038d0c2adb03560e` |
| Candidate | `d97e90faee1a90e953b969283a40fc07c64a2e4e5d468d2e254db6a231ef35c0` |

## Focused consolidation result

No additional fork-specific mechanism is retired. The nine incoming production
source paths cover restoration, recovery, classifier transport and types, grep,
and version metadata. They supply no equivalent for the remaining complete
capture and restart, durable shell jobs, deferred codemode receipts and usage,
credential isolation, cache preparation, atomic edits, UI factory lifecycle, or
immutable-install contracts.

The native branch replay replaces the former latest-system-message restoration.
The recovery change removes an upstream-owned result field, not a fork-specific
mechanism. Classifier images and grep isolation remain native rather than gaining
parallel implementations. This synchronization volume is not fork-code retirement,
and no maintenance or performance gain is claimed.

The owning implementations and retained tests remain in [FORK.md](../FORK.md).
The [previous consolidation record](upstream-consolidation-2026-10-21.md) explains
the unchanged owners and the withdrawn custom-dialog snapshot removal. This pass
does not reopen those decisions without new native equivalence.

## Verification

Baseline and candidate use macOS arm64, Node 24.22.0, npm 11.19.1, and Bun 1.3.14.
Dependencies use `npm ci --ignore-scripts`; reviewed root preparation and model
hydration run explicitly. No paid provider calls or credential changes occur.
For the full suite, `PATH` excludes GNU `gnubin`, and `BASH_ENV` is unset so Env
sees the native `sleep` process name. Baseline and candidate use separate worktrees.

| Check | Baseline | Candidate |
| --- | --- | --- |
| `npm run check` | Passed | Passed, no fixes or diagnostics |
| `npm run build:offline` | Passed | Passed |
| `npm run build:daemon --workspace packages/env` | Passed | Passed |
| Full isolated `./test.sh` | Passed | Passed; AI 1,676 and coding-agent 3,354 passing cases |
| Ten isolated public package consumers | Not required for comparison | Passed after the final build |
| Bundled detached-shell smoke and Node/Bun background-codemode smokes | Not required for comparison | Passed after the final build |
| Env `cargo fmt`, locked Clippy with warnings denied, and unit tests | Not required for comparison | Passed, 16 unit tests |
| Native standalone CLI and compiled extension-package tests | Not required for comparison | darwin-arm64 build, version/help, and compiled regression passed |

Baseline AI and coding-agent counts were 1,663 and 3,343 passing cases. The final
focused restoration, instruction-group, working-session, prompt-prefix, and recovery
run passes all 160 cases. The full suite also runs Durable with both retention
settings and completes the TUI suite. Skipped live-provider, external SSH, compiled
target, and platform cases are not counted as passes. The explicit standalone run
separately enables and passes the compiled extension-package regression.

Focused evidence uses the real SDK, journal, tools, and faux providers:

- The grep config regression fails against the baseline implementation and passes
  with `--no-config`. Explicit options remain effective.
- Direct native restoration fails instruction-group tests by treating deferrals
  as new registration. The historical-deferral guard preserves immediate cold
  resume and tree state, delayed registration, modifiers, exclusions, and prefixes.
- Three recovery cases cover a file-backed crash with edited results and reused
  call IDs, branch-local omissions, and background completion during compaction.
  The first two fail before 1.4.0. The third preserves the fork's existing receipt,
  commit, and usage ordering. Existing nested-call and compaction suites remain.
- Native classifier tests check serialization, limits, rejected inputs, headers,
  and model configuration. Capturing-fetch SDK probes exercise TypeSafe, Clef,
  Jev, and proxied OpenRouter without contacting their providers.
- The real `pi-subagents` model-selection fixture at
  `a85b45f5f4e26f210e7a3251aa080859a7a063b9` passes against both this candidate and
  an older installed host without `resolveModelReference`. Literal colon IDs,
  exact-first selection, suffix resolution, and the older-host rejection remain.
  The public resolver implementation and export are byte-identical to PR #230.

The PR records the final commit, exact-head hosted checks, and independent review.
A cancelled, unavailable, skipped, or pending check is not a pass.

## Limits

Live classifier acceptance, provider billing, and image interpretation are not
qualified by offline tests. Live-provider and platform-specific suite skips are
reported separately from passing cases. Hosted CI supplies Linux, macOS, Windows,
Env release-daemon, and Nix evidence where configured, not Termux-device acceptance.

The official pinned published catalog does not yet advertise TypeSafe and Workers
AI classifier images or the two new Workers AI models. Builds hydrated from that
pin reject those image requests locally. Fresh native generation includes them.
OpenRouter detects its image transport by provider ID. The pin is retained rather
than publishing a private substitute or claiming the missing metadata is present.
