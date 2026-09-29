import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const storedOAuth = {
	type: "oauth" as const,
	access: "standalone-access",
	refresh: "standalone-refresh",
	expires: 0,
};

describe("provider credential isolation", () => {
	let directory: string;
	let credentials: AuthStorage;
	let runtime: ModelRuntime;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-credential-isolation-"));
		vi.stubEnv("HOME", directory);
		vi.stubEnv("USERPROFILE", directory);
		for (const name of Object.keys(process.env)) {
			if (/KEY|TOKEN|SECRET|^AWS_|^GOOGLE_|^AZURE_|^CLOUDFLARE_/.test(name)) vi.stubEnv(name, undefined);
		}
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
		credentials = AuthStorage.inMemory({ "openai-codex": storedOAuth });
		runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	});

	afterEach(async () => {
		await runtime.flushForCheckpoint();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	it.each<Credential>([
		storedOAuth,
		{ ...storedOAuth, expires: Date.now() + 3_600_000 },
		{ type: "api_key", key: "standalone-key" },
	])("uses configured auth without reading or refreshing stored $type credentials", async (stored) => {
		await credentials.modify("openai-codex", async () => stored);
		const read = vi.spyOn(credentials, "read");
		const modify = vi.spyOn(credentials, "modify");
		const nativeLogin = runtime.getProvider("openai-codex")!.auth.oauth!.login;
		runtime.registerProvider("openai-codex", { apiKey: "router-key", ignoreStoredCredentials: true });
		await runtime.refresh({ allowNetwork: false });
		expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("router-key");
		expect(await runtime.checkAuth("openai-codex")).toMatchObject({ type: "api_key" });
		expect(runtime.getProviderAuthStatus("openai-codex")).toEqual({ configured: true, source: "fallback" });
		expect(await runtime.getAvailable("openai-codex")).toEqual(runtime.getModels("openai-codex"));
		expect(runtime.getProvider("openai-codex")!.auth.oauth!.login).toBe(nativeLogin);
		expect(await runtime.listCredentials()).toContainEqual({ providerId: "openai-codex", type: stored.type });
		expect(read.mock.calls.some(([id]) => id === "openai-codex")).toBe(false);
		expect(modify).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();

		// Catalog refresh also resolves credentials, independently of request preflight.
		vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
			expect(String(url)).toBe("https://pi.dev/api/models/providers/openai-codex?types=chat%2Cimage%2Cclassifier");
			return new Response(JSON.stringify({ models: [] }), {
				headers: { "last-modified": new Date(Date.now() + 60_000).toUTCString() },
			});
		});
		const result = await runtime.refresh({ providers: ["openai-codex"], allowNetwork: true, force: true });
		expect(result.errors.size).toBe(0);
		expect(modify).not.toHaveBeenCalled();
		expect(await credentials.read("openai-codex")).toEqual(stored);
	});

	it("preserves request/CLI keys and restores stored auth when disabled or unregistered", async () => {
		runtime.registerProvider("openai-codex", { apiKey: "router-key", ignoreStoredCredentials: true });
		await runtime.setRuntimeApiKey("openai-codex", "cli-key");
		await expect(runtime.setRuntimeApiKey("openai-codex", "")).rejects.toThrow("must not be empty");
		expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("cli-key");
		expect(runtime.getProviderAuthStatus("openai-codex")).toEqual({ configured: true, source: "runtime" });
		expect((await runtime.getAuth("openai-codex", { apiKey: "request-key" }))?.auth.apiKey).toBe("request-key");
		await runtime.removeRuntimeApiKey("openai-codex");
		expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("router-key");
		expect(globalThis.fetch).not.toHaveBeenCalled();

		vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Revoked standalone grant", { status: 400 }));
		runtime.registerProvider("openai-codex", { ignoreStoredCredentials: false });
		await expect(runtime.getAuth("openai-codex")).rejects.toThrow("OAuth refresh failed");
		runtime.registerProvider("openai-codex", { ignoreStoredCredentials: true });
		expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("router-key");
		runtime.unregisterProvider("openai-codex");
		await expect(runtime.getAuth("openai-codex")).rejects.toThrow("OAuth refresh failed");
		expect(await credentials.read("openai-codex")).toEqual(storedOAuth);
	});

	it("allows ambient account auth only while the registration opts out of stored credentials", async () => {
		const resolve = vi.fn(async () => ({ auth: { apiKey: "slot-key" }, source: "rotation slot" }));
		runtime.registerProvider("openai-codex", {
			ignoreStoredCredentials: true,
			ambientAuth: {
				check: async () => ({ type: "oauth", source: "rotation slot" }),
				resolve,
			},
		});
		await runtime.refresh({ allowNetwork: false });
		expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("slot-key");
		expect(runtime.getProviderAuthStatus("openai-codex")).toEqual({
			configured: true,
			source: "environment",
			label: "rotation slot",
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
		runtime.registerProvider("openai-codex", { ignoreStoredCredentials: false });
		await expect(runtime.getAuth("openai-codex")).rejects.toThrow("OAuth refresh failed");
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(await credentials.read("openai-codex")).toEqual(storedOAuth);
	});

	it("keeps isolation local to the registration and still permits deliberate login/logout", async () => {
		const standalone = await ModelRuntime.create({ credentials, modelsPath: null });
		const fresh = { ...storedOAuth, access: "new-standalone-access", expires: Date.now() + 3_600_000 };
		runtime.registerProvider("openai-codex", {
			apiKey: "router-key",
			ignoreStoredCredentials: true,
			oauth: {
				name: "Test login",
				login: async () => fresh,
				refreshToken: async () => {
					throw new Error("Must not refresh stored credential");
				},
				getApiKey: (credential) => credential.access,
			},
		});
		await runtime.login("openai-codex", "oauth", { prompt: async () => "unused", notify: () => {} });
		expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("router-key");
		expect((await standalone.getAuth("openai-codex"))?.auth.apiKey).toBe(fresh.access);
		expect(await credentials.read("openai-codex")).toEqual(fresh);
		await runtime.logout("openai-codex");
		expect(await credentials.read("openai-codex")).toBeUndefined();
		expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("router-key");
		expect(await standalone.getAuth("openai-codex")).toBeUndefined();
		await standalone.flushForCheckpoint();
	});
});
