import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		reporters: ["verbose"],
		benchmark: {
			include: ["test/**/*.bench.ts"],
		},
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
