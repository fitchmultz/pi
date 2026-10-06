import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function execNpmSync(args, options = {}) {
	const { node = process.execPath, npm, ...execOptions } = options;
	if (npm) {
		if (!existsSync(npm)) throw new Error(`Cannot locate the npm CLI: ${npm}`);
		return execFileSync(node, [npm, ...args], execOptions);
	}
	if (process.platform !== "win32") return execFileSync("npm", args, execOptions);
	const npmCli = process.env.npm_execpath;
	if (!npmCli) throw new Error("Cannot locate npm on Windows. Run this command through its npm script.");
	if (!existsSync(npmCli)) throw new Error(`Cannot locate the npm CLI: ${npmCli}`);
	return execFileSync(node, [npmCli, ...args], execOptions);
}
