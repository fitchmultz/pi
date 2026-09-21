#!/usr/bin/env bash
# Prepare an isolated upstream integration; never install or update main here.
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/scripts/sync-upstream.mjs" "$@"
