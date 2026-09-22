import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Anchor an I/O address without erasing native traversal or directory requirements. */
export function resolveLocalOperationPath(cwd: string, path: string): string {
	let input = path;
	if (input === "~") input = homedir();
	else if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
		input = `${homedir()}${sep}${input.slice(2)}`;
	} else if (input.startsWith("file://")) {
		try {
			input = fileURLToPath(input);
		} catch {
			// Malformed URLs remain ordinary paths, matching the filesystem's Result contract.
		}
	}
	if (process.platform === "win32") {
		// Device paths already express native extended-path semantics.
		if (input.startsWith("\\\\?\\") || input.startsWith("\\\\.\\")) return input;
		const absolute = resolve(cwd, input);
		return /[\\/]$/.test(input) && !absolute.endsWith(sep) ? absolute + sep : absolute;
	}
	const base = isAbsolute(cwd) ? cwd : `${process.cwd()}${sep}${cwd}`;
	return isAbsolute(input) ? input : `${base.endsWith(sep) ? base : base + sep}${input}`;
}
