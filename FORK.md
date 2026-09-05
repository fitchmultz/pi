# fitchmultz/pi — custom pi fork

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi).

## Setup

- The globally installed `pi` is an npm symlink into `packages/coding-agent`,
  at `~/.local/share/npm-global`. Rebuilding that checkout changes the live install.
- User config (`~/.pi/agent`: settings, skills, extensions, themes, auth) is shared
  and must not be changed by a sync.

## Remotes and history

- `origin`: upstream `earendil-works/pi`; fetch only, never push.
- `fork`: personal `fitchmultz/pi`; push `main` here.
- Local `main` tracks `fork/main`, with `branch.main.rebase=false`.
- Merge upstream into the fork. Never rebase or force-push custom commits.

## Updating from upstream

From a clean `main` checkout that is **not used by running Pi sessions**:

```sh
./sync-upstream.sh
```

The script fetches both main branches without tags or pruning, merges personal
and upstream history, installs the frozen lockfile without lifecycle scripts,
hydrates model data, builds all runtime workspaces using `build:offline`, runs the root checks,
relinks `pi` with native `npm link`, and pushes only personal `fork/main`.
Hydration fetches public model metadata without changing tracked catalog files;
`build:offline` then builds using that data.
If a merge conflicts, resolve it, run `git merge --continue`, and rerun the script.

Do not run this script in the live checkout while sessions still use it: `npm ci`
replaces dependencies and the bundle builder deletes `dist/bundle`, including lazy
chunks those sessions may still load. Instead, prepare and verify a delivery
worktree, then fast-forward both main branches to the same reviewed commit.
Activate its built outputs without deleting old hashed chunks, compare fixed-name
lazy chunks and dependency changes before replacing them, and relink the live
package with `npm link`. Do not restart or reload existing sessions.

## Reverting to stock pi

```sh
npm i -g @earendil-works/pi-coding-agent
```
