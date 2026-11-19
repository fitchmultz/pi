# Upstream integration: 2026-11-19

The fork merges upstream `653f332b6fe22e2e927dd3d553d20234a3de27f0`, 337 commits after the latest official release, v1.5.2. The previous upstream baseline was `942842439e1f1d65f68a61857ddb7590b80c5a92`.

## What comes from upstream

- `apps/p2` adopts upstream's owner-defined projects (explicit membership, location picker, drag-and-drop reordering, archive/restore, and removal of the old project glyph/SVG plugin), removes empty-project list spacing when expanding a project without sessions, draws sidebar working dots in whole pixels without braille glyphs, shows running subagents above the main conversation composer, and marks sidebar status as working while any conversation in the session runs. Fork-specific p2 behavior (offline outbox, macOS Chromium `--use-mock-keychain`, and documented worker/TUI/server fixes) is preserved.
- `apps/p3` adopts upstream's rename-based secret writes (avoiding hard links on Android), Node 26 session-worker V8 zone memory management, `/proc`-free worker lookup for Android, and its `>=26.3.1` engine requirement (scoped to `apps/p3` only; the root packages and `apps/p2` retain Node 24 support).
- `package-lock.json` updates only the `apps/p3` engine metadata from upstream's `apps/p3/package.json` change; `packages/coding-agent/install-lock` is unchanged.

## Verification boundaries

Root `npm run check`, `apps/p2` `npm run check`, and affected `apps/p2` unit tests (`projects`, `sidebar-model`, `contract-versions`, `conversations`, `project-place`) pass locally on Node 24.22.3. Full multi-package, Environments, and Nix checks run in GitHub Actions.
