import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthInteraction, AuthPrompt } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";

const localFetch = globalThis.fetch;
const redirectUri = "http://localhost:53692/callback";

function startLogin(localCallbackServer?: boolean) {
	const abort = new AbortController();
	let authUrl: URL;
	let promptSignal: AbortSignal;
	let answer: (value: string) => void;
	let ready: () => void;
	let failed: (error: unknown) => void;
	const prompted = new Promise<void>((resolve, reject) => {
		ready = resolve;
		failed = reject;
	});
	const oauth = anthropicProvider().auth.oauth!;
	const done = oauth.login({
		signal: abort.signal,
		localCallbackServer,
		notify(event) {
			if (event.type === "auth_url") authUrl = new URL(event.url);
		},
		prompt(prompt) {
			expect(prompt.type).toBe("manual_code");
			promptSignal = prompt.signal!;
			promptSignal.throwIfAborted();
			return new Promise<string>((resolve, reject) => {
				const cancel = () => reject(promptSignal.reason);
				promptSignal.addEventListener("abort", cancel, { once: true });
				answer = (value) => {
					promptSignal.removeEventListener("abort", cancel);
					resolve(value);
				};
				ready();
			});
		},
	});
	void done.catch((error) => failed(error));
	return {
		abort,
		done,
		prompted,
		get url() {
			return authUrl;
		},
		get promptSignal() {
			return promptSignal;
		},
		answer(value: string) {
			answer(value);
		},
	};
}

function tokenEndpoint() {
	const requests: Record<string, string>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			expect(url).toBe("https://platform.claude.com/v1/oauth/token");
			init.signal!.throwIfAborted();
			const body = JSON.parse(String(init.body)) as Record<string, string>;
			expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
			expect(body.redirect_uri).toBe(redirectUri);
			expect(body.state).toBe(body.code_verifier);
			requests.push(body);
			return Response.json({
				access_token: `access-${body.code}`,
				refresh_token: `refresh-${body.code}`,
				expires_in: 3600,
			});
		}),
	);
	return requests;
}

async function stopLogin(login: ReturnType<typeof startLogin>) {
	login.abort.abort(new Error("synthetic cancellation"));
	await login.done.catch(() => undefined);
}

describe.sequential("Anthropic callback transport", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("passes the manual-only interaction through Models while the real callback port is occupied", async () => {
		const requests = tokenEndpoint();
		const blocker = createServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen(53692, "127.0.0.1", resolve);
		});
		try {
			const models = createModels();
			models.setProvider(anthropicProvider());
			const interaction: AuthInteraction = {
				localCallbackServer: false,
				notify() {},
				prompt: async () => "synthetic-code",
			};
			const credential = await models.login("anthropic", "oauth", interaction);
			expect(credential).toEqual({
				type: "oauth",
				access: "access-synthetic-code",
				refresh: "refresh-synthetic-code",
				expires: expect.any(Number),
			});
			expect(requests).toHaveLength(1);
			expect(await models.getAuth("anthropic")).toMatchObject({
				source: "OAuth",
				auth: { apiKey: "access-synthetic-code" },
			});
		} finally {
			await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("keeps concurrent manual-only attempts and their PKCE/state separate", async () => {
		const requests = tokenEndpoint();
		const a = startLogin(false);
		const b = startLogin(false);
		try {
			await Promise.all([a.prompted, b.prompted]);
			expect(a.url.searchParams.get("state")).not.toBe(b.url.searchParams.get("state"));
			for (const [login, code] of [
				[a, "a"],
				[b, "b"],
			] as const) {
				const params = login.url.searchParams;
				expect(params.get("redirect_uri")).toBe(redirectUri);
				expect(params.get("code_challenge_method")).toBe("S256");
				expect(params.get("code_challenge")).toBe(
					createHash("sha256").update(params.get("state")!).digest("base64url"),
				);
				login.answer(`${redirectUri}?code=${code}&state=${params.get("state")}`);
			}
			expect((await a.done).access).toBe("access-a");
			expect((await b.done).access).toBe("access-b");
			expect(requests).toHaveLength(2);
			expect(a.promptSignal.aborted).toBe(true);
			expect(b.promptSignal.aborted).toBe(true);
		} finally {
			await Promise.all([stopLogin(a), stopLogin(b)]);
		}
	});

	it("rejects another attempt's state without exchanging a token", async () => {
		const requests = tokenEndpoint();
		const login = startLogin(false);
		const other = startLogin(false);
		try {
			await Promise.all([login.prompted, other.prompted]);
			login.answer(`synthetic-code#${other.url.searchParams.get("state")}`);
			await expect(login.done).rejects.toThrow("OAuth state mismatch");
			expect(requests).toHaveLength(0);
			expect(login.promptSignal.aborted).toBe(true);
			expect(other.promptSignal.aborted).toBe(false);
			other.answer("other-code");
			expect((await other.done).access).toBe("access-other-code");
		} finally {
			await Promise.all([stopLogin(login), stopLogin(other)]);
		}
	});

	it.each([false, undefined])(
		"cancels the native prompt and permits replacement (local callback: %s)",
		async (mode) => {
			const requests = tokenEndpoint();
			const login = startLogin(mode);
			try {
				await login.prompted;
				const rejected = expect(login.done).rejects.toThrow("synthetic cancellation");
				login.abort.abort(new Error("synthetic cancellation"));
				await rejected;
				expect(login.promptSignal.aborted).toBe(true);
				expect(requests).toHaveLength(0);
			} finally {
				await stopLogin(login);
			}
			const replacement = startLogin(mode);
			try {
				await replacement.prompted;
				replacement.answer("replacement");
				expect((await replacement.done).access).toBe("access-replacement");
			} finally {
				await stopLogin(replacement);
			}
		},
	);

	it("preserves the default real Node callback and dismisses the pending prompt", async () => {
		const requests = tokenEndpoint();
		const login = startLogin();
		try {
			await login.prompted;
			const callback = new URL(redirectUri);
			callback.hostname = "127.0.0.1";
			callback.searchParams.set("code", "callback");
			callback.searchParams.set("state", "wrong-state");
			expect((await localFetch(callback)).status).toBe(400);
			expect(requests).toHaveLength(0);
			callback.searchParams.set("state", login.url.searchParams.get("state")!);
			const response = await localFetch(callback);
			expect(response.status).toBe(200);
			await response.text();
			expect((await login.done).access).toBe("access-callback");
			expect(login.promptSignal.aborted).toBe(true);
			expect(requests).toHaveLength(1);
		} finally {
			await stopLogin(login);
		}
	});

	it("cancels a manual-only token exchange through the native request signal", async () => {
		let exchanging: () => void;
		const started = new Promise<void>((resolve) => {
			exchanging = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				expect(url).toBe("https://platform.claude.com/v1/oauth/token");
				const signal = init.signal!;
				signal.throwIfAborted();
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					exchanging();
				});
			}),
		);
		const login = startLogin(false);
		try {
			await login.prompted;
			login.answer("synthetic-code");
			await started;
			const rejected = expect(login.done).rejects.toThrow("synthetic cancellation");
			login.abort.abort(new Error("synthetic cancellation"));
			await rejected;
			expect(login.promptSignal.aborted).toBe(true);
		} finally {
			await stopLogin(login);
		}
	});

	it("does not notify or prompt for an already cancelled manual-only login", async () => {
		tokenEndpoint();
		const notify = vi.fn();
		const prompt = vi.fn(async (_prompt: AuthPrompt) => "stale-code");
		await expect(
			anthropicProvider().auth.oauth!.login({
				localCallbackServer: false,
				signal: AbortSignal.abort(new Error("synthetic cancellation")),
				notify,
				prompt,
			}),
		).rejects.toThrow("synthetic cancellation");
		expect(notify).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	});
});
