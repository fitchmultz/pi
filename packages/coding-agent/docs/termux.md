# Run Pi on Android with Termux

Pi runs on Android through [Termux](https://termux.dev/), a terminal emulator and Linux environment. Text input, file tools, and shell commands are supported. Pi can copy and paste text through the Android clipboard with Termux:API. Clipboard image paste is not supported.

## Before you begin

Install Termux from [GitHub or F-Droid](https://github.com/termux/termux-app#installation). Do not use the deprecated Google Play build.

[Termux:API](https://github.com/termux/termux-api#installation) is optional. Install it only when you want Pi to copy or paste Android clipboard text, or when shell commands need Android device APIs.

## Install Pi

1. Update Termux packages:

   ```bash
   pkg update && pkg upgrade
   ```

2. Install Node.js and Git:

   ```bash
   pkg install nodejs git
   ```

3. Install Pi:

   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   ```

4. Verify the installation:

   ```bash
   pi --version
   ```

5. Open the folder you want to work in and start Pi:

   ```bash
   cd /path/to/working-folder
   pi
   ```

Continue with the main [Quickstart](quickstart.md#3-choose-a-model) to connect a model and run your first task.

### Install the fork

The fork's immutable installer and `pi update --fork` support Termux arm64/x64.
Install the build and validation tools:

```bash
pkg install nodejs git bash tar gzip tmux golang
```

Use Node.js >=22.19 with its adjacent npm. Go >=1.26 is needed only if Android
blocks the TypeScript compiler's fanotify probe. The installer first tries the
lockfile-pinned Linux compiler; on that specific failure it rebuilds the package's
pinned source commit with fanotify disabled. It never changes the root lockfile
or runs dependency lifecycle scripts.

From a fork checkout, with unused selector and executable locations:

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
selector="$HOME/.local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent"
node scripts/install-fork.mjs --ref HEAD --selector "$selector"
mkdir -p "$HOME/.local/bin"
ln -s "$selector/dist/bundle/cli.js" "$HOME/.local/bin/pi"
export PATH="$HOME/.local/bin:$PATH"
```

Keep `~/.local/bin` on your shell's `PATH`. Do not replace the selector with a real
directory or point `pi` directly at a release. Once installed, run
`pi update --fork` to fetch, pin, build, validate, and select latest fork main
without a local checkout. See [fork installation](quickstart.md#fork-installation)
for staging and rollback.

Builds, consumer smoke tests, and `test.sh` retain Termux's `PREFIX` and
`LD_PRELOAD` exec wrapper while isolating home/configuration. npm scripts use the
native Termux bash rather than `/bin/sh`. The installer selects the prepared
compiler before `build:offline`; TypeScript API checks also use that compiler.

## Access Android shared storage

Termux cannot access shared Android storage until you grant permission. Run this once:

```bash
termux-setup-storage
```

After approval, Android shared storage is available under `/storage/emulated/0` and through the links Termux creates under `~/storage/`.

Only grant this permission when Pi should be able to access those files. Commands and tools running in Termux use the same storage permissions as the Termux process.

## Use clipboard commands

Pi uses `termux-clipboard-set` to copy text and `termux-clipboard-get` for its clipboard-paste shortcut. Shell commands can use both commands directly. Install the Termux:API app and its command-line package:

```bash
pkg install termux-api
```

Verify the integration:

```bash
printf 'Pi clipboard test' | termux-clipboard-set
termux-clipboard-get
```

The second command should print `Pi clipboard test`.

The Termux clipboard API supports text only. Pi's clipboard-paste shortcut inserts that text into the editor but cannot attach clipboard images.

## Add Termux-specific instructions

Pi detects that it is running in Termux, but it cannot infer how you want it to interact with Android. Add only the environment details relevant to your work to `~/.pi/agent/AGENTS.md`:

````markdown
# Termux environment

- Pi runs in Termux on Android.
- Shared Android storage is under `/storage/emulated/0`.
- Open URLs with `termux-open-url "https://example.com"`.
- Open files with `termux-open <path>`.
- Do not access shared storage unless the task requires it.
````

Run `/reload` after changing the file during an active session.

## Troubleshooting

### Clipboard integration fails

Confirm that you installed both components:

1. The Termux:API Android app from the same source as Termux
2. The `termux-api` command-line package

Then run the clipboard verification commands above outside Pi. If they fail there, fix the Termux:API installation before retrying Pi's copy command.

### Shared storage reports permission denied

Run `termux-setup-storage`, approve the Android permission request, and retry the path under `~/storage/` or `/storage/emulated/0`.

### Pi is not found after installation

Open a new Termux shell and run:

```bash
npm prefix -g
command -v pi
```

Confirm that the global npm binary directory is on `PATH`, then reinstall Pi if the package is missing.
