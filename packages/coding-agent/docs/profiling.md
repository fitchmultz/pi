# Startup Profiling

Run `npm run profile:tui` in a terminal or `npm run profile:rpc`. Both build the Node entrypoint by default. Use `--bundle` for the managed launcher/worker, or `--entry /absolute/path/to/cli.js` to measure an existing build. `--cwd /path/to/project` selects the benchmark working directory; the default is `packages/coding-agent`.

Reports identify the entrypoint, runtime, working directory, agent directory, and effective offline flags. The configured agent directory is used unless `--agent-dir` or `--isolated-agent-dir` is supplied. Offline mode is forced by default; `--no-offline` preserves inherited environment flags rather than clearing them.

TUI process-to-ready time ends when `InteractiveMode.init()` completes, including awaited extension startup handlers and the initial completed render. It excludes the subsequent 150ms terminal-reply drain and shutdown. Detached extension work is outside that boundary. RPC readiness is a successful `get_state` response. Process-to-exit time is separate. Older TUI targets without the readiness marker reject rather than reporting shutdown as readiness.

`PI_TIMING=1` also records ordinary interactive initialization. Its `main` and `extensions` spans overlap; do not add them or equate them with process-to-ready wall time, which includes earlier launch/import work.

Add `--cpu-profile` for diagnostics. Each run has a separate directory and launcher/worker filenames. Profiles include post-ready work through exit and add overhead; omit profiling for headline startup measurements. Use `--runs` and `--warmup` for repeated measurements.

See the [package README](../README.md#development) for source setup and [FORK.md](../../../FORK.md) for fork verification and installation.
