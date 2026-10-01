# Profiling

## Startup

Run `npm run profile:tui` in a terminal or `npm run profile:rpc`. Both build the Node entrypoint by default. Use `--bundle` for the managed launcher/worker, or `--entry /absolute/path/to/cli.js` to measure an existing build. `--cwd /path/to/project` selects the benchmark working directory; the default is `packages/coding-agent`.

Reports identify the entrypoint, runtime, working directory, agent directory, and effective offline flags. The configured agent directory is used unless `--agent-dir` or `--isolated-agent-dir` is supplied. Offline mode is forced by default; `--no-offline` preserves inherited environment flags rather than clearing them.

TUI process-to-ready time ends when `InteractiveMode.init()` completes, including awaited extension startup handlers and the initial completed render. It excludes the subsequent 150ms terminal-reply drain and shutdown. Detached extension work is outside that boundary. RPC readiness is a successful `get_state` response. Process-to-exit time is separate. Older TUI targets without the readiness marker reject rather than reporting shutdown as readiness.

`PI_TIMING=1` also records ordinary interactive initialization. Its `main` and `extensions` spans overlap; do not add them or equate them with process-to-ready wall time, which includes earlier launch/import work.

Add `--cpu-profile` for diagnostics. Each run has a separate directory and launcher/worker filenames. Profiles include post-ready work through exit and add overhead; omit profiling for headline startup measurements. Use `--runs` and `--warmup` for repeated measurements.

See the [package README](../README.md#development) for source setup and [FORK.md](../../../FORK.md) for fork verification and installation.

## Session history scaling

`node scripts/bench-session.mjs --help` describes the opt-in, local, offline benchmark. It is not run by checks, tests, or CI and never builds or selects a runtime. Pass `--runtime` with an already built checkout's `packages/coding-agent` directory or an installed release's coding-agent package directory. The driver requires tmux; `heap` also requires Node's `--expose-gc`.

```sh
runtime=/absolute/path/to/coding-agent-package
node scripts/bench-session.mjs generate --runtime "$runtime" --windows 1 --out /tmp/bench-small
node scripts/bench-session.mjs generate --runtime "$runtime" --windows 55 --out /tmp/bench-xl
# Use each generated JSON result's file path:
node scripts/bench-session.mjs drive --runtime "$runtime" --session /tmp/bench-xl/SESSION.jsonl --out /tmp/bench-run
node scripts/bench-session.mjs summarize --skip 5 /tmp/bench-run/bench.jsonl
node --expose-gc scripts/bench-session.mjs heap --runtime "$runtime" --session /tmp/bench-xl/SESSION.jsonl --appends 100
```

Output directories must be new; omit `--out` for a created temporary directory. Runs retain the copied journal, isolated home/agent/project, `run.json` runtime/options, per-turn `bench.jsonl`, and terminal `pane.out`. Originals and personal settings are never modified or copied. Delete only your benchmark output directories when finished.

The faux extension performs a real local `read` followed by a streamed markdown answer. Metrics separate request preparation, streaming, tool dispatch/execution, final bookkeeping, event-loop delay, terminal writes, and memory. Input-to-`agent_end` is not full settlement or process-to-ready time. Use equal run counts and exclude warmup; compare S/XL at the same streaming rate, terminal dimensions, and explicit extension set. The generator resets before every window, including the first, so final active payload size is equal; archived windows vary independently. Unlike the original research fixture, XL does not retain six extra turns. Regenerate both sides when comparing revisions.

`--active-turns` changes only the final window (default: `--turns`), with two assistant messages per turn. `--thinking-chars` and `--signature-chars` set each assistant's payload sizes (defaults: 1000 and 4000 ASCII characters, matching the research generator). For a larger retained window, generate both S and XL with `--active-turns 120 --signature-chars 12000`; this retains 240 assistants with 12 KB signatures instead of testing only small assistant bodies.

No personal extensions, credentials, settings, or project resources load by default. `--ext` and `--package` accept explicit local paths only; those extensions remain trusted executable code, not a network sandbox. `--cpu-profile` records whole-process profiles under the run directory but adds overhead. The optional `heap` command reports open/retained heap, warmed full-result and newest-32 queries, projection, and append costs; cold rebuilds and full-history output are not constant-time operations.
