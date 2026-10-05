export { Connection, type ConnectionOptions, RemoteError, type RemoteInfo, type RequestOptions } from "./connection.ts";
export { PollingWatcher } from "./polling-watch.ts";
export { RemoteExecutionEnv, type RemoteExecutionEnvOptions } from "./remote-env.ts";
export {
	acceptHostKey,
	connectSsh,
	deployDaemon,
	detectPlatform,
	HostKeyChangedError,
	HostKeyUnknownError,
	packagedDaemon,
	type RemotePlatform,
	type SshConnectOptions,
	SshError,
	type SshTarget,
	scanHostKey,
	sshArguments,
} from "./ssh.ts";
