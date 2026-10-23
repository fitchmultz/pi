import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliModel, resolveModelScope, selectScopedInitialModel } from "../../src/core/model-resolver.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

// fitchmultz/pi#241: explain why the effective registry excludes a saved or selected model.
const HIDDEN = "claude-sonnet-4-5";
const SCOPED = "claude-opus-4-8";

describe("model unavailability diagnostics", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
	});

	async function saveState(h: Harness, model: { provider: string; id: string }) {
		const hold = await h.session.acquireWorkingSession();
		await hold.release();
		const path = join(h.tempDir, "state.json");
		writeFileSync(path, JSON.stringify({ ...hold.state, model }));
		return { path, contents: readFileSync(path, "utf8") };
	}

	it("refuses a saved model hidden by models.json and names the override", async () => {
		const h = await createHarness({
			modelsJson: { providers: { anthropic: { modelOverrides: { [HIDDEN]: { hidden: true } } } } },
		});
		harnesses.push(h);
		expect(getBuiltinModels("anthropic").some((model) => model.id === HIDDEN)).toBe(true);
		const saved = await saveState(h, { provider: "anthropic", id: HIDDEN });

		await expect(
			createAgentSession({
				workingSession: saved.path,
				resourceLoader: h.session.resourceLoader,
				modelRuntime: h.session.modelRuntime,
			}),
		).rejects.toThrow(
			`Saved model anthropic/${HIDDEN} is not registered (built-in catalog: present; effective registry: absent; cause: models.json (${join(h.tempDir, "models.json")}) sets providers["anthropic"].modelOverrides["${HIDDEN}"].hidden to true)`,
		);
		// Strict refusal: no session, no substitute model, and the saved state is untouched.
		expect(readFileSync(saved.path, "utf8")).toBe(saved.contents);
	});

	it("explains a hidden saved default while keeping the existing startup fallback", async () => {
		const h = await createHarness({
			modelsJson: { providers: { anthropic: { modelOverrides: { [HIDDEN]: { hidden: true } } } } },
		});
		harnesses.push(h);
		const settingsManager = SettingsManager.inMemory({ defaultProvider: "anthropic", defaultModel: HIDDEN });
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			settingsManager,
			sessionManager: SessionManager.inMemory(h.tempDir),
			resourceLoader: h.session.resourceLoader,
			modelRuntime: h.session.modelRuntime,
		});
		try {
			const fallback = h.getModel();
			expect(session.model).toMatchObject({ provider: fallback.provider, id: fallback.id });
			expect(modelFallbackMessage).toBe(
				`Could not use saved default model anthropic/${HIDDEN} (built-in catalog: present; effective registry: absent; cause: models.json (${join(h.tempDir, "models.json")}) sets providers["anthropic"].modelOverrides["${HIDDEN}"].hidden to true). Using ${fallback.provider}/${fallback.id}`,
			);
			expect(settingsManager.getDefaultModel()).toBe(HIDDEN);
		} finally {
			session.dispose();
		}
	});

	it("refuses a saved model whose provider is not registered", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const saved = await saveState(h, { provider: "departed", id: "model-1" });

		await expect(
			createAgentSession({
				workingSession: saved.path,
				resourceLoader: h.session.resourceLoader,
				modelRuntime: h.session.modelRuntime,
			}),
		).rejects.toThrow(
			'Saved model departed/model-1 is not registered (built-in catalog: absent; effective registry: absent; cause: provider "departed" is not registered)',
		);
		expect(readFileSync(saved.path, "utf8")).toBe(saved.contents);
	});

	it("names the hidden override when models.json re-adds a model a native provider omits", async () => {
		const h = await createHarness({
			modelsJson: {
				providers: {
					anthropic: {
						baseUrl: "https://api.anthropic.com",
						models: [{ id: HIDDEN }],
						modelOverrides: { [HIDDEN]: { hidden: true } },
					},
				},
			},
		});
		harnesses.push(h);
		const runtime = h.session.modelRuntime;
		const builtin = runtime.getProvider("anthropic")!;
		runtime.registerNativeProvider({
			...builtin,
			getModels: () => builtin.getModels().filter((model) => model.id !== HIDDEN),
		});
		expect(runtime.explainModelUnavailability("anthropic", HIDDEN).cause).toEqual({
			kind: "models-json-hidden",
			modelsPath: join(h.tempDir, "models.json"),
		});
	});

	it("reports missing credentials, extension model replacement and unidentified causes", async () => {
		// models.json supplies a model that the harness's extension registration then replaces. Its
		// hidden flag never sees the model, so the extension is the excluding layer.
		const h = await createHarness({
			provider: "override",
			modelsJson: {
				providers: {
					override: {
						api: "openai-completions",
						baseUrl: "http://localhost:1",
						models: [{ id: "json-model" }],
						modelOverrides: { "json-model": { hidden: true } },
					},
				},
			},
		});
		harnesses.push(h);
		const runtime = h.session.modelRuntime;

		expect(runtime.explainModelUnavailability("anthropic", SCOPED)).toMatchObject({
			inCatalog: true,
			inRegistry: true,
			cause: { kind: "provider-unavailable" },
			explanation:
				'built-in catalog: present; effective registry: present; cause: provider "anthropic" has no configured credentials',
		});
		expect(runtime.explainModelUnavailability("override", "json-model").cause).toEqual({
			kind: "model-override",
			detail: 'an extension registration for provider "override" replaced its models without this model',
		});
		// A model no layer ever supplied is not attributed to the extension.
		expect(runtime.explainModelUnavailability("override", "never-listed").cause).toEqual({ kind: "unknown" });
		// A failed credential check keeps scope candidates, so enabledModels is the reported exclusion.
		const [scoped] = runtime.getModels("anthropic");
		expect(scoped).toBeDefined();
		const allowlist = { source: "enabledModels", patterns: [`anthropic/${scoped!.id}`], models: [scoped!] };
		const failedCheck = Object.assign(Object.create(runtime), {
			getAuthCheckError: () => new Error("token expired"),
		}) as typeof runtime;
		expect(failedCheck.explainModelUnavailability("anthropic", SCOPED, allowlist).cause).toMatchObject({
			kind: "allowlist",
		});
		expect(failedCheck.explainModelUnavailability("anthropic", SCOPED).cause).toEqual({
			kind: "provider-unavailable",
			detail: 'credential check for provider "anthropic" failed: token expired',
		});
		expect(runtime.explainModelUnavailability("anthropic", "no-such-model").explanation).toBe(
			"built-in catalog: absent; effective registry: absent; cause: unknown; the responsible configuration layer could not be identified",
		);
	});

	it("explains a saved default excluded by enabledModels without changing the scoped selection", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const runtime = h.session.modelRuntime;
		await runtime.setRuntimeApiKey("anthropic", "test-key");
		const patterns = [`anthropic/${SCOPED}`];
		const scopedModels = await resolveModelScope(patterns, runtime);
		const select = (savedScope?: { source: string; patterns: string[] }) =>
			selectScopedInitialModel({
				scopedModels,
				defaultProvider: "anthropic",
				defaultModelId: HIDDEN,
				savedScope,
				modelRuntime: runtime,
			});

		const fromSettings = select({ source: "enabledModels", patterns });
		expect(fromSettings.scopedModel).toBe(scopedModels[0]);
		expect(fromSettings.warning).toBe(
			`Could not use saved default model anthropic/${HIDDEN} (built-in catalog: present; effective registry: present; cause: enabledModels excludes it (anthropic/${SCOPED})). Using anthropic/${SCOPED}.`,
		);
		// --models is an explicit per-run scope, so the same selection is silent.
		expect(select()).toEqual({ scopedModel: scopedModels[0] });
	});

	it("explains explicitly selected hidden models while keeping existing CLI resolution", async () => {
		const h = await createHarness({
			modelsJson: {
				providers: { anthropic: { modelOverrides: { [HIDDEN]: { hidden: true }, [SCOPED]: { hidden: true } } } },
			},
		});
		harnesses.push(h);
		const runtime = h.session.modelRuntime;
		const reason = (id: string) =>
			`anthropic/${id}: built-in catalog: present; effective registry: absent; cause: models.json (${join(h.tempDir, "models.json")}) sets providers["anthropic"].modelOverrides["${id}"].hidden to true`;

		// Fuzzy matching still selects the dated sibling; the warning now says why.
		const sibling = resolveCliModel({ cliModel: `anthropic/${HIDDEN}`, modelRuntime: runtime });
		expect(sibling.model).toMatchObject({ provider: "anthropic", id: `${HIDDEN}-20250929` });
		expect(sibling.warning).toBe(
			`Using anthropic/${HIDDEN}-20250929 for "anthropic/${HIDDEN}" because the named model is unavailable (${reason(HIDDEN)}).`,
		);

		// Without a sibling, the explicit id is kept as a custom model id rather than replaced.
		const custom = resolveCliModel({ cliModel: `anthropic/${SCOPED}`, modelRuntime: runtime });
		expect(custom.model).toMatchObject({ provider: "anthropic", id: SCOPED });
		expect(custom.warning).toBe(
			`Model "${SCOPED}" not found for provider "anthropic" (${reason(SCOPED)}). Using custom model id.`,
		);

		const bare = resolveCliModel({ cliModel: SCOPED, modelRuntime: runtime });
		expect(bare.model).toBeUndefined();
		expect(bare.error).toContain(`is ambiguous across providers`);
		expect(bare.error).toContain(`Unavailable: ${reason(SCOPED)}.`);
	});
});
