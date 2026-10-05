# Semantics

The reference is Durable's `NodeExecutionEnv` (`packages/durable/src/env/node.ts`) on the remote machine. Durable's
env conformance suite and `client/test/differential.test.ts` check each rule below.

## Split of work

| Concern | Where |
|---|---|
| Path resolution: `~` (remote home), `file://`, relative to `cwd` | client, POSIX rules |
| Abort checkpoints of each method | client, as `NodeExecutionEnv` |
| Error code mapping (`ENOENT` → `not_found`, ...) | client, as `NodeExecutionEnv`'s `toFileError` |
| `readTextFile` decoding (byte-order mark kept, like `readFile(path, "utf8")`) | client |
| Line reader | client, positional reads and Durable's `StreamDecoder` |
| Timeout validation, result precedence (callback error, timeout, abort, spill failure, exit code) | client |
| System calls, processes, spill files, line scans | daemon |
| Command output decoding: per stream, WHATWG UTF-8, only a leading byte-order mark dropped | daemon (`encoding_rs`) |

## Rules the standard libraries do not follow

- Recursive `mkdir`: an existing directory is fine, an existing file fails with `EEXIST`, a file in the way of a parent
  fails with `ENOTDIR`. Writes create missing parents this way.
- `rm`: a missing path fails unless `force`; a directory without `recursive` fails with `ERR_FS_EISDIR`
  (`FileError` code `unknown`).
- `mkdtemp`: `mkdtemp(3)` of `<tmpdir>/<prefix>XXXXXX`; the prefix is joined with POSIX `path.join`, so `../x` works.
- `tmpdir`: `TMPDIR`, `TMP`, `TEMP`, then `/tmp` (Termux: `$PREFIX/tmp`), trailing slash removed.
- `listDir`: names in byte order, like libuv's `scandir`; fails if any entry cannot be lstat'ed. `openDirReader` keeps
  directory order and skips entries removed meanwhile.
- `openBinaryReader`: nonblocking open; directories fail with `is_directory`, other non-regular files with `invalid`;
  `noFollow` refuses a final symbolic link (`O_NOFOLLOW`).
- `readBinaryFile` returns a `Buffer`, reader reads a plain `Uint8Array`, as Node does.

## Commands

- A string runs through the shell: a configured `shellPath` that does not exist fails with `shell_unavailable`;
  otherwise `/bin/bash`, `which bash`, then `sh`, with `-c`. An argv array runs its program directly.
- The working directory must exist (`spawn_error`).
- Environment: with `inheritEnv` (default), the daemon's environment, then `shellEnv`, then `env`; without it, only
  `env`.
- Each command gets a new session (process group), default signal dispositions and an empty signal mask. Timeout,
  abort and `cleanup()` kill the group with `SIGKILL`.
- After the process exits, output is still collected until both pipes end, or 100 ms pass without output.
- An abort settles as `aborted`; `cleanup()` kills without aborting, so the command settles with exit code 137.
- A process killed by a signal reports `128 + signal`.
- Spill: once the output crosses `spill.afterBytes` or `spill.afterLines` (counted over raw chunks in arrival order, as
  Node counts), the complete raw output goes to `pi-output-<uuid>.log` in a fresh `tmp-` directory.
