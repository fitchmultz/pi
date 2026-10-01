import type { AssistantMessage, OAuthCredential } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("provider credential isolation (#146)", () => {
	it.each(["api_key", "oauth"] as const)(
		"isolates stored %s credentials throughout refresh and streaming",
		async (type) => {
			const saved: OAuthCredential = { type: "oauth", access: "standalone", refresh: "revoked", expires: 0 };
			const credentials = AuthStorage.inMemory(
				type === "oauth" ? { "openai-codex": saved } : { "openai-codex": { type: "api_key", key: "standalone" } },
			);
			const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
			const refreshToken = vi.fn(async () => {
				throw new Error("revoked standalone login");
			});
			const seen: string[] = [];
			runtime.registerProvider("openai-codex", {
				ignoreStoredCredentials: true,
				apiKey: "routing-placeholder",
				api: "openai-codex-responses",
				oauth: {
					name: "Offline login",
					login: async () => ({ access: "new", refresh: "new", expires: Date.now() + 3600000 }),
					refreshToken,
					getApiKey: (credential) => credential.access,
				},
				streamSimple(model, _context, options) {
					seen.push(options?.apiKey ?? "");
					const message: AssistantMessage = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: 0,
						content: [],
						stopReason: "stop",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					const stream = new AssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
					return stream;
				},
			});
			const result = await runtime.refresh({ allowNetwork: false, providers: ["openai-codex"] });
			expect(result.errors.size).toBe(0);
			expect(refreshToken).not.toHaveBeenCalled();
			expect(runtime.getProviderAuthStatus("openai-codex").source).toBe("fallback");
			expect(runtime.isUsingOAuth("openai-codex")).toBe(false);
			const model = runtime.getModels("openai-codex")[0];
			expect(model).toBeDefined();
			expect((await runtime.getAvailable("openai-codex")).length).toBeGreaterThan(0);
			await runtime.completeSimple(model, { messages: [] });
			await runtime.completeSimple(model, { messages: [] }, { apiKey: "request-key" });
			await runtime.setRuntimeApiKey("openai-codex", "cli-key");
			await runtime.completeSimple(model, { messages: [] });
			expect(seen).toEqual(["routing-placeholder", "request-key", "cli-key"]);
			expect(await credentials.read("openai-codex")).toEqual(
				type === "oauth" ? saved : { type: "api_key", key: "standalone" },
			);
			await runtime.removeRuntimeApiKey("openai-codex");
			await runtime.login("openai-codex", "oauth", { prompt: async () => "unused", notify: () => {} });
			expect(await credentials.read("openai-codex")).toMatchObject({ type: "oauth", access: "new" });
			expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("routing-placeholder");
			runtime.registerProvider("openai-codex", { ignoreStoredCredentials: false });
			await runtime.refresh({ allowNetwork: false, providers: ["openai-codex"] });
			expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("new");
			await runtime.logout("openai-codex");
			expect(await credentials.read("openai-codex")).toBeUndefined();
		},
	);
});
