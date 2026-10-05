import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, type ConnectionOptions } from "./connection.ts";

/** A remote system the package ships a daemon for. */
export type RemotePlatform = {
	platform: "linux" | "android" | "darwin" | "windows";
	arch: "x64" | "arm64";
	/** The remote home directory, in the remote system's own spelling. */
	home: string;
};

/** How to reach a machine with the system `ssh`. */
export interface SshTarget {
	/** Host name or `~/.ssh/config` alias. */
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/** Host keys this application trusts; `acceptHostKey` adds to it. */
	knownHostsFile: string;
	/** The name keys are stored under, independent of aliases, ports and jump hosts, e.g. `pi-env-<env name>`. */
	hostKeyAlias: string;
	/** The `ssh` program; default `ssh`. */
	ssh?: string;
	/** An `ssh` configuration file instead of `~/.ssh/config` (`-F`). */
	configFile?: string;
}

/** The remote host's key is not in `knownHostsFile`; `scanHostKey` shows it so the owner can accept it. */
export class HostKeyUnknownError extends Error {}

/** The remote host's key differs from the one in `knownHostsFile`; it is never accepted automatically. */
export class HostKeyChangedError extends Error {}

/** An `ssh` invocation that failed for another reason, with its exit code and diagnostics. */
export class SshError extends Error {
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(message: string, exitCode: number | null, stderr: string) {
		super(message);
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const VERSION = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;

/** No leading `-` (it would be read as an `ssh` option) and no whitespace or control characters. */
function checkField(name: string, value: string): void {
	if (value === "" || value.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(value)) {
		throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
	}
}

/**
 * Arguments for `ssh` up to the host: no prompts, no forwarding, no locale forwarding (the remote uses its own), and
 * host keys checked strictly against the application's own file under a fixed alias.
 */
export function sshArguments(
	target: SshTarget,
	strictHostKeys = true,
	knownHostsFile = target.knownHostsFile,
): string[] {
	checkField("host", target.host);
	checkField("host key alias", target.hostKeyAlias);
	if (target.user !== undefined) checkField("user", target.user);
	if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) {
		throw new Error(`Invalid port: ${target.port}`);
	}
	return [
		...(target.configFile === undefined ? [] : ["-F", target.configFile]),
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"ClearAllForwardings=yes",
		"-o",
		"SendEnv=-*",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		`StrictHostKeyChecking=${strictHostKeys ? "yes" : "accept-new"}`,
		"-o",
		`UserKnownHostsFile=${knownHostsFile}`,
		"-o",
		`HostKeyAlias=${target.hostKeyAlias}`,
		...(target.user === undefined ? [] : ["-l", target.user]),
		...(target.port === undefined ? [] : ["-p", String(target.port)]),
		...(target.identityFile === undefined ? [] : ["-i", target.identityFile, "-o", "IdentitiesOnly=yes"]),
		"--",
		target.host,
	];
}

/** Run one remote command over `ssh`, optionally feeding stdin; resolves with stdout, rejects on failure. */
function runSsh(
	target: SshTarget,
	command: string,
	options: { stdin?: Uint8Array; args?: string[] } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = options.args ?? sshArguments(target);
		const child = spawn(target.ssh ?? "ssh", [...args, command], { stdio: ["pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.stdin.on("error", () => {});
		child.on("error", (error) => reject(new SshError(error.message, null, "")));
		child.on("close", (code) => {
			const output = Buffer.concat(stdout).toString("utf8");
			const diagnostics = Buffer.concat(stderr).toString("utf8");
			if (code === 0) return resolve(output);
			if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(diagnostics)) {
				return reject(
					new HostKeyChangedError(`The host key of ${target.host} changed; remove the old key to continue`),
				);
			}
			if (/Host key verification failed|No .* host key is known/.test(diagnostics)) {
				return reject(new HostKeyUnknownError(`The host key of ${target.host} is not trusted yet`));
			}
			reject(
				new SshError(`ssh ${target.host} failed with exit code ${code}: ${diagnostics.trim()}`, code, diagnostics),
			);
		});
		child.stdin.end(options.stdin ?? new Uint8Array(0));
	});
}

/**
 * Connect once with `accept-new` against a temporary known-hosts file to capture the key the host presents, through
 * the same route (`~/.ssh/config`, jump hosts) as real connections. Returns its known-hosts lines and fingerprints.
 * Showing a fingerprint is not authentication: compare it with one obtained out of band before accepting it.
 */
export async function scanHostKey(target: SshTarget): Promise<{ lines: string[]; fingerprints: string[] }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-env-hostkey-"));
	try {
		const scanned = join(directory, "known_hosts");
		// Authentication may fail without the key; the key is recorded before authentication.
		await runSsh(target, "exit 0", { args: sshArguments(target, false, scanned) }).catch((error: unknown) => {
			if (!(error instanceof SshError) && !(error instanceof HostKeyUnknownError)) throw error;
		});
		const lines = existsSync(scanned)
			? (await readFile(scanned, "utf8")).split("\n").filter((line) => line.trim() !== "")
			: [];
		if (lines.length === 0) throw new Error(`No host key received from ${target.host}`);
		const fingerprints = await new Promise<string[]>((resolve, reject) => {
			const child = spawn("ssh-keygen", ["-lf", scanned], { stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString("utf8");
			});
			child.on("error", reject);
			child.on("close", () => resolve(output.split("\n").filter((line) => line.trim() !== "")));
		});
		return { lines, fingerprints };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Trust host-key lines from `scanHostKey` by adding them to the target's known-hosts file. */
export async function acceptHostKey(target: SshTarget, lines: readonly string[]): Promise<void> {
	await mkdir(dirname(target.knownHostsFile), { recursive: true, mode: 0o700 });
	const existing = existsSync(target.knownHostsFile) ? await readFile(target.knownHostsFile, "utf8") : "";
	const known = new Set(existing.split("\n"));
	const added = lines.filter((line) => !known.has(line));
	if (added.length > 0) {
		const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
		await appendFile(target.knownHostsFile, `${prefix}${added.join("\n")}\n`, { mode: 0o600 });
	}
}

/** POSIX detection, run by the remote login shell; a Windows host answers through PowerShell instead. */
const POSIX_PROBE = `sh -c 'echo PI-ENV-PROBE; uname -s; uname -m; uname -o 2>/dev/null || echo -; printf "%s\\n" "$HOME"'`;

function powershell(script: string): string {
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

const WINDOWS_PROBE = powershell(
	"'PI-ENV-PROBE'; 'Windows'; [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); '-'; $HOME",
);

function normalizeArch(machine: string): RemotePlatform["arch"] {
	const lower = machine.toLowerCase();
	if (lower === "x86_64" || lower === "amd64" || lower === "x64") return "x64";
	if (lower === "aarch64" || lower === "arm64") return "arm64";
	throw new Error(`Unsupported remote architecture: ${machine}`);
}

function parseProbe(target: SshTarget, output: string): { system: string; machine: string; os: string; home: string } {
	// Login shells may print a banner first.
	const lines = output.split(/\r?\n/);
	const start = lines.indexOf("PI-ENV-PROBE");
	if (start === -1) throw new Error(`Unexpected answer from ${target.host}: ${output.trim()}`);
	const [system = "", machine = "", os = "", home = ""] = lines.slice(start + 1);
	return { system, machine, os, home };
}

/** Which system the target runs: `uname` through the login shell, or PowerShell on Windows. */
export async function detectPlatform(target: SshTarget): Promise<RemotePlatform> {
	let output: string;
	try {
		output = await runSsh(target, POSIX_PROBE);
	} catch (error) {
		// cmd.exe or PowerShell as the remote shell: no `sh`.
		if (!(error instanceof SshError)) throw error;
		output = await runSsh(target, WINDOWS_PROBE);
	}
	let answer = parseProbe(target, output);
	// Git Bash as Windows' default SSH shell: ask PowerShell for Windows' own architecture and home spelling.
	if (/^(MINGW|MSYS|CYGWIN)/.test(answer.system)) answer = parseProbe(target, await runSsh(target, WINDOWS_PROBE));
	const { system, os, home } = answer;
	const arch = normalizeArch(answer.machine);
	if (system === "Windows") return { platform: "windows", arch, home };
	if (system === "Darwin") return { platform: "darwin", arch, home };
	if (system === "Linux") return { platform: os === "Android" ? "android" : "linux", arch, home };
	throw new Error(`Unsupported remote system: ${system}`);
}

/** The daemon binary this package ships for a remote system. */
export function packagedDaemon(remote: Pick<RemotePlatform, "platform" | "arch">): string {
	const name = `pi-env-${remote.platform}-${remote.arch}`;
	return join(packageRoot, "bin", name, remote.platform === "windows" ? "pi-env.exe" : "pi-env");
}

function quotePosix(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Make sure the daemon of this package's version is on the remote machine, verified by its SHA-256 before it ever
 * runs: an existing file with another hash is replaced. Returns the remote path of the binary.
 */
export async function deployDaemon(
	target: SshTarget,
	remote: RemotePlatform,
	binary = packagedDaemon(remote),
): Promise<string> {
	if (!existsSync(binary)) throw new Error(`No pi-env daemon for ${remote.platform}-${remote.arch} at ${binary}`);
	const bytes = await readFile(binary);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (remote.platform === "windows") {
		const file = `${remote.home}\\.pi\\mobile\\tools\\pi-env-${VERSION}.exe`;
		const literal = `'${file.replaceAll("'", "''")}'`;
		const check = powershell(
			`$f = ${literal}; if ((Test-Path -LiteralPath $f) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() -eq '${sha256}')) { 'present' } else { 'missing' }`,
		);
		if ((await runSsh(target, check)).trim().endsWith("present")) return file;
		const upload = powershell(
			[
				"$ErrorActionPreference = 'Stop'",
				`$f = ${literal}`,
				"$d = Split-Path -Parent $f",
				"New-Item -ItemType Directory -Force -Path $d | Out-Null",
				"$t = Join-Path $d ('.pi-env-' + [guid]::NewGuid().ToString() + '.tmp')",
				"$in = [Console]::OpenStandardInput(); $out = [IO.File]::Create($t); $in.CopyTo($out); $out.Close()",
				`if ((Get-FileHash -Algorithm SHA256 -LiteralPath $t).Hash.ToLower() -ne '${sha256}') { Remove-Item -LiteralPath $t; throw 'pi-env upload is corrupt' }`,
				// A running daemon or a virus scanner can hold the old file for a moment.
				"for ($i = 0; ; $i++) { try { Move-Item -Force -LiteralPath $t -Destination $f; break } catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 250 } }",
				"'deployed'",
			].join("; "),
		);
		await runSsh(target, upload, { stdin: bytes });
		return file;
	}
	const file = `${remote.home}/.pi/mobile/tools/pi-env-${VERSION}`;
	const hash = `hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= //'; else echo none; fi; }`;
	const check = `${hash}; f=${quotePosix(file)}; if [ -f "$f" ] && [ "$(hash "$f")" = ${sha256} ]; then echo present; elif [ "$(hash /dev/null)" = none ]; then echo nohash; else echo missing; fi`;
	const state = (await runSsh(target, `sh -c ${quotePosix(check)}`)).trim().split("\n").at(-1);
	if (state === "present") return file;
	if (state === "nohash") throw new Error(`${target.host} has no sha256sum, shasum or openssl to verify pi-env`);
	const upload = [
		"set -e",
		hash,
		`f=${quotePosix(file)}`,
		'd=$(dirname "$f")',
		'mkdir -p "$d"',
		'chmod 700 "$d"',
		't=$(mktemp "$d/.pi-env.XXXXXX")',
		'cat > "$t"',
		`if [ "$(hash "$t")" != ${sha256} ]; then rm -f "$t"; echo "pi-env upload is corrupt" >&2; exit 1; fi`,
		'chmod 700 "$t"',
		'mv -f "$t" "$f"',
		"echo deployed",
	].join("\n");
	await runSsh(target, `sh -c ${quotePosix(upload)}`, { stdin: bytes });
	return file;
}

/** Options for `connectSsh`: the target, plus the binary to deploy (default: the one this package ships). */
export interface SshConnectOptions extends SshTarget {
	binary?: string;
	onLog?: ConnectionOptions["onLog"];
}

/**
 * Detect the remote system, deploy the daemon if needed, and return a `Connection` that starts it over `ssh`. Host
 * keys must already be trusted (`scanHostKey`, `acceptHostKey`); otherwise this rejects with `HostKeyUnknownError`.
 */
export async function connectSsh(
	options: SshConnectOptions,
): Promise<{ connection: Connection; remote: RemotePlatform }> {
	const remote = await detectPlatform(options);
	const file = await deployDaemon(options, remote, options.binary ?? packagedDaemon(remote));
	// cmd.exe, Windows' default SSH shell, needs double quotes; POSIX shells get single quotes.
	const program = remote.platform === "windows" ? (file.includes(" ") ? `"${file}"` : file) : quotePosix(file);
	const connection = new Connection({
		command: [options.ssh ?? "ssh", ...sshArguments(options), program],
		...(options.onLog === undefined ? {} : { onLog: options.onLog }),
	});
	return { connection, remote };
}
