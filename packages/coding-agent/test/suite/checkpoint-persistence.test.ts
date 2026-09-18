import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { FileModelsStore } from "../../src/core/models-store.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const directories: string[] = [];
const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it.each(["catalog", "credential"])(
	"joins real native %s file persistence before a positive receipt and invalidates before later work",
	async (kind) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-files-"));
		directories.push(directory);
		const h = await createHarness();
		harnesses.push(h);
		const credentials = AuthStorage.create(join(directory, "auth.json"));
		const store = new FileModelsStore(join(directory, "models-store.json"));
		const model = h.getModel();
		await credentials.modify(model.provider, async () => ({ type: "api_key", key: "initial-faux-key" }));
		const runtime = await ModelRuntime.create({
			credentials,
			modelsStore: store,
			modelsPath: null,
			refreshOnCreate: false,
		});
		const provider = h.session.modelRuntime.getProvider(model.provider)!;
		runtime.registerNativeProvider({
			...provider,
			auth: {
				apiKey: {
					name: "Faux auth",
					login: async () => ({ type: "api_key", key: "saved-faux-key" }),
					resolve: async () => ({ auth: { apiKey: "faux-key" } }),
				},
			},
			refreshModels: async (context) => {
				if (context.allowNetwork) await context.publish({ persist: { models: [model], checkedAt: 123 } });
			},
		});
		await runtime.flushForCheckpoint();
		const { session } = await createAgentSession({
			modelRuntime: runtime,
			model,
			settingsManager: h.settingsManager,
			resourceLoader: h.session.resourceLoader,
			sessionManager: SessionManager.create(directory, join(directory, "sessions")),
		});
		sessions.push(session);
		const entered = deferred();
		const finish = deferred();
		if (kind === "catalog") {
			const write = store.write.bind(store);
			vi.spyOn(store, "write").mockImplementation(async (...args) => {
				entered.resolve();
				await finish.promise;
				await write(...args);
			});
		} else {
			const modify = credentials.modify.bind(credentials);
			vi.spyOn(credentials, "modify").mockImplementation(async (...args) => {
				entered.resolve();
				await finish.promise;
				return modify(...args);
			});
		}
		const work =
			kind === "catalog"
				? runtime.refresh({ providers: [model.provider], allowNetwork: true })
				: runtime.login(model.provider, "api_key", { prompt: async () => "faux", notify: () => {} });
		await entered.promise;
		let published = false;
		const pending = session.acquireCheckpoint({ quiesce: () => () => {} }).then((hold) => {
			published = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(published).toBe(false);
		finish.resolve();
		await work;
		const hold = await pending;
		expect(hold.sleepReady).toBe(true);
		const contents = JSON.parse(
			readFileSync(join(directory, kind === "catalog" ? "models-store.json" : "auth.json"), "utf8"),
		);
		expect(contents[model.provider]).toMatchObject(
			kind === "catalog" ? { checkedAt: 123 } : { key: "saved-faux-key" },
		);
		const later = runtime.refresh({ providers: [model.provider], allowNetwork: false });
		expect(hold.signal.aborted).toBe(true);
		await later;
	},
);
