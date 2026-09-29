import { expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { fauxProvider } from "../src/providers/faux.ts";

it("isolates provider checks with one non-secret observation and credential read per provider", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("broken", async () => ({ type: "api_key", key: "not-an-observation" }));
	const read = vi.spyOn(credentials, "read");
	const models = createModels({ credentials });
	for (const id of ["working", "broken", "missing"]) {
		const { provider } = fauxProvider({ provider: id });
		const auth = {
			apiKey: {
				name: id,
				resolve: vi.fn(async () => {
					if (id === "broken") throw new Error("provider failure");
					return id === "missing" ? undefined : { auth: {}, source: "ambient" };
				}),
			},
		};
		models.setProvider({ ...provider, auth });
	}
	const onAuthResult = vi.fn();
	expect((await models.getAvailable(undefined, { onAuthResult })).map((model) => model.provider)).toEqual(["working"]);
	expect(read).toHaveBeenCalledTimes(3);
	expect(onAuthResult).toHaveBeenCalledTimes(3);
	expect(onAuthResult).toHaveBeenCalledWith("broken", { stored: true, auth: undefined, error: expect.any(Error) });
	expect(onAuthResult).toHaveBeenCalledWith("missing", { stored: false, auth: undefined, error: undefined });
	expect(onAuthResult).toHaveBeenCalledWith("working", {
		stored: false,
		auth: { source: "ambient", type: "api_key" },
		error: undefined,
	});
	read.mockRejectedValueOnce(new Error("storage failure"));
	await expect(models.getAvailable()).rejects.toThrow("Credential store read failed");
});

it("settles an aborted stream while auth is pending and never starts the late provider", async () => {
	const models = createModels();
	const faux = fauxProvider();
	let release!: () => void;
	const auth = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = vi.fn();
	const providerAuth = {
		apiKey: {
			name: "pending",
			resolve: async () => {
				entered();
				await auth;
				return { auth: {} };
			},
		},
	};
	models.setProvider({ ...faux.provider, auth: providerAuth });
	const controller = new AbortController();
	const result = models.streamSimple(faux.getModel(), { messages: [] }, { signal: controller.signal }).result();
	await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
	controller.abort(new Error("cancelled"));
	expect((await result).stopReason).toBe("aborted");
	release();
	await auth;
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(faux.state.callCount).toBe(0);
});
