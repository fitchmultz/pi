# Changelog

## [Unreleased]

### Added

- Initial release of `@earendil-works/pi-env`: `RemoteExecutionEnv`, a Durable `ExecutionEnv` on another machine, and `Connection` to the `pi-env` daemon that runs there. Results match `NodeExecutionEnv` on that machine on Linux, macOS, Android and Windows.
- SSH bootstrap: `connectSsh` detects the remote system, deploys the daemon this package ships for it (verified by SHA-256 before it runs), and connects; `scanHostKey` and `acceptHostKey` manage trusted host keys.
