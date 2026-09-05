#!/usr/bin/env bash
# Run only in a checkout not used by running Pi sessions; see FORK.md.
set -euo pipefail
cd "$(dirname "$0")"

[[ $(git branch --show-current) == main ]] || { echo "Run from main" >&2; exit 1; }
git fetch --no-tags --no-prune --no-prune-tags origin refs/heads/main:refs/remotes/origin/main
git fetch --no-tags --no-prune --no-prune-tags fork refs/heads/main:refs/remotes/fork/main
git merge --no-edit fork/main
git merge --no-edit origin/main
git branch --set-upstream-to=fork/main main
git config branch.main.rebase false

npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm run check
(cd packages/coding-agent && npm_config_prefix="$HOME/.local/share/npm-global" npm link --ignore-scripts)
"$HOME/.local/share/npm-global/bin/pi" --version
git push fork main:main
