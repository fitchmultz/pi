import { runBackgroundCommandWorker } from "./jobs.ts";

await runBackgroundCommandWorker(process.argv[2]);
