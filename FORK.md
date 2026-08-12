# fitchmultz/pi — custom pi fork

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi).

## Setup

- The globally installed `pi` is an **npm symlink into this checkout** (`packages/coding-agent`),
  not the published npm package. Rebuilding here changes the live `pi` immediately.
- All user config (`~/.pi/agent`: settings, skills, extensions, themes, auth) is untouched and
  shared, since pi reads it regardless of which build runs.
- Baseline: `v0.84.1`, identical to the previously npm-installed release.

## Invariant: upstream sync always works

- `upstream` remote: fetch-enabled, **push disabled** (`git remote set-url --push upstream DISABLED`).
- Custom commits live on `main`; upstream is merged in, never rebased away.

## Updating from upstream

```sh
./sync-upstream.sh
```

Fetches upstream (with tags), merges `upstream/main` into `main`, pushes to the fork,
reinstalls deps, rebuilds all packages, and prints the new `pi --version`.
If the merge conflicts: resolve, `git merge --continue`, rerun the script.

## Reverting to stock pi

```sh
npm i -g @earendil-works/pi-coding-agent
```
