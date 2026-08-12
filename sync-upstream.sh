#!/usr/bin/env bash
# Sync this fork with upstream earendil-works/pi and rebuild.
# Global `pi` is an npm symlink into packages/coding-agent, so rebuilding updates the live install.
set -euo pipefail
cd "$(dirname "$0")"

git fetch upstream --tags
git merge upstream/main   # ponytail: plain merge, custom commits on main stay; resolve conflicts then rerun
git push origin main

npm install
for p in tui telemetry ai agent protocol client coding-agent; do
  npm run build --prefix "packages/$p"
done

pi --version
