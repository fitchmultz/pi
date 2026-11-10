# Upstream integration: 2026-11-10

## Baseline

This integration merges upstream main `4ea8837927564c592b1d184c956ab7d28c88119b` into fork
`a98f64f5f98faa42cc064812eef18bbbed767772`, preserving both histories. The preceding upstream
baseline is `bd0d815c3197e75323f6db60ee3ad1f73d5280d7`. There are 25 incoming non-merge commits.

Official v1.5.1 (`dd30101cfc5b0609411dd80b6f93adbc14db14cf`) is in this range. Upstream main is
two commits after it: the new `[Unreleased]` sections and the missing-directory prompt.

## Incoming changes

- **Release v1.5.1**: package versions and changelog sections.
- **Coding agent**: a session whose working directory no longer exists now offers `Continue`,
  `Fork`, or `Cancel`. `GrepOperations.readFile` is accepted again as an optional, deprecated
  field that grep never calls. The find tool starts no `fd` process after cancellation and
  matches Windows path patterns with every `fd` version. The PowerShell tool reports native exit
  codes under Windows PowerShell 5.1. A provider signed out during a model refresh warns
  instead of failing the refresh.
- **AI**: Claude Fable 5.2 on the `anthropic` provider.
- **Chord**: WebSocket errors keep their close code. The terminal sandbox resolves paths before
  it grants file access. Tests settle macOS file events and use the canonical temporary
  directory.
- **p2**: the Familiar session, session management in the conversations tool, and a brain name
  reported to Radius.
- **p3**: design documents only.

## Conflict decisions

Thirteen paths conflicted.

| Paths | Resolution |
| --- | --- |
| `package-lock.json`, `packages/{ai,coding-agent}/package.json`, `packages/coding-agent/install-lock/package-lock.json` | Internal packages move to 1.5.1. The fork's external dependency pins stay. The installer lock is regenerated and passes its check. |
| `packages/{agent,chord,coding-agent,durable,tui}/CHANGELOG.md` | Each `[1.5.1]` section matches the v1.5.1 tag byte for byte. Fork entries stay under `[Unreleased]`, with upstream's two post-release coding-agent entries. |
| `packages/chord/src/node/http/upgrades.ts` | Adopt upstream, which now delivers code 1009 for oversized frames. The fork's copy of that fix and its changelog entry are retired. |
| `packages/coding-agent/src/core/agent-session-runtime.ts` and its test | Keep the fork's working-session admission gate. Adopt upstream's removal of a failed import's session copy. Both test groups stay. |
| `packages/coding-agent/src/package-manager-cli.ts` | Keep both sides' imports. |

Three decisions outside the conflicts:

- **p2 socket limits stay.** Upstream's p2 still terminates a client socket on a protocol error,
  which can discard the close frame. The fork's `apps/p2/src/hosts/socket-limits.ts` keeps
  delivering code 1009.
- **Fable 5.2 keeps two fork differences.** The Cloudflare AI Gateway entry stays, next to
  upstream's new `anthropic` entry. Fable 5.2 and Mythos 5.2 requests omit `temperature`, as
  Anthropic's [migration guide](https://platform.claude.com/docs/en/models/fable-5-2/migration-guide)
  says; upstream's entry still sends it.
- **Changelog cleanup.** A duplicate entry for the symlinked `auth.json` lock is removed.

## Test runner

`./test.sh` now puts its isolated root under `/tmp` when `TMPDIR` is macOS's per-user default.
A `TMPDIR` the caller chose is kept. `scripts/test-runner.test.mjs` covers both cases; the new
case fails on the previous script.

The per-user default is 49 bytes long. Upstream's Chord tests now use its canonical form, which
adds `/private`. Under the isolated root, Chord's socket-file fixtures then need 108 bytes, and
macOS allows 103. Four lock tests failed with `EINVAL`.

Measured on macOS with the full Chord suite:

| Tree | Temporary root | Result |
| --- | --- | --- |
| Fork main before this merge | Per-user default | 3 of 3 runs failed, with 21 to 24 failing tests |
| This merge | Per-user default | 4 lock tests failed. The tutorial's reload step also timed out in 4 of 6 runs |
| This merge | `/tmp` | 6 of 6 runs passed |

The tutorial stopped after its step 8, waiting for the edited plugin's reload. The cause of that
stall under the per-user directory is not established; the measurement is the evidence.
Upstream's test files are unchanged.

## Fixes found during review

- **Radius status line.** Upstream's `radiusStatusText` printed `connected as brain Studio`, and
  upstream's own test expects `connected as brain "Studio" (brain-1)`. The fork now prints the
  quoted name with the server ID. The name is a label that two brains can share; the ID is not.
- **Output-drain fixtures.** The daemon keeps reading after a shell exits until its descendants
  are silent for 100 ms. Two fork tests wrote ten ticks with a `sleep 0.02` process per tick.
  On the emulated Intel Mac job the gaps exceeded 100 ms, and the test failed twice with five
  ticks. One Node process now writes the ticks 20 ms apart and signals the shell through a
  pipe before it exits. The assertions are unchanged. With the daemon's re-arm removed, the
  new fixture still fails, with four ticks.

## Verification

All runs used macOS and Node 24.22.2 unless stated. Providers were offline or faux.

- Clean dependency installation, catalog hydration, the workspace build, and the root and p2
  lint and type checks passed.
- The full `./test.sh` passed with the default environment: 123 script tests with one skip, and
  23,370 tests across every package suite with no failures. Env's suite ran against a locally
  built debug daemon.
- The first full run failed before the test-runner change. It showed the four lock tests, one
  tutorial timeout, and seven Env suites that needed the daemon build.
- p2 on Node 26.13.0 with real Chrome: 66 of 67 tests passed across the Familiar, its drawer
  entry, conversations, Radius, session operations and start, socket limits, server start, the
  drawer, and cache warming. The one failure was upstream's status-line mismatch, fixed below;
  the Radius file then passed all its tests.

These checks do not qualify live Radius, Discord, remote sandboxes, Windows, or a physical
Termux device.

## User interface

p2's drawer gains the Familiar entry above the folders. The screenshots under
`docs/assets/upstream-sync-2026-11-10/` show the same fixture before and after, at desktop and
phone sizes.

The terminal prompt for a missing session directory changes from two choices to three:

```text
Before
 cwd from session file does not exist
 /tmp/demo/renamed-away

 continue in current cwd
 /private/tmp/demo/project

 → Continue
   Cancel

After
 Session cwd does not exist: /tmp/demo/renamed-away

 → Continue in /private/tmp/demo/project (asks again next time)
   Fork into /private/tmp/demo/project (new session ID, original kept)
   Cancel
```
