import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const context = {
	state: { text: "Looks good" },
	questions: {
		approved: {
			type: "bool" as const,
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

const image = { type: "image" as const, data: "cG5n", mimeType: "image/png" };

describe("ModelRuntime classifiers", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createRuntime(modelsJson?: object): Promise<ModelRuntime> {
		let modelsPath: string | null = null;
		if (modelsJson) {
			const dir = mkdtempSync(join(tmpdir(), "pi-classifiers-"));
			tempDirs.push(dir);
			modelsPath = join(dir, "models.json");
			writeFileSync(modelsPath, JSON.stringify(modelsJson));
		}
		return ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
		});
	}

	/** Classifies one image and returns the request body and headers the service received. */
	async function captureImageRequest(runtime: ModelRuntime, provider: string, id: string) {
		await runtime.setRuntimeApiKey(provider, "secret");
		const model = runtime.getModelOfType("classifier", provider, id)!;
		const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
		const result = await runtime.classify(
			model,
			{ ...context, images: [image] },
			{
				fetch: async (input, init) => {
					requests.push({
						url: String(input),
						body: JSON.parse(String(init?.body)) as Record<string, unknown>,
						headers: new Headers(init?.headers),
					});
					return Response.json({ answers: { approved: { type: "noul", noul: 0.8 } } });
				},
			},
		);
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		return requests[0]!;
	}

	it("lists Jev separately and classifies with runtime-resolved auth", async () => {
		const runtime = await createRuntime();
		const jev = runtime.getModelOfType("classifier", "typesafe", "jev-latest")!;
		expect(jev.type).toBe("classifier");
		expect(runtime.getModel("typesafe", "jev-latest")).toBeUndefined();

		const unconfigured = await runtime.classify(jev, context);
		expect(unconfigured.stopReason).toBe("error");
		expect(unconfigured.errorMessage).toContain("not configured");

		await runtime.setRuntimeApiKey("typesafe", "sk-typesafe");
		expect(await runtime.getAvailableOfType("classifier", "typesafe")).toEqual([jev]);
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-typesafe");
			return Response.json({ answers: { approved: { type: "noul", noul: 0.8 } } });
		});
		const result = await runtime.classify(jev, context, { fetch });
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
	});

	it("keeps OpenRouter's image form when models.json routes OpenRouter through a proxy", async () => {
		const runtime = await createRuntime({ providers: { openrouter: { baseUrl: "https://proxy.example.com/v1" } } });

		const request = await captureImageRequest(runtime, "openrouter", "typesafe/jev-1.14");

		// OpenRouter answers TypeSafe `assets` with 200 but drops the images.
		expect(request.url).toBe("https://proxy.example.com/v1/systemone");
		expect(request.body.state).toEqual([
			{ type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } },
			context.state,
		]);
		expect(request.body).not.toHaveProperty("assets");
		expect(request.headers.has("typesafe-danger-zone-images")).toBe(false);
	});

	it("applies provider compat from models.json to classifier models", async () => {
		const runtime = await createRuntime({
			providers: {
				typesafe: {
					baseUrl: "https://proxy.example.com/v1",
					compat: { imageInput: "state-image-urls", sendImageOptInHeader: false },
				},
			},
		});

		const request = await captureImageRequest(runtime, "typesafe", "jev-latest");

		expect(request.url).toBe("https://proxy.example.com/v1/systemone");
		expect(request.body.state).toEqual([
			{ type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } },
			context.state,
		]);
		expect(request.headers.has("typesafe-danger-zone-images")).toBe(false);
	});

	it("sends classifierOverrides headers with that classifier only, not with the chat model of the same ID", async () => {
		vi.stubEnv("CLASSIFIER_MAX_ATTEMPTS", "1");
		// OpenAI lists GPT-6 Luna both as a Decisions classifier and as a chat model. The provider
		// entry sets nothing else, so classifierOverrides alone must configure it.
		const runtime = await createRuntime({
			providers: {
				openai: {
					classifierOverrides: {
						"gpt-6-luna": { headers: { "cf-aig-max-attempts": "$CLASSIFIER_MAX_ATTEMPTS" } },
					},
				},
			},
		});
		await runtime.setRuntimeApiKey("openai", "secret");

		let classifierHeaders: Headers | undefined;
		const result = await runtime.classify(runtime.getModelOfType("classifier", "openai", "gpt-6-luna")!, context, {
			fetch: async (input, init) => {
				classifierHeaders = new Request(input, init).headers;
				return Response.json({ answers: [{ name: "approved", type: "predicate", probability: 0.8 }] });
			},
		});
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
		expect(classifierHeaders?.get("cf-aig-max-attempts")).toBe("1");

		let chatHeaders: Headers | undefined;
		await runtime.complete(
			runtime.getModel("openai", "gpt-6-luna")!,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				fetch: async (input, init) => {
					chatHeaders = new Request(input, init).headers;
					return Response.json({ error: { message: "rejected" } }, { status: 401 });
				},
			},
		);
		expect(chatHeaders?.get("authorization")).toBe("Bearer secret");
		expect(chatHeaders?.has("cf-aig-max-attempts")).toBe(false);
	});
});
