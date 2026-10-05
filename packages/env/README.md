# @earendil-works/pi-env

Remote execution environments for [Pi Durable](../durable): an agent's tools run on another machine, usually over SSH,
while the Durable worker, its storage and credentials stay local.

- `pi-env` (`daemon/`): a small Rust program that runs on the remote machine. It speaks a framed protocol on stdin and
  stdout ([docs/protocol.md](docs/protocol.md)) and performs file operations and commands there.
- `RemoteExecutionEnv`: a Durable `ExecutionEnv` that talks to the daemon through a `Connection`. Its results match
  `NodeExecutionEnv` running on the remote machine; only error messages may differ
  ([docs/semantics.md](docs/semantics.md)).

```ts
import { acceptHostKey, connectSsh, HostKeyUnknownError, RemoteExecutionEnv, scanHostKey } from "@earendil-works/pi-env";

const target = { host: "gpu-box", knownHostsFile: "/data/ssh/known_hosts", hostKeyAlias: "pi-env-gpu" };
// Once: show the host's key fingerprint to the owner, who compares it out of band and accepts it.
const { lines, fingerprints } = await scanHostKey(target);
await acceptHostKey(target, lines);

// Detects the remote system, deploys this version's daemon if missing (verified by SHA-256 before it runs), and
// returns a connection that starts it over ssh.
const { connection } = await connectSsh(target);
const env = new RemoteExecutionEnv({ connection, id: "pi-env:gpu", cwd: "/home/me/project" });
```

The package ships the daemon for every supported remote system in `bin/`. `ssh` runs with `BatchMode`, strict host-key
checking against the application's own known-hosts file under a fixed alias, no forwarding, and without forwarding the
local locale. On Windows, detection and deployment go through PowerShell.

Supported remote systems: Linux, macOS, Android (Termux) and Windows, on x86-64 and arm64. On Windows, string commands
run through Git Bash as `NodeExecutionEnv` runs them there; argv commands run directly.

## Development

`npm run build:daemon` builds the daemon with Cargo; the tests talk to `daemon/target/debug/pi-env` over a pipe. They
run Durable's env conformance suite against `RemoteExecutionEnv` and compare random operation sequences and Durable's
tools against `NodeExecutionEnv` on the same machine.

Not yet: output windowing (all output is transferred) and daemon-side file watching (the client polls).
