# Development

See [AGENTS.md](https://github.com/earendil-works/pi/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/earendil-works/pi
cd pi
npm install
npm run build
```

Run from source:

```bash
/path/to/pi/pi-test.sh
```

The script can be run from any directory. Pi keeps the caller's current working directory.

### Experimental remote harness

The remote harness server/client integration is development-only. Run it from the repository with:

```bash
PI_EXPERIMENTAL=1 ./pi-test.sh server
PI_EXPERIMENTAL=1 ./pi-test.sh client
```

`PI_SERVER_DIR` overrides the server profile and socket directory (default: `~/.pi/server`). `PI_SERVER_ID` selects the logical server ID when `--server-id` is omitted.

The `client` and `experimental/plugin` package subpaths resolve only under the `source` condition in a checkout. Their implementations and the server/client commands are excluded from npm packages and standalone binaries. `pi-client`, `pi-protocol`, and `pi-server` are development dependencies of coding-agent, not runtime dependencies. The local SDK and stdio RPC API are unchanged.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.pi/agent/pi-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

### Published package smoke test

After building, run `npm run check:package-install`. It packs the public packages and installs only coding-agent as a direct dependency in a temporary directory outside the repository. Local tarball overrides select declared transitive dependencies without installing development-only packages. The check verifies SDK imports and CLI startup without credentials or model requests.

`npm run check` also checks runtime dependency declarations and rejects excluded development sources pulled into a package's build through imports.

## Startup profiling

Run `npm run profile:tui` in a terminal, or `npm run profile:rpc`. Both build the Node entrypoint by default. Use `--bundle` for the managed launcher and worker, or `--entry /absolute/path/to/cli.js` to measure an existing build without rebuilding. `--cwd /path/to/project` selects the benchmark's working directory; the default is `packages/coding-agent`.

The report prints the entrypoint, runtime, working directory, agent-directory selection and effective offline flags. It uses your configured agent directory unless `--agent-dir` or `--isolated-agent-dir` is supplied. Offline mode is forced by default; `--no-offline` preserves inherited environment flags rather than clearing them.

TUI process-to-ready time ends when `InteractiveMode.init()` completes, including awaited extension startup handlers and the initial completed render. It excludes the benchmark's subsequent 150ms terminal-reply drain and shutdown. Detached extension work is outside that boundary. RPC readiness is a successful `get_state` response. Process-to-exit time is reported separately. An older TUI target without the readiness marker is rejected instead of reporting shutdown as readiness.

`PI_TIMING=1` also records interactive initialization during ordinary CLI launches. The `main` and `extensions` timing groups measure overlapping internal spans; do not add their totals or equate them with process-to-ready wall time. The latter includes process launch and imports before instrumentation begins.

Add `--cpu-profile` for diagnostic runs. Each run gets its own directory, and default runtime filenames preserve distinct launcher and worker profiles. Profiles include post-ready work through process exit and add measurement overhead; omit this option for headline startup measurements. Use `--runs` and `--warmup` to repeat measurements.

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
