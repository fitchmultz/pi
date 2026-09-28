import { startBackgroundCommand } from "../../src/core/background-command.ts";
import { getShellEnv } from "../../src/utils/shell.ts";

const [root, cwd, command] = process.argv.slice(2);
const job = await startBackgroundCommand(root, command, { command, cwd, env: getShellEnv() });
console.log(job.id);
