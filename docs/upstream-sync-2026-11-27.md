# Upstream integration: 2026-11-27

## Baseline

This integration (PEA-240) merges the exact upstream `v1.7.0` tag
(`fb0fe823539f6d04850f6e34748c01f01f212e1f`) into Fitch Pi
`425f416f9582ab5792ba353b30c4128b35a24b12`, the commit with fork PR #593. It preserves both
parents. The preceding upstream baseline and merge base was
`e4cd354e6f3ce317a9dd4a8ab1dd4fb6500ebc98` (777 incoming commits, 655 non-merge, 1,396 paths).

## Incoming changes

- **AI:** `pi-image`, Radius decision and image models, OpenRouter image settings and pricing, and
  image and reasoning output accounting. Copilot keeps the cache across supported Claude/GPT-6
  changes and replays opaque reasoning. Bedrock maps more thinking levels and omits earlier Kimi
  reasoning. Ant Ling uses the DeepSeek thinking toggle, and Together and Qwen drop retired models.
- **Coding agent and TUI:** Terminal resume via OSC 7577 with `--agent-dir` and the original
  restriction and resource flags. Install reporting is removed. Invalid `models.json` is now a
  warning across modes. Follow-up submit accepts autocomplete, `!!` output no longer inflates
  context estimates, and regular-mode Kitty images append without clearing scrollback.
- **Chord, p2 and p3:** Chord slice 15 replaces variants with grantable members and bumps the wire
  protocol to 2. p2 adopts the new contracts, Radius guest invites, and project coordinators. p3
  takes the upstream app migration, including sessions, shared things, views, providers, and backups.
  Update hosts and clients together; p2 plugins that still declare variants need the
  [grantable member migration](../apps/p2/docs/p2-notes.md#plugins-written-before-grantable-members-migration).
- **Env and Durable:** Env tracks command registrations and cleans up descendants across process
  groups within a session. Durable aggregates the optional `imageOutput` split.

## Conflict decisions and silent overlaps

Git reported 46 conflicting paths. Another 102 paths changed on both sides and merged without
markers, including several settings files, Chord tests, and the p2 outbox regression tests.

| Paths | Resolution |
| --- | --- |
| `AGENTS.md` | Kept fork policy and updated the keybinding owners to `TUI_KEYBINDINGS` and `APP_KEYBINDINGS`. |
| `{apps/p2,apps/p3,packages/{ai,coding-agent,evals}}/package.json`, both lockfiles | Bumped workspace packages and pins to `1.7.0`, took p3's new dependencies, and retained reviewed external pins, Sixel, and coding-agent's Chord and Durable dependencies. Took the upstream `nix/model-catalog.json` exactly and regenerated both locks. |
| `apps/p2/test/p2/{cache-warming,prompt-templates,terminal-reconnect,tui-actions,tui-attach,tui-grants,tui-guest,tui-launcher,tui-mouse,tui-render,tui-settings,voice-ui}.test.ts` | Used `holdWith` and grant constants, keeping `TUI_NODE`, test harness helpers and fork regression cases. Also ported the old `holdIn` calls in the automatically merged `ui-outbox.test.ts` to keep both delivery regressions. Kept the p2 server startup/close, worker swap, terminal, voice, and Chord persisted job ownership changes; p2 bundle builds use Chord's counted `esbuildBuild`. |
| `packages/ai/{README.md,src/{types,models}.ts}`, coding-agent `docs/{codemode,models}.md`, `src/extensions/codemode/execute.ts`, `test/suite/agent-session-codemode.test.ts` | Took upstream image APIs, image output usage and pricing, and codemode validation, keeping native `google-images` routing, `store: false`, and existing Google price estimates. `size` is the common option and maps to Gemini's `imageSize`; the old spelling still works. Kept both `imageOutput` and `cacheWrite12h` accounting in coding-agent totals. |
| `packages/ai/src/{api/{classifier-shared,json-request},providers/{radius-config,radius}}.ts` | Shared the upstream JSON request path while keeping gateway credential headers, Google's `x-goog-api-key` override, caller `fetch`, and the shared retry stop for provider limits. Applied finite-rate/tier validation to Radius image models and restored old OAuth `classifiers` as `decision` when importing account catalogs, before falling back to network. |
| `packages/ai/src/api/openai-completions.ts`, `packages/ai/catalog/providers/openai.ts`, `packages/ai/test/providers.test.ts` | Added Copilot opaque reasoning replay to the existing tagged stream-block path. Kept prompt progress, inline tool changes, provider overrides, and retries. Upstream's Copilot cache lifetimes are additive; Fitch Pi's qualified 30-minute/12-hour OpenAI lifetimes and DeepSeek Flash's mid-conversation system messages remain. |
| `packages/ai/src/api/bedrock-converse-stream.ts`, `packages/ai/test/bedrock-convert-messages.test.ts` | Integrated Kimi replay suppression and mapped thinking levels, retaining adjacent-role merging, cache-point ordering, and strict-tool budgets. Kept both test sets. |
| `packages/ai/{catalog/providers/{together,qwen-token-plan-individual}.ts,test/together-models.test.ts}` | Took the upstream Together implementation and thinking-toggle regression coverage. Kept `qwen4-max`, and retained `ant-ling` as a deprecated configuration alias for the DeepSeek format. |
| Coding-agent `src/{cli/{agent-dir-arg,args,launcher},main,modes/interactive/interactive-mode}.ts`, `docs/environment-variables.md` | Kept both argument consumers, applied `--agent-dir` and consumed the terminal token before session startup, and retained early working-session admission. The launcher shares the worker's profile parser to route `restart` and carry the effective `--agent-dir` value, including `@profile`, into replacement workers. Normal quit clears the terminal's command; managed restart keeps it and skips input draining. Kept stale-runtime restart (#592), retry error-row cleanup (#591), and Sixel configuration. |
| Coding-agent `src/core/{agent-session-services,settings-manager}.ts` and settings, schemas, `/bug`, install scripts and tests | Reported the `models.json` warning after the fork's single refresh. Removed the install telemetry controls; provider attribution is unconditional as in upstream. The existing per-session HTTP dispatcher (#580), compaction prompt queue (#588), errored-turn background delivery (#589), and tool UX (#577) remain. |
| AI cache warming, coding-agent cache warmer and transcript, and p2 cache warming, settings and notes | Retained #593: Google replays only while a run is active, times from provider dispatch, stops on a substantially cold replay, and reports distinct missed-warm usage and notices. Other providers retain their own policy, including Copilot warming. |
| `packages/tui/src/{components/editor,tui-main-screen}.ts`, `packages/tui/test/tui-render.test.ts` | Combined upstream's signed 32-bit Kitty IDs and scroll-safe appends with Sixel row reservation, DECSC/DECRC cursor protection, and full redraw when needed. Enter and Alt+Enter apply the current suggestion; Tab and mouse selection still open slash-command argument suggestions eagerly. |
| `packages/env/daemon/src/exec.rs` | Used upstream registration tokens and session cleanup, preserving macOS's second group signal after cancellation and the post-exit output drain. Upstream's post-reap limitation for `exec` remains. |
| `packages/*/CHANGELOG.md` (11 packages) | Restored the `1.7.0` section and all earlier releases byte-for-byte from the tag. Active fork entries stay under `Unreleased`, below the package's changelog title. |

## Retired fork deltas

- Upstream's Together catalog cleanup replaces #578, and upstream now owns the same `qwen4-max`
  replacement. Upstream also supplies the Cloudflare Kimi retirement defaults and common test
  replacements from #573; the fork's distinct stream fixture coverage stays.
- The post-`v1.6.1` `/llama` highlighted-result fix is in the `v1.7.0` release notes, so its duplicate
  `Unreleased` entry is removed. Install/update reporting and its opt-out are removed with upstream,
  while the fork's own changelog display remains.

## Verification

On Apple Silicon macOS:

- `npm install --package-lock-only --ignore-scripts`, `npm install --ignore-scripts`, and
  `node scripts/generate-coding-agent-install-lock.mjs` succeeded.
- `node scripts/check-released-changelogs.mjs` matched the released sections for all 11 packages.
  `node scripts/generate-coding-agent-install-lock.mjs --check`, `node scripts/check-entry-graphs.mjs`,
  and `git diff --check` passed. Biome passed on 28 root-config files and 14 p2-config files.
- Catalog hydration generated 1,701 tool-capable models, including the three native Google image
  models. The schema workspace was built for the coding-agent test runner.
- The targeted `./test.sh` runs passed 577 tests in 20 files in 24 seconds, with no failures or skips:
  - AI, Node 24.22.3: 207 tests across cache warming, Google Interactions and Decisions, Google and
    OpenRouter images, Radius and `pi-image`, Bedrock conversion, Copilot replay, Together, and model
    catalog and usage behavior. Google verifies both `size: "2K"` and `imageSize: "2K"` on the wire.
  - Coding agent, Node 24.22.3: 92 tests across the cache warmer, `models.json` diagnostics,
    the OSC 7577 reporter, and codemode.
  - TUI, Node 24.22.3: 255 tests across rendering and the editor.
  - p2, Node 26.13.1: 21 cache-warming tests and 2 focused Chromium outbox regressions.

The full CI matrix, real-terminal managed restart, and Env platform coverage were not run locally.

Pre-push verification also passed 47 launcher tests, 6 session argument tests, and all 21 p2
cache-warming tests after updating the fixtures to the current `Args` and `workerCore` contracts.
Both package-scoped TypeScript checks passed in under 15 seconds each. A direct CLI invocation
printed the restart help with `--agent-dir /tmp/profile restart --help`. The launcher tests verify
that both `@profile` and an absolute directory survive alongside the working-session restore flag.
