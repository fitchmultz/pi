import { runBackgroundCommandWorker } from "./core/background-command.ts";

await runBackgroundCommandWorker(process.argv[2]);
