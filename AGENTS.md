# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Execution and Authorization

- Implement requested outcomes end to end. Make ordinary reversible architecture, dependency, configuration, permission and environment decisions yourself; use available access for the full requested capability without bypassing enforced safeguards or exposing secrets.
- Reuse Pi's public APIs and existing code first, then maintained OSS and useful dependencies instead of bespoke substitutes. Dependency adoption is ordinary implementation work, subject to the concrete install safeguards below.
- Use isolated task worktrees and branches. Delegate independent research, implementation, tests and review freely when useful; the owning agent remains responsible for integration and delivery.
- Research discoverable facts and reuse settled decisions before asking. Ask only for missing owner-only information/access or an unresolved choice that materially changes the authorized outcome, risks irreversible data loss/private disclosure, or creates substantial new cost.
- Treat requests such as "can you fix..." and "I want..." as instructions to act. Pure explanation, review and planning requests remain read-only unless implementation is also requested. Existing task or standing authorization counts: do not stop at a plan or request the same approval again.

## Upstream Integration

- Follow [FORK.md](FORK.md) for canonical fork policy, approved integration decisions, and verification.
- Default to upstream public APIs and architecture. Preserve approved outcomes, not old fork mechanisms: replace equivalent behavior and delete the redundant path.
- Adapt only approved differences that upstream does not cover; do not disable upstream capabilities to preserve fork internals.
- Behavior, cache stability, and safety requirements take precedence over old API or test shapes. Ask only about material unresolved behavior differences; do not reopen settled decisions without new evidence.

## Code Quality

- For investigations, read relevant sections and complete functions first. Expand to full files when needed to resolve uncertainty. Read files in full before editing them.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Before adding custom functionality, inspect Pi's APIs and installed dependencies. Trace relevant callers and verify required behavior from source, types, docs, or runtime evidence; resolve discoverable unknowns and state remaining uncertainty rather than guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Preserve intended functionality, public contracts and data integrity. Remove redundant mechanisms when the authorized replacement covers their behavior; investigate uncertain intent rather than asking by default. Ask only if completing the task requires an unapproved material behavior change.
- Do not add compatibility layers for obsolete interfaces unless requested; preserve contracts required by the authorized outcome.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Builds and tests needed for an authorized implementation are covered by the standing fork delivery authorization below. Run the full offline suite through `./test.sh`, not ambient `npm test`.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit without explicit or standing user authorization.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Inspect required lifecycle scripts before running them explicitly. Reviewed scripts needed for an authorized task do not need another approval; do not enable arbitrary dependency scripts wholesale.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/install-lock/` needs regen, run `node scripts/generate-coding-agent-install-lock.mjs` (verify with `--check` or `npm run check`). Review new dependency lifecycle scripts and add any required explicit allowlist entry in that script as part of the reviewed change.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Set it for reviewed lockfile changes required by the authorized task; keep the lockfile check and other hooks enabled.

## Git

Work in an isolated task worktree based on current `fork/main`, not the shared primary checkout. Other sessions may own other worktrees or local changes; preserve them. Coordinate before refreshing shared checkouts or activating a runtime.

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Preserve work and checks:

- Never discard, stash or stage another session's changes. In an isolated task worktree, use targeted Git operations only after inspecting status and preserving any unsaved work; never use broad destructive cleanup on a shared checkout.
- Never use `git add -A`, `git add .` or `git commit --no-verify`.

If rebase conflicts occur:

- In your isolated task branch, inspect both sides and resolve conflicts needed for the task, preserving unrelated work and approved behavior. File ownership alone is not a reason to ask the user.
- If an unresolved conflict requires an owner-only behavior decision, abort the rebase and ask that specific question; continue independent work.
- Never rebase shared fork history or force push. If an already-pushed task branch needs integration, merge `fork/main` instead.

## Issues and PRs

For issue creation or PR submission, read and follow [CONTRIBUTING.md](CONTRIBUTING.md) for contributor versus maintainer scope, the target repository's contributor gate (auto-close workflows, `lgtm`/`lgtmi`), quality bar, and shared verification.

When reviewing PRs:

- Keep the current task checkout intact. Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs for metadata, commits and patches.
- Fetch/read missing PR file contents into temporary files or use `git show <ref>:<path>`. If executable verification needs a checkout, use a separate isolated worktree; a review request remains read-only with respect to the proposed change.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

Contributors leave changelogs alone. These procedures apply to authorized maintainers, including fork maintainers.

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Only create entries on `main` or a pull-request branch.

Attribution (use the issue or PR's repository in the link):

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

For release preparation, publishing, verification, or recovery, load and follow [.pi/skills/release.md](.pi/skills/release.md).

## User Override

User instructions, including existing task and standing authorization, govern authorized work. Apply them without reconfirmation; resolve routine ambiguity through repository evidence and ordinary reversible decisions.

### Standing Fork Delivery Authorization

Owner-authorized implementation in `fitchmultz/pi` includes necessary model-data refreshes, local builds, test-artifact regeneration, environment repairs, tests/checks, commits, pushes, PRs, review, CI and merge. Ship through a PR, follow checks to completion, fix failures and actionable review findings (or record evidence-backed rebuttals), and merge through repository rules. Then refresh the canonical local checkout without overwriting unrelated work, install/verify changed resources, and remove only the task's clean worktree and obsolete branch. Planning and review-only requests remain read-only.

For runtime changes, complete staging, verification and activation of the merged fork runtime with rollback preserved; merge alone is not delivery. Follow `FORK.md` for fresh model data, catalog comparison, immutable installation and activation. For guidance-only changes, refresh and verify the actual canonical/installed guidance sources; do not rebuild unchanged core code, activate a runtime or restart unrelated sessions merely for Markdown edits.

After activation, all agents must immediately restart and continue under the new runtime. Coordinate connected sessions, preserve their saved work, and verify this session's actual running runtime after restart; selector activation or a queued restart alone is not completion.

Public package releases/publishing, paid provider probes, credential changes, destructive actions affecting user data and material scope expansions require authorization beyond ordinary fork delivery unless the current task already includes them. Use available credentials normally without exposing them; do not confuse credential use with credential changes. Preserve shared-worktree coordination and all verification gates.
