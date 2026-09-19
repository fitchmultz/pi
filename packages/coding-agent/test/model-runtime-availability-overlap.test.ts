import { type AuthCheck, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../src/core/extensions/types.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const healthy: AuthCheck = { type: "oauth", source: "shared account" };

type Check = NonNullable<ProviderConfig["ambientAuth"]>["check"];

describe("availability overlap barrier (PR #66)", () => {
	let runtime: ModelRuntime;
	let credentials: InMemoryCredentialStore;
	let anthropic: Check;
	let openai: Check;

	beforeEach(async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
		credentials = new InMemoryCredentialStore();
		runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		anthropic = async () => undefined;
		openai = async () => ({ type: "api_key", source: "shared OpenAI" });
		for (const provider of runtime.getProviders()) {
			runtime.registerProvider(provider.id, {
				ambientAuth: {
					check: (input) =>
						provider.id === "anthropic"
							? anthropic(input)
							: provider.id === "openai"
								? openai(input)
								: Promise.resolve(undefined),
					resolve: async () => {
						throw new Error("No request auth resolution allowed");
					},
				},
			});
		}
		await runtime.flushForCheckpoint();
	});

	afterEach(async () => {
		await runtime.flushForCheckpoint();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it.each(["healthy", "Anthropic failure", "OpenAI failure"])(
		"retains exact native default after aggregate/direct overlap: %s",
		async (variant) => {
			const entered = deferred();
			const release = deferred();
			anthropic = async () => {
				entered.resolve();
				await release.promise;
				if (variant === "Anthropic failure") throw new Error("Anthropic account unavailable");
				return healthy;
			};
			if (variant === "OpenAI failure")
				openai = async () => {
					throw new Error("OpenAI account unavailable");
				};
			const aggregate = runtime.getAvailable();
			await entered.promise;
			try {
				const direct = runtime.getAvailable("openai");
				if (variant === "OpenAI failure") await expect(direct).rejects.toThrow("OpenAI account unavailable");
				else expect(await direct).toEqual(runtime.getModels("openai"));
			} finally {
				release.resolve();
			}
			const available = await aggregate;
			await runtime.flushForCheckpoint();
			const selected = runtime.getModels("anthropic")[0];
			const result = await findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: selected.provider,
				defaultModelId: selected.id,
				modelRuntime: runtime,
			});
			expect(result.model).toEqual(selected);
			expect(available.filter((model) => model.provider === "anthropic")).toEqual(
				variant === "Anthropic failure" ? [] : runtime.getModels("anthropic"),
			);
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(variant !== "Anthropic failure");
			expect(runtime.isUsingSubscription("anthropic")).toBe(variant !== "Anthropic failure");
			expect(runtime.getAuthCheckError("anthropic")?.message).toBe(
				variant === "Anthropic failure"
					? "API key auth check failed for provider anthropic: Anthropic account unavailable"
					: undefined,
			);
			expect(runtime.getAuthCheckError("openai")?.message).toBe(
				variant === "OpenAI failure"
					? "API key auth check failed for provider openai: OpenAI account unavailable"
					: undefined,
			);
			expect(runtime.getAvailableSnapshot()).toEqual(available);
		},
	);

	it.each(["direct", "scoped", "full"])(
		"rechecks a discarded healthy pass after superseding %s cancellation and joins checkpoint",
		async (kind) => {
			anthropic = async () => healthy;
			await runtime.getAvailable();
			const oldEntered = deferred(),
				oldRelease = deferred();
			const newEntered = deferred(),
				newRelease = deferred();
			const retryEntered = deferred(),
				retryRelease = deferred();
			let phase = "old";
			anthropic = async () => {
				const current = phase;
				(current === "old" ? oldEntered : current === "new" ? newEntered : retryEntered).resolve();
				await (current === "old" ? oldRelease : current === "new" ? newRelease : retryRelease).promise;
				if (current === "retry") throw new Error("Current account unavailable");
				return healthy;
			};
			const older = runtime.getAvailable();
			await oldEntered.promise;
			phase = "new";
			const controller = new AbortController();
			const reason = new Error("superseding caller cancelled");
			const newer = (
				kind === "direct"
					? runtime.getAvailable("anthropic", { signal: controller.signal })
					: kind === "full"
						? runtime.getAvailable(undefined, { signal: controller.signal })
						: runtime.refresh({ providers: ["anthropic"], allowNetwork: false, signal: controller.signal })
			).catch((error: unknown) => error);
			try {
				await newEntered.promise;
				controller.abort(reason);
				if (kind === "scoped") expect(await newer).toMatchObject({ aborted: true });
				else expect(await newer).toBe(reason);
				phase = "retry";
				oldRelease.resolve();
				expect(
					await Promise.race([older.then(() => "stale success"), retryEntered.promise.then(() => "retry")]),
				).toBe("retry");
				let flushed = false;
				const checkpoint = runtime.flushForCheckpoint().then(() => {
					flushed = true;
				});
				await nextTurn();
				expect(flushed).toBe(false);
				retryRelease.resolve();
				expect((await older).some((model) => model.provider === "anthropic")).toBe(false);
				expect(runtime.hasConfiguredAuth("anthropic")).toBe(false);
				expect(runtime.getAuthCheckError("anthropic")?.message).toContain("Current account unavailable");
				newRelease.resolve();
				await checkpoint;
			} finally {
				oldRelease.resolve();
				newRelease.resolve();
				retryRelease.resolve();
				await Promise.all([older, newer]);
			}
		},
	);

	it("preserves the aggregate caller's exact cancellation during the required recheck", async () => {
		const entered = deferred(),
			release = deferred(),
			retryEntered = deferred(),
			retryRelease = deferred();
		let retry = false;
		anthropic = async () => {
			const current = retry;
			(current ? retryEntered : entered).resolve();
			await (current ? retryRelease : release).promise;
			return healthy;
		};
		const controller = new AbortController();
		const older = runtime.getAvailable(undefined, { signal: controller.signal }).catch((error: unknown) => error);
		await entered.promise;
		await runtime.getAvailable("openai");
		const snapshot = runtime.getAvailableSnapshot();
		retry = true;
		release.resolve();
		try {
			expect(await Promise.race([older.then(() => "stale success"), retryEntered.promise.then(() => "retry")])).toBe(
				"retry",
			);
			const reason = { cancelled: "original caller" };
			controller.abort(reason);
			expect(await older).toBe(reason);
			expect(runtime.getAvailableSnapshot()).toBe(snapshot);
		} finally {
			retryRelease.resolve();
			await older;
		}
	});

	it("preserves a superseded storage failure after joining an invalidated newer pass", async () => {
		const listEntered = deferred(),
			listRelease = deferred(),
			entered = deferred(),
			release = deferred();
		const failure = new Error("actual storage failure");
		vi.spyOn(credentials, "list").mockImplementationOnce(async () => {
			listEntered.resolve();
			await listRelease.promise;
			throw failure;
		});
		const older = runtime.getAvailable().catch((error: unknown) => error);
		await listEntered.promise;
		anthropic = async () => {
			entered.resolve();
			await release.promise;
			return healthy;
		};
		const newer = runtime.getAvailable();
		await entered.promise;
		await runtime.getAvailable("openai");
		listRelease.resolve();
		await nextTurn();
		release.resolve();
		expect(await older).toBe(failure);
		expect((await newer).filter((model) => model.provider === "anthropic")).toEqual(runtime.getModels("anthropic"));
		expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
	});
});
