import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderResponse } from "../src/types.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry statuses listed in noRetryStatuses", async () => {
		const error = providerError(504, { "retry-after-ms": "0" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2, noRetryStatuses: [504] })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry SDK errors that report a provider limit in their parsed body or message", async () => {
		// The OpenAI SDK keeps the parsed body in `error`; @google/genai folds it into the message.
		const openai = Object.assign(providerError(429, { "retry-after-ms": "0" }), {
			error: {
				message: "You exceeded your current quota, please check your plan and billing details.",
				type: "insufficient_quota",
				code: "insufficient_quota",
			},
		});
		const google = Object.assign(
			new Error(
				'got status: 429 Too Many Requests. {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
			),
			{ status: 429, headers: undefined },
		);
		const gatewayCredits = Object.assign(
			new Error('429 {"error":{"message":"Prepayment credits are depleted for this workspace"}}'),
			{ status: 429, headers: new Headers({ "retry-after-ms": "0" }) },
		);
		const insufficientBalance = Object.assign(new Error("429 Insufficient AI Gateway credits"), {
			status: 429,
			headers: new Headers({ "retry-after-ms": "0" }),
		});

		for (const error of [openai, google, gatewayCredits, insufficientBalance]) {
			const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
			await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
			expect(request).toHaveBeenCalledTimes(1);
		}
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

// #12376
describe("provider request error responses", () => {
	it("reports each failed attempt's status and headers before retrying", async () => {
		const responses: ProviderResponse[] = [];
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "0" }))
			.mockRejectedValueOnce(providerError(503, { "retry-after-ms": "0" }))
			.mockResolvedValue("ok");

		const result = await retryProviderRequest(request, {
			maxRetries: 2,
			onErrorResponse: (response) => void responses.push(response),
		});

		expect(result).toBe("ok");
		expect(responses).toEqual([
			{ status: 429, headers: { "retry-after-ms": "0" } },
			{ status: 503, headers: { "retry-after-ms": "0" } },
		]);
	});

	it("reports the final non-retryable failure", async () => {
		const responses: ProviderResponse[] = [];
		const error = providerError(400, { "x-request-id": "req-1" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(
			retryProviderRequest(request, { maxRetries: 2, onErrorResponse: (response) => void responses.push(response) }),
		).rejects.toBe(error);
		expect(responses).toEqual([{ status: 400, headers: { "x-request-id": "req-1" } }]);
	});

	it("does not report failures without an HTTP status", async () => {
		const onErrorResponse = vi.fn();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("Connection error."));

		await expect(retryProviderRequest(request, { onErrorResponse })).rejects.toThrow("Connection error.");
		expect(onErrorResponse).not.toHaveBeenCalled();
	});

	it("fails the request with the callback's error when the callback throws", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after-ms": "0" }));

		await expect(
			retryProviderRequest(request, {
				maxRetries: 2,
				onErrorResponse: () => {
					throw new Error("callback failed");
				},
			}),
		).rejects.toThrow("callback failed");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not report a failure after the request was aborted", async () => {
		const controller = new AbortController();
		const onErrorResponse = vi.fn();
		const request = vi.fn<() => Promise<string>>().mockImplementation(async () => {
			controller.abort();
			throw providerError(429);
		});

		await expect(retryProviderRequest(request, { signal: controller.signal, onErrorResponse })).rejects.toMatchObject(
			{
				name: "AbortError",
			},
		);
		expect(onErrorResponse).not.toHaveBeenCalled();
	});
});
