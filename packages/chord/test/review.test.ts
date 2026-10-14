// Regression tests for Sol's phase 1a review (findings #1-#11) and the requested race tests.
import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, it } from "vitest";
import {
	type Ctx,
	createHost,
	defineRegistry,
	type Facet,
	hostNamed,
	isChordError,
	local,
	memoryLinkPair,
	method,
	type Ref,
	remote,
} from "../src/index.ts";
import { fits } from "../src/schema.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n = 10) => {
	for (let i = 0; i < n; i++) await tick();
};

function latch() {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

function emitter<E>(options: { failSubscribe?: boolean } = {}) {
	const listeners = new Set<(event: E) => void>();
	return {
		emit: (event: E) => {
			for (const fn of [...listeners]) fn(event);
		},
		subscribe: (fn: (event: E) => void) => {
			if (options.failSubscribe) throw new Error("subscribe fails");
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		get size() {
			return listeners.size;
		},
	};
}

const Item = local("t.item", {
	version: 1,
	input: Type.Object({ id: Type.String() }),
	members: { version: method(undefined, Type.String()) },
});

describe("review: reload commit", () => {
	it("#1 a failing listener subscription fails prepare; the code version and all objects stay unchanged", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const sources = { a: emitter<number>(), b: emitter<number>({ failSubscribe: true }), c: emitter<number>() };
		const facet = (version: string, listen: boolean): Facet => ({
			name: "item",
			setup: (api) =>
				api.serve(Item, ({ id }, _principal, self) => {
					if (listen) self.on("events", sources[id as "a"], () => {});
					return { version: () => version };
				}),
		});
		host.install(facet("v1", false));
		const refs = ["a", "b", "c"].map((id) => host.get(Item, { id }));
		await Promise.all(refs.map((ref) => ref.ready));
		const codeVersion = host.codeVersion;
		await assert.rejects(host.reload([facet("v2", true)]), /subscribe fails/);
		assert.equal(host.codeVersion, codeVersion);
		assert.deepEqual(await Promise.all(refs.map((ref) => ref.version())), ["v1", "v1", "v1"]);
		assert.equal(sources.a.size, 0);
		assert.equal(sources.c.size, 0);
	});

	it("#2 migration is validated against the new remote schemas, not the obsolete ones (dev mode)", async () => {
		const host = createHost({ self: { kind: "host" }, dev: true, onError: () => {} });
		const V1 = remote("t.counted", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("host"),
			variants: { main: { state: { count: Type.Object({ n: Type.Number() }) } } },
		});
		const V2 = remote("t.counted", {
			version: 2,
			input: Type.Object({}),
			host: hostNamed("host"),
			variants: { main: { state: { count: Type.Object({ total: Type.Number() }) } } },
		});
		host.install({
			name: "counted",
			setup: (api) =>
				api.serve(
					V1,
					(_input, _principal, self) => ({
						variant: "main",
						count: self.state("count", Type.Object({ n: Type.Number() }), { n: 3 }),
					}),
					{ linger: 60_000 },
				),
		});
		const first = host.get(V1, {});
		await first.ready;
		first.release();
		await host.reload([
			{
				name: "counted",
				setup: (api) =>
					api.serve(
						V2,
						(_input, _principal, self) => ({
							variant: "main",
							count: self.state(
								"count",
								Type.Object({ total: Type.Number() }),
								{ total: 0 },
								{ version: 2, migrate: (old) => ({ total: (old as { n: number }).n }) },
							),
						}),
						{ linger: 60_000 },
					),
			},
		]);
		const second = host.get(V2, {});
		const values: unknown[] = [];
		second.count.subscribe((value) => values.push(value));
		await second.ready;
		await ticks();
		assert.deepEqual(second.count.value, { total: 3 });
	});

	it("#1 a commit that still fails midway fails the host terminally (no half-published code version serving work)", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		host.install({ name: "item", setup: (api) => api.serve(Item, () => ({ version: () => "v1" })) });
		const ref = host.get(Item, { id: "a" });
		await ref.ready;
		// Everything fallible runs in prepare now, so break an install step directly (white box).
		const objects = (host as unknown as { objects: Map<string, { startTasks(): void }> }).objects;
		for (const object of objects.values()) {
			object.startTasks = () => {
				throw new Error("install step fails");
			};
		}
		await assert.rejects(
			host.reload([{ name: "item", setup: (api) => api.serve(Item, () => ({ version: () => "v2" })) }]),
			/install step fails/,
		);
		await assert.rejects(
			ref.version(),
			(error) => isChordError(error, "unavailable") && error.reason === "host_failed",
		);
	});

	it("reentrant observers calling another object during a commit see the whole new code version", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const Other = local("t.other", {
			version: 1,
			input: Type.Object({}),
			members: { version: method(undefined, Type.String()) },
		});
		const facet = (version: string): Facet => ({
			name: "pair",
			setup: (api) => {
				api.serve(Item, () => ({ version: () => version }));
				api.serve(Other, () => ({ version: () => version }));
			},
		});
		host.install(facet("v1"));
		const item = host.get(Item, { id: "a" });
		const other = host.get(Other, {});
		await Promise.all([item.ready, other.ready]);
		const seen: Promise<string>[] = [];
		item.onShape(() => seen.push(other.version()));
		await host.reload([facet("v2")]);
		assert.deepEqual(await Promise.all(seen), ["v2"]);
	});
});

describe("review: leases, invocations, activation", () => {
	const Store = local("t.store", {
		version: 1,
		input: Type.Object({}),
		members: { count: Type.Unknown() },
	});

	it("#4 a running listener holds a lease: the gate waits for it before migrating", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const events = emitter<number>();
		const go = latch();
		const seen: unknown[] = [];
		host.install({
			name: "store",
			setup: (api) =>
				api.serve(Store, (_input, _principal, self) => {
					const count = self.state("count", Type.Object({ n: Type.Number() }), { n: 1 });
					self.on("slow", events, async () => {
						await go.promise;
						seen.push(count.value);
					});
					return { count };
				}),
		});
		const ref = host.get(Store, {});
		await ref.ready;
		events.emit(1);
		await tick();
		const codeVersion = host.codeVersion;
		const reload = host.reload(
			[
				{
					name: "store",
					setup: (api) =>
						api.serve(Store, (_input, _principal, self) => ({
							count: self.state(
								"count",
								Type.Object({ total: Type.Number() }),
								{ total: 0 },
								{ version: 2, migrate: (old) => ({ total: (old as { n: number }).n }) },
							),
						})),
				},
			],
			{ gateDeadline: 2000 },
		);
		await ticks(20);
		assert.equal(host.codeVersion, codeVersion, "the gate must wait for the listener");
		go.open();
		await reload;
		assert.deepEqual(seen, [{ n: 1 }]);
		assert.deepEqual(ref.count.value, { total: 1 });
	});

	it("#5 disposal waits for running methods before closing resources (released and forced)", async () => {
		const Worker = local("t.busy", {
			version: 1,
			input: Type.Object({ id: Type.String() }),
			members: { work: method(undefined, Type.Boolean()) },
		});
		const log: string[] = [];
		let go = latch();
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		host.serve(Worker, ({ id }, _principal, self) => {
			const connResource = self.resource("conn", {
				version: 1,
				open: () => ({ closed: false }),
				close: (conn) => {
					conn.closed = true;
					log.push(`close ${id}`);
				},
			});
			return {
				work: async () => {
					await go.promise;
					log.push(`done ${id}`);
					return connResource.value.closed;
				},
			};
		});
		const released = host.get(Worker, { id: "r" });
		const call = released.work();
		await ticks();
		released.release();
		await ticks();
		go.open();
		assert.equal(await call, false);
		await ticks();
		assert.deepEqual(log, ["done r", "close r"]);

		go = latch();
		log.length = 0;
		const forced = host.get(Worker, { id: "f" }, { principal: { user: "u" } });
		const forcedCall = forced.work();
		await ticks();
		const invalidated = host.invalidatePrincipal((principal) => (principal as { user?: string }).user === "u");
		await ticks();
		assert.equal(forced.status, "gone");
		assert.deepEqual(log, []);
		go.open();
		await invalidated;
		assert.equal(await forcedCall, false);
		assert.deepEqual(log, ["done f", "close f"]);
	});

	it("#6 a registry conflict found while finalizing activation unwinds the loser completely", async () => {
		const errors: unknown[] = [];
		const host = createHost({ self: { kind: "host" }, onError: (error) => errors.push(error) });
		const Routes = defineRegistry<string>("t.review-routes");
		const log: string[] = [];
		const types = ["t.eager-a", "t.eager-b"].map((name) => local(name, { version: 1, input: Type.Object({}) }));
		for (const type of types) {
			host.serve(
				type,
				(_input, _principal, self) => {
					self.resource("r", {
						version: 1,
						open: () => void log.push(`open ${type.name}`),
						close: () => void log.push(`close ${type.name}`),
					});
					self.register(Routes, { same: type.name });
					return {};
				},
				{ lifetime: "host" },
			);
		}
		await ticks(20);
		assert.equal(log.filter((entry) => entry.startsWith("open")).length, 2);
		assert.equal(log.filter((entry) => entry.startsWith("close")).length, 1);
		assert.equal(host.registry(Routes).table().size, 1);
		assert.ok(errors.some((error) => isChordError(error, "invalid") && error.reason === "registry_conflict"));
	});

	it("#6 releasing the last hold while listeners start up does not resurrect the object", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const log: string[] = [];
		let ref: Ref<typeof Store> | undefined;
		let runs = 0;
		host.serve(Store, (_input, _principal, self) => {
			runs++;
			const count = self.state("count", Type.Number(), 0);
			self.resource("r", {
				version: 1,
				open: () => void log.push("open"),
				close: () => void log.push("close"),
			});
			// A readable delivers its current value as the listener starts: release the only hold right then.
			self.on("drop", count, () => ref?.release());
			return { count };
		});
		ref = host.get(Store, {});
		await ref.ready.catch(() => {});
		await ticks(20);
		assert.deepEqual(log, ["open", "close"]);
		const again = host.get(Store, {});
		ref = undefined;
		await again.ready;
		assert.equal(runs, 2);
	});
});

describe("review: prepare isolation and contracts", () => {
	const Db = local("t.db", {
		version: 1,
		input: Type.Object({}),
		members: { read: method(undefined, Type.Unknown()) },
	});

	it("#7 a prepare rerun cannot touch retained resources, even open ones", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const native = { mutated: false };
		const facet = (touch: boolean): Facet => ({
			name: "db",
			setup: (api) =>
				api.serve(Db, (_input, _principal, self) => {
					const db = self.resource("db", { version: 1, open: () => native });
					if (touch) db.value.mutated = true;
					return { read: () => db.value };
				}),
		});
		host.install(facet(false));
		const ref = host.get(Db, {});
		await ref.ready;
		await assert.rejects(host.reload([facet(true)]), (error) => isChordError(error, "not_ready"));
		assert.equal(native.mutated, false);
		assert.deepEqual(await ref.read(), { mutated: false });
	});

	it("#7 objects of types a reload adds start listeners and tasks only at commit", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const log: string[] = [];
		const Fresh = local("t.fresh", { version: 1, input: Type.Object({}) });
		host.install({ name: "item", setup: (api) => api.serve(Item, () => ({ version: () => "v1" })) });
		await Promise.all(["a", "b"].map((id) => host.get(Item, { id }).ready));
		const plugins = (fail: boolean): Facet[] => [
			{
				name: "fresh",
				setup: (api) =>
					api.serve(Fresh, (_input, _principal, self) => {
						self.task(async () => {
							log.push("task started");
						});
						return {};
					}),
			},
			{
				name: "item",
				setup: (api) =>
					api.serve(Item, ({ id }, _principal, self) => {
						self.get(Fresh, {});
						if (fail && id === "b") throw new Error("b fails");
						return { version: () => "v2" };
					}),
			},
		];
		await assert.rejects(host.reload(plugins(true)), /b fails/);
		await ticks();
		assert.deepEqual(log, []);
		await host.reload(plugins(false));
		await ticks();
		assert.deepEqual(log, ["task started"]);
	});

	it("#8 a breaking provider change and its updated consumer reload in one batch", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const P1 = remote("t.provider", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("host"),
			variants: { main: { methods: { get: method(undefined, Type.String()) } } },
		});
		const P2 = remote("t.provider", {
			version: 2,
			input: Type.Object({}),
			host: hostNamed("host"),
			variants: { main: { methods: { fetch: method(undefined, Type.String()) } } },
		});
		const Consumer = local("t.consumer", {
			version: 1,
			input: Type.Object({}),
			members: { ask: method(undefined, Type.String()) },
		});
		host.install({
			name: "both",
			setup: (api) => {
				api.serve(P1, () => ({ variant: "main", get: () => "old" }));
				api.serve(Consumer, (_input, _principal, self) => {
					const provider = self.get(P1, {});
					return { ask: (ctx: Ctx) => provider.get(ctx) };
				});
			},
		});
		const consumer = host.get(Consumer, {});
		assert.equal(await consumer.ask(), "old");
		await host.reload([
			{
				name: "both",
				setup: (api) => {
					api.serve(P2, () => ({ variant: "main", fetch: () => "new" }));
					api.serve(Consumer, (_input, _principal, self) => {
						const provider = self.get(P2, {});
						return { ask: (ctx: Ctx) => provider.fetch(ctx) };
					});
				},
			},
		]);
		assert.equal(await consumer.ask(), "new");
	});

	it("#9 an exclusive resource whose close failed is restored on rollback, or marked unavailable", async () => {
		for (const reopen of ["works", "fails"] as const) {
			const host = createHost({ self: { kind: "host" }, onError: () => {} });
			const log: string[] = [];
			let opens = 0;
			const facet = (rev: number): Facet => ({
				name: "db",
				setup: (api) =>
					api.serve(Db, (_input, _principal, self) => {
						const port = self.resource("port", {
							version: rev,
							exclusive: true,
							open: () => {
								if (rev === 2) throw new Error("new port fails");
								if (++opens > 1 && reopen === "fails") throw new Error("reopen fails");
								log.push(`open ${rev}`);
								return { rev };
							},
							close: () => {
								log.push(`close ${rev}`);
								throw new Error("close fails");
							},
						});
						return { read: () => port.value };
					}),
			});
			host.install(facet(1));
			const ref = host.get(Db, {});
			await ref.ready;
			// The failing close aborts the reload at the gate; the old resource must not stay closed.
			await assert.rejects(host.reload([facet(2)]), /close fails/);
			if (reopen === "works") {
				assert.deepEqual(log, ["open 1", "close 1", "open 1"]);
				assert.deepEqual(await ref.read(), { rev: 1 });
			} else {
				await assert.rejects(ref.read(), (error) => isChordError(error, "unavailable"));
			}
		}
	});

	it("#10 retirement closes dropped resources before releasing dropped holds", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const log: string[] = [];
		const Dep = local("t.dep", { version: 1, input: Type.Object({}) });
		const facet = (withDecls: boolean): Facet => ({
			name: "item",
			setup: (api) => {
				api.serve(Dep, (_input, _principal, self) => {
					self.resource("r", { version: 1, open: () => {}, close: () => void log.push("dep closed") });
					return {};
				});
				api.serve(Item, (_input, _principal, self) => {
					if (withDecls) {
						self.get(Dep, {});
						// Slow close: releasing the hold first would let the dependency close before it finishes.
						self.resource("own", {
							version: 1,
							open: () => {},
							close: async () => {
								await ticks(3);
								log.push("own closed");
							},
						});
					}
					return { version: () => (withDecls ? "v1" : "v2") };
				});
			},
		});
		host.install(facet(true));
		const ref = host.get(Item, { id: "a" });
		await ref.ready;
		const go = latch();
		const pinned = host.root(async (ctx) => {
			await ref.version(ctx);
			await go.promise;
		});
		await tick();
		await host.reload([facet(false)]);
		assert.deepEqual(log, []);
		go.open();
		await pinned;
		await ticks(20);
		assert.deepEqual(log, ["own closed", "dep closed"]);
	});

	it("#11 fits has no false positives for unmodelled keywords; counterexamples checked with Value.Check", () => {
		const cases = [
			[Type.String(), Type.String({ not: { const: "x" } }), "x"],
			[Type.Array(Type.Number()), Type.Array(Type.Number(), { contains: Type.Literal(1) }), [2]],
			[
				Type.Object({ a: Type.String() }),
				Type.Object({ a: Type.String() }, { additionalProperties: Type.Number() }),
				{ a: "s", b: "t" },
			],
			[
				Type.Object({ x: Type.String() }),
				Type.Object({}, { patternProperties: { "^x$": Type.Number() } }),
				{ x: "s" },
			],
			[Type.Number(), Type.Intersect([Type.Number(), Type.Number({ minimum: 1 })]), 0],
			[
				Type.Object({ a: Type.String() }, { additionalProperties: Type.Number() }),
				Type.Object({ a: Type.String(), b: Type.Optional(Type.String()) }),
				{ a: "", b: 1 },
			],
		] as const;
		for (const [sub, sup, value] of cases) {
			assert.ok(Value.Check(sub, value) && !Value.Check(sup, value), `bad counterexample ${JSON.stringify(value)}`);
			assert.equal(fits(sub, sup), false, `fits(${JSON.stringify(sub)}, ${JSON.stringify(sup)})`);
		}
		// Additive changes still fit.
		assert.ok(
			fits(Type.Object({ a: Type.String() }), Type.Object({ a: Type.String(), b: Type.Optional(Type.Number()) })),
		);
		assert.ok(fits(Type.Object({ a: Type.String(), extra: Type.Number() }), Type.Object({ a: Type.String() })));
	});

	it("#11 arguments are stripped to what the consumer knows, then to what the provider knows", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const Strict = remote("t.strict", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("host"),
			variants: {
				main: {
					methods: {
						echo: method(Type.Object({ a: Type.String() }, { additionalProperties: false }), Type.Unknown()),
					},
				},
			},
		});
		host.serve(Strict, () => ({ variant: "main", echo: (args) => args }));
		const ref = host.get(Strict, {});
		assert.deepEqual(await ref.echo({ a: "x", junk: 1 } as never), { a: "x" });
	});
});

describe("review: ctx races", () => {
	const Target = remote("t.target", {
		version: 1,
		input: Type.Object({}),
		host: hostNamed("server"),
		variants: { main: { methods: { hit: method(undefined, Type.String()), wait: method() } } },
	});
	const placements = ["local", "client", "host"] as const;

	async function fixture(placement: (typeof placements)[number]) {
		const errors: unknown[] = [];
		const onError = (error: unknown) => errors.push(error);
		const server = createHost({ name: "server", self: "server", onError });
		const other = createHost({ name: "other", self: "other", onError });
		let owner = server;
		if (placement !== "local") {
			const [down, up] = memoryLinkPair();
			server.accept(down, { principal: "caller", kind: placement, name: "caller" });
			owner = createHost({
				name: "caller",
				self: "caller",
				kind: placement,
				onError,
				upstream: { link: up, principal: "server" },
			});
		}
		let hits = 0;
		const entered = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		server.serve(Target, () => ({
			variant: "main",
			hit: (ctx) => {
				hits++;
				return ctx.rootId;
			},
			wait: async (ctx) => {
				entered.resolve();
				await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
				cancelled.resolve();
			},
		}));
		const target = owner.get(Target, {});
		await target.ready;
		return {
			owner,
			other,
			target,
			entered: entered.promise,
			cancelled: cancelled.promise,
			hits: () => hits,
			close: async () => {
				await owner.close();
				if (owner !== server) await server.close();
				await other.close();
				assert.deepEqual(errors, []);
			},
		};
	}

	// #10959: reference admission must not depend on local placement or link kind.
	it.each(placements)("expired, aborted, foreign and fabricated contexts are refused (%s)", async (placement) => {
		const f = await fixture(placement);
		try {
			const first = await f.target.hit();
			assert.notEqual(await f.target.hit(), first, "no ctx starts a fresh root per call");
			await f.owner.root(async (ctx) => {
				const root = await f.target.hit(ctx);
				if (placement !== "client") assert.equal(root, ctx.rootId);
			});
			const attempt = (ctx: Ctx) => {
				const before = f.hits();
				// Calling with an invalid ctx rejects a promise; it must not throw synchronously.
				return f.target.hit(ctx).then(
					() => ({ hitsAdded: f.hits() - before }),
					(error: unknown) => {
						assert.ok(isChordError(error));
						return { code: error.code, reason: error.reason, hitsAdded: f.hits() - before };
					},
				);
			};
			const fabricated: Ctx = {
				signal: new AbortController().signal,
				rootId: "fabricated",
				codeVersion: 1,
				principal: "caller",
				get: () => {
					throw new Error("fabricated ctx.get must not be used");
				},
			};
			assert.deepEqual(
				{
					expired: await attempt(await f.owner.root((ctx) => ctx)),
					aborted: await f.owner.root(attempt, { signal: AbortSignal.abort() }),
					foreign: await f.other.root(attempt),
					fabricated: await attempt(fabricated),
				},
				{
					expired: { code: "aborted", reason: "expired", hitsAdded: 0 },
					aborted: { code: "aborted", reason: undefined, hitsAdded: 0 },
					foreign: { code: "invalid", reason: "foreign_ctx", hitsAdded: 0 },
					fabricated: { code: "invalid", reason: "foreign_ctx", hitsAdded: 0 },
				},
			);
		} finally {
			await f.close();
		}
	});

	it.each(placements)(
		"task calls start fresh roots, follow cancellation and refuse an aborted holder (%s)",
		async (placement) => {
			const f = await fixture(placement);
			const holder = Promise.withResolvers<Ctx>();
			const aborted = Promise.withResolvers<void>();
			const done = latch();
			const Runner = local("t.runner", { version: 1, input: Type.Object({}) });
			f.owner.serve(Runner, (_input, _principal, self) => {
				self.task(async (ctx) => {
					holder.resolve(ctx);
					ctx.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await done.promise;
				});
				return {};
			});
			try {
				const runner = f.owner.get(Runner, {});
				await runner.ready;
				const ctx = await holder.promise;
				const first = await f.target.hit(ctx);
				assert.notEqual(first, ctx.rootId);
				assert.notEqual(await f.target.hit(ctx), first, "holder calls start separate roots");
				const waiting = f.target.wait(ctx).catch((error: unknown) => error);
				await f.entered;
				runner.release();
				await aborted.promise;
				await f.cancelled;
				await waiting;
				const before = f.hits();
				await assert.rejects(f.target.hit(ctx), (error) => isChordError(error, "aborted"));
				assert.equal(f.hits(), before);
				done.open();
				await ticks();
				await assert.rejects(
					f.target.hit(ctx),
					(error) => isChordError(error, "aborted") && error.reason === "expired",
				);
			} finally {
				done.open();
				await f.close();
			}
		},
	);

	it.each(["client", "host"] as const)(
		"calling a remote reference inside a factory still throws synchronously (%s)",
		async (placement) => {
			const f = await fixture(placement);
			const Eager = local("t.eager-call", { version: 1, input: Type.Object({}) });
			f.owner.serve(Eager, () => {
				void f.target.hit();
				return {};
			});
			try {
				await assert.rejects(f.owner.get(Eager, {}).ready, (error) => isChordError(error, "not_ready"));
				assert.equal(f.hits(), 0);
			} finally {
				await f.close();
			}
		},
	);
});
