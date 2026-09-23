import { AuthStorage } from "../../src/core/auth-storage.ts";

const path = process.argv[2];
if (!path) throw new Error("Expected an auth file path");
process.on("SIGXFSZ", () => {});

try {
	await AuthStorage.create(path).modify("anthropic", async () => ({
		type: "api_key",
		key: "x".repeat(16_384),
	}));
	console.log(JSON.stringify({ success: true }));
} catch (error) {
	console.log(JSON.stringify({ success: false, error: String(error) }));
}
