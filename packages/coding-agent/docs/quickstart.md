# Quickstart

Pi runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install Pi

On macOS or Linux, you can use the installer:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

The installer pins all dependencies and updates Pi with `pi update`. Alternatively, install Pi from npm, which does not pin transitive dependencies. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi does not require dependency lifecycle scripts for a normal npm installation.

With Nix on macOS or Linux, install the latest release from Pi's flake. Nix builds Pi from source:

```bash
nix profile add github:earendil-works/pi/stable
```

Older Nix versions use `nix profile install` instead. Update with `nix profile upgrade pi`; `pi update` cannot update a Nix installation. To pin a release, use a tag such as `github:earendil-works/pi/v1.0.0`.

Verify the installation:

```bash
pi --version
```

### Fork installation

For the fitchmultz/pi fork, use an immutable release rather than an ordinary npm
package directory. This supports macOS, Linux, and [Termux](termux.md#install-the-fork)
on arm64/x64 with Node.js >=22.19, npm installed alongside Node, Git, bash, tar,
gzip, and tmux.

From a fork checkout, install dependencies without lifecycle scripts, hydrate the
model-data snapshot, then build and validate an exact commit:

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
selector="$(npm root -g)/@earendil-works/pi-coding-agent"
node scripts/install-fork.mjs --ref HEAD --selector "$selector"
ln -s "$selector/dist/bundle/cli.js" "$(npm prefix -g)/bin/pi"
```

The selector and `pi` link locations must be writable. These commands are for
initial setup with unused locations: the installer refuses to replace a real
package directory, and `ln -s` refuses to overwrite an existing executable.
Do not point `pi` directly at a release; it must follow the package selector.

After setup, update without keeping a checkout:

```bash
pi update --fork
```

The updater fetches and pins fork main, hydrates model data in an isolated home,
then uses the installer to build, validate, and atomically select the release
under `~/.local/share/pi-fork/releases`. It does not edit settings, credentials,
extensions, or sessions. Running sessions keep their runtime until a full relaunch
or a [managed restart](restart.md).

The installer also supports `--stage`, `--activate <identity>`, and
`--rollback <identity>`; pass the same `--selector` for each operation.
The prior package target is preserved as `<selector>.previous`.
Run `node scripts/install-fork.mjs --help` for options and pruning safeguards.

Updates, staging, activation, rollback, and pruning share `<selector>.lock`.
Concurrent mutations fail rather than using stale protection snapshots. Locks are
not stolen based on age: after an unclean termination, remove an abandoned lock
directory only after confirming every updater/installer using that selector has
stopped.

Each release store has one owning selector, recorded as a canonical path in
`.owner-selector`. A store without that file (including existing fork stores) is
adopted by the first mutation; its releases are preserved. Other selectors are
refused, even for staging or pruning. Use a separate `--releases` directory for
another selector. `pi update --fork` uses the unchanged default store above and
refuses it if another selector owns it.

Only newly installed releases receive an ownership stamp in their receipt.
Pruning requires that stamp to match the store's owner; existing releases are
never assigned to the first claimant, even when reused or activated.
Legacy releases are kept until removed by hand.

Dependency installs and packing use an isolated environment and an empty temporary
npm global configuration, not the native Node prefix's registry credentials or
ambient provider keys and `NODE_OPTIONS`.

## 2. Start Pi

Change to the folder you want Pi to work with, then start it:

```bash
cd /path/to/folder
pi
```

The working folder helps Pi discover relevant files, instructions, and configuration. Pi also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="Pi running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use Pi in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates Pi's responses. A **provider** is the service or account Pi uses to access that model.

In Pi, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give Pi a task

Pi shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When Pi finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

Pi saves sessions automatically. Exit Pi, then resume the most recent session for the same working folder with:

```bash
pi --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use Pi interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that Pi should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize Pi

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give Pi persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Pi package](packages.md) |

## Uninstall Pi

If you installed Pi with npm, run:

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

If you used the installer, run it again and choose **Uninstall Pi**:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

If you installed Pi with Nix, run:

```bash
nix profile remove pi
```

None of these methods removes configuration, credentials, sessions, or installed Pi packages from `~/.pi/agent/`.
