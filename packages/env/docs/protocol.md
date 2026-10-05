# pi-env wire protocol

Version 1. The client starts `pi-env serve --token <hex>` (over `ssh`, or directly in tests) and talks to it over the
process's stdin and stdout. stderr is diagnostic text for logs only.

## Sync

Shell startup files may print to stdout before the daemon runs. The daemon's first output is the line
`PI-ENV <token>\n`, with the token from its command line. The client discards everything before that line. After it,
stdout carries only frames.

## Frames

Every frame, in both directions:

```text
u32 length      bytes after this field
u8  type
u32 id          request id; 0 for frames that belong to no request
u32 jsonLength
json            UTF-8 JSON object, jsonLength bytes
bytes           raw payload, the remaining length - 9 - jsonLength bytes
```

All integers are big-endian. A frame is at most 16 MiB; larger payloads are split by the operations that carry them.

| type | name | direction | meaning |
|---|---|---|---|
| 1 | request | client → daemon | `json.op` names the operation |
| 2 | result | daemon → client | success of request `id`; the request is finished |
| 3 | error | daemon → client | failure of request `id`; the request is finished |
| 4 | event | daemon → client | progress of a running request (`exec` output), not finishing it |
| 5 | cancel | client → daemon | abort request `id`; it still finishes with `result` or `error`. `{ mode: "kill" }` kills an `exec` without aborting it, so it settles with the killed process's status, as `cleanup()` does |
| 6 | ping | both | liveness; the receiver ignores it |

Errors are `{ code, message, syscall?, path? }`. `code` is a Node-style error code (`ENOENT`, `EISDIR`,
`ERR_FS_EISDIR`, ...) or one of the execution codes `shell_unavailable`, `spawn_error`, `timeout`, `aborted`, `unknown`.
Messages are diagnostic; only codes are part of the contract.

Paths are absolute JSON strings; the client resolves relative paths, `~` and `file://` URLs before sending, and they
are encoded as UTF-8, as Node encodes string paths. File contents and output travel as raw payload bytes.

## Liveness

Each side sends `ping` every 5 seconds. The daemon kills every process group it started and exits after 30 seconds
without any frame from the client, or when stdin ends. A dropped connection therefore stops remote commands.

## Operations

`hello { protocol }` → `{ protocol, version, os, arch, home, tmpdir, pid }`. The first request. `os` and `arch` are
Rust's `std::env::consts` values; `tmpdir` follows the remote Node's `os.tmpdir()` rules.

File operations take `{ path }` (and the listed fields) and return `{}` unless noted:

| op | fields | result |
|---|---|---|
| `lstat` | | `info` |
| `realpath` | | `{ path }` |
| `write` | `append`, payload | creates missing parent directories like Node's recursive `mkdir` |
| `truncate` | `size` | |
| `fsync` | | |
| `rename` | `to` | |
| `mkdir` | `recursive` | |
| `rm` | `recursive`, `force` | Node `fs.rm` semantics |
| `mkdtemp` | `prefix` (in `tmpdir`) | `{ path }` |
| `open` | `noFollow` | `{ handle, info }`; regular files only |
| `pread` | `handle`, `offset`, `length` | payload |
| `fstat` | `handle` | `info` |
| `scanLines` | `handle`, `startLine`, `endLine?` | `LineScan` |
| `opendir` | | `{ handle }` |
| `readdir` | `handle`, `max` | `{ entries, done }` |
| `close` | `handle` | |

`info` is `{ name, kind, size, mtimeSec, mtimeNsec, dev, ino }` with `kind` one of `file`, `directory`, `symlink`, `other`.
`readdir` entries are `{ name, info }` or `{ name, error }` when the entry's `lstat` failed; names that are not valid UTF-8
are decoded lossily, as Node does. Handles are numbers, valid until `close` or the end of the connection.

`exec { command | argv, cwd, env, inheritEnv, shellPath?, timeoutMs?, spill?, window? }` runs a shell string or an
argv array. While it runs, `event` frames `{ kind: "output", stream, skipped? }` carry decoded output text as UTF-8
payload. The result is `{ exitCode?, signal?, spillPath? }`; failures are errors with codes `timeout` or `aborted`
(carrying `spillPath`), `shell_unavailable`, `spawn_error`, or `unknown` (spill failure). `cancel` kills the command's
process group.
