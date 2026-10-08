# Changelog

## [Unreleased]

### Fixed

- Fixed one oversized file-watch change stopping the daemon's output writer; the change is reported as `overflow` and the connection and watcher keep working ([#10516](https://github.com/earendil-works/pi/issues/10516)).
- Fixed concurrent `acceptHostKey`/`forgetHostKey` calls through equivalent known-hosts path spellings losing updates, which could restore a removed host key ([#10517](https://github.com/earendil-works/pi/issues/10517)).

## [1.1.0] - 2026-10-07

## [1.0.4] - 2026-10-05

### Added

- Initial release of `@earendil-works/pi-env`: `RemoteExecutionEnv`, a Durable `ExecutionEnv` on another machine, and `Connection` to the `pi-env` daemon that runs there. Results match `NodeExecutionEnv` on that machine on Linux, macOS, Android and Windows. The daemon watches files natively (polling on Windows and network file systems), honors output windows so dropped command output is not transferred, and keeps control replies ahead of bulk output; watchers report `overflow` and resume after a lost connection.
- SSH bootstrap: `connectSsh` detects the remote system, deploys the daemon this package ships for it (named by its SHA-256 and verified before every start), and connects; `sshConnection` does the same lazily at the first operation, so building an environment never needs the network without forwarding, shared connections or configured commands; `loginShell` starts it through the user's login shell, and Termux hosts get setup warnings. `scanHostKey`, `acceptHostKey` and `forgetHostKey` manage trusted host keys; a changed key is never accepted without removing the old one.
