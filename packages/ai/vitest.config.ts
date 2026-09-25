import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { offlineTestEnv } from "../../vitest.offline-env.ts";

const offlineSetup = fileURLToPath(new URL("../../vitest.offline-setup.ts", import.meta.url));

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		env: offlineTestEnv(),
		setupFiles: [offlineSetup],
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetrySrcIndex }],
	},
});