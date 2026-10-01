# Live RPC/TUI handoff inventory

Authority: `/tmp/fork-infra/brief-keeps.md`, common rules and rpc section. Its later owner-confirmed keep supersedes the earlier drop in `/tmp/fork-1.0-port-brief.md`.

## Existing capabilities

Old fork (`fork/main`): `src/modes/rpc/rpc-mode.ts:601` accepts `attach_tui` only on PTYs, validates or generates an attachment UUID, flushes JSON before terminal output, and returns via SIGUSR2 with a token-prefixed `tui_detached` state snapshot (`:887-935`). Pending RPC dialogs/custom components move to the TUI and replay on detach (`:858-885`). Hosted interactive lifecycle preserves the live runtime without restarting extensions. Later fixes preserve mode across reload, editor factory composition, and dismiss RPC-answered native editors.

Pi 1.0 baseline: `packages/coding-agent/src/modes/rpc/rpc-mode.ts:54` owns JSON stdin/stdout and binds RPC extension UI (`:317-376`); pipe dialogs work but custom components return undefined (`:237`). `src/modes/interactive/interactive-mode.ts:950` initializes the current terminal renderer; `:2090` rebinds the same runtime, but binding emits session_start. `src/core/extensions/runner.ts:564` can update frontend mode; `src/core/agent-session.ts:3216` retains bindings across reload, with no mode-only setter. `src/core/output-guard.ts:68-109` already supports stdout takeover/restoration and flushing. `src/modes/rpc/jsonl.ts:21` provides detachable LF-only input.

Owner extension-source search found no attach_tui consumer. The coordinator found the real consumer in `~/Projects/workos/axiom`: its native terminal expects attach_tui with a UUID token and the framed detach snapshot. Its pre-startup attachment behavior belongs to Axiom's own patch stack, not the fork; preserve 1.0's bind-before-input startup order. pi-subagents uses SIGUSR2 for a separate interrupt path, not PTY attachment. No personal files will be changed.

## Delta

Add attach_tui/token validation and framed SIGUSR2 return, preserving live session, streaming work, queued input, and extension UI. Share existing InteractiveMode with RPC through a hosted lifecycle; preserve the RPC bridge on attach/reload, so session_start does not repeat just for ownership changes. Expose pending requests in get_state and the detach snapshot. Preserve ordinary pipe RPC and custom UI's pipe fallback. Document PTY setup/framing and limitations.

## Core boundaries

An extension cannot transfer ownership of RPC stdin/stdout or start the CLI's native renderer. These core changes are required:

- `src/modes/rpc/rpc-mode.ts`: owns attachment/return, output flushing, input transfer, and the persistent RPC/native extension UI bridge. Reuses the existing stdout guard and detachable JSONL reader.
- `src/modes/rpc/rpc-types.ts`: types the new command, attachment token, detach snapshot, and pending custom request.
- `src/modes/interactive/interactive-mode.ts`: hosts the existing renderer without rebinding extensions on ownership changes; seeds an active stream and stops/restarts terminal IO without destroying its UI tree. Keeps hidden title/progress writes out of RPC output.
- `src/core/agent-session.ts`: retains a frontend mode change across reload without emitting another `session_start`.
- `src/core/extensions/types.ts` and `runner.ts`: optional editor abort signal lets an RPC answer dismiss the corresponding suspended native editor.
- `src/main.ts`: creates the hosted renderer only for POSIX terminal-backed RPC.
- `src/modes/index.ts` and `src/index.ts`: expose the new RPC options and detach event alongside existing public RPC types.

User references: `docs/rpc.md`, `docs/rpc-commands.md`, `docs/rpc-extension-ui.md`, `docs/extensions.md`, and the coding-agent changelog. Behavior coverage: `test/rpc-tui-handoff.test.ts`.

## Verification and limits

- `npm ci --ignore-scripts` and approved model-data hydration completed.
- `npm run check`: clean, including formatting, dependency/install-lock checks, TypeScript, and browser smoke.
- Targeted Vitest run: 82 tests passed in `rpc-tui-handoff`, `rpc-jsonl`, `rpc-prompt-response-semantics`, `extensions-runner`, and `suite/agent-session-runtime`.
- Real private-socket tmux PTY smoke with isolated HOME/environment and the faux provider: rendered reply, custom dialog, framed detach, same-session state, pending request replay, reattachment/native answer, and a second RPC prompt completing after return. Rendered captures and protocol bytes are saved under `/tmp/rpc-pty-smoke`; the tmux server and temporary execution files were removed.
- `git diff --check`: clean. No live provider calls, personal configuration changes, or push.

The earlier `interactive-mode-status` run exposed four pre-existing compact-view fixture failures; they were left untouched. The coordinator reports their repair is already in the integration branch (`feb4606b2`, merged by `6197990e1`).

Handoff is POSIX-only and requires the host to provide a controlling PTY, send LF-framed RPC input, and switch between JSON and terminal-byte parsing. Events during TUI ownership are not replayed: recover them through session queries. Bind-before-input startup is unchanged; awaited startup UI requires separate host startup coordination, as in Axiom's own patch stack. No old-code test-first reproduction is claimed: the new contract is exercised through the current renderer and real PTY.
