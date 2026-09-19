# fitchmultz/pi — custom pi fork

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi).

## Installation

The global `pi` entrypoint under `~/.local/share/npm-global` selects an immutable
release under `~/.local/share/pi-fork/releases/<commit>/packages/coding-agent`.
It does not point at the development checkout. Each release retains its own
built workspace graph and dependencies, including lazy bundle chunks.

User configuration under `~/.pi/agent` is shared. A core sync must not change
settings, credentials, skills, extensions, themes, or session journals.

## Remotes and history

- `origin`: upstream `earendil-works/pi`; fetch only, never push.
- `fork`: personal `fitchmultz/pi`; deliver reviewed changes here.
- Local `main` tracks `fork/main`, with `branch.main.rebase=false`.
- Merge upstream into the fork. Never rebase or force-push custom commits.

## Updating from upstream

Prepare a separate delivery worktree from the fork's reviewed base. Merge the
chosen upstream commit normally, preserving ancestry and native fork behavior.
Resolve conflicts individually. AgentSession extensions continue to use the
ordinary host.

From that worktree, install and validate the complete workspace graph:

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm run check
./test.sh
```

Hydration fetches public model metadata without changing tracked catalogs.
`build:offline` uses that data without regenerating tracked catalogs. Review any
intentional catalog regeneration separately. Use `./test.sh`, not ambient
`npm test`, so provider credentials and personal resources are isolated. Shell
initialization must not replace the real Node/npm binaries with environment
manager shims inside the isolated test home.

Review the integration and affected extension behavior before merging delivery.
Do not use the legacy `sync-upstream.sh` delivery flow: it rebuilds and relinks a
mutable checkout in place.

## Reinstalling and activating the fork

After reviewed delivery, stage the exact merged commit in a **new** release
directory under `~/.local/share/pi-fork/releases/`. Install its frozen dependencies,
hydrate model data, and build the complete graph there. Verify the candidate's
`packages/coding-agent/dist/bundle/cli.js` and `cli-worker.js`, extension imports,
and runtime identity before atomically selecting its package directory for the
global entrypoint. Record the commit and build evidence. Never overwrite an
existing release, rebuild a loaded snapshot, or copy individual chunks into it.
Do not use `npm link` to select the development checkout.

Existing processes retain their loaded release. Activate a validated runtime in
the current managed session with native restart:

```sh
pi restart \
  --runtime "$HOME/.local/share/pi-fork/releases/<commit>/packages/coding-agent" \
  --message "Verify the updated runtime and continue"
```

This queues activation at a safe idle boundary; acknowledgment is not readiness.
Keep the previous release and extension files intact for rollback. `/reload`
does not apply code changes. The launcher remains loaded across worker restarts;
launcher changes take effect on the next full CLI launch. See
[Managed Restarts](packages/coding-agent/docs/restart.md) for admission, readiness,
rollback, and supported modes. Never delete session journals during delivery.

## Reverting to stock pi

Install stock Pi separately and select its entrypoint only after verification.
Keep the fork releases and saved sessions intact. Posthorse requires the fork's
native context-window primitives and is not supported by the stock host.
