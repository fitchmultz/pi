import { types } from "node:util";
import { describe, expect, test } from "vitest";
import { copyJson, isJsonValue } from "../src/index.ts";

describe("isJsonValue", () => {
	test("checks strict JSON without normalizing it", () => {
		expect(isJsonValue({ nested: [1, true, null] })).toBe(true);
		expect(isJsonValue({ omitted: undefined })).toBe(false);
		expect(isJsonValue(new Uint8Array([1]))).toBe(false);
		expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(isJsonValue(cyclic)).toBe(false);
		const proxy = new Proxy(
			{ version: 1 },
			{ get: (target, key, receiver) => (key === "version" ? 2 : Reflect.get(target, key, receiver)) },
		);
		expect(isJsonValue(proxy)).toBe(true);
		expect(isJsonValue({ nested: [proxy] }, { omitUndefinedProperties: true })).toBe(true);
		expect(copyJson(proxy)).toEqual({ version: 1 });
		const validateContainer = (value: object) => !types.isProxy(value);
		const trap = () => {
			throw new Error("Proxy trap must not execute");
		};
		for (const target of [{ kept: 1 }, [1]]) {
			const guarded = new Proxy(target, {
				get: trap,
				getPrototypeOf: trap,
				ownKeys: trap,
				getOwnPropertyDescriptor: trap,
			});
			expect(isJsonValue(guarded, { validateContainer })).toBe(false);
			expect(isJsonValue({ nested: [guarded] }, { validateContainer })).toBe(false);
		}
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		expect(isJsonValue(revoked.proxy, { validateContainer })).toBe(false);
	});
});

describe("copyJson", () => {
	test("copies strict JSON without retaining aliases", () => {
		const shared = { value: 1 };
		const input = { left: shared, right: shared };
		const copied = copyJson(input) as typeof input;
		expect(copied).toEqual(input);
		expect(copied).not.toBe(input);
		expect(copied.left).not.toBe(shared);
		expect(copied.right).not.toBe(shared);
		expect(copied.left).not.toBe(copied.right);
	});

	test("optionally omits undefined object properties without normalizing arrays", () => {
		const input = { kept: 1, omitted: undefined, nested: { omitted: undefined, kept: true } };
		expect(() => copyJson(input)).toThrow(/strict JSON/);
		expect(isJsonValue(input)).toBe(false);
		expect(isJsonValue(input, { omitUndefinedProperties: false })).toBe(false);
		expect(isJsonValue(input, { omitUndefinedProperties: true })).toBe(true);
		expect(copyJson(input, { omitUndefinedProperties: true })).toEqual({ kept: 1, nested: { kept: true } });
		expect(Object.hasOwn(input, "omitted")).toBe(true);
		expect(isJsonValue([undefined], { omitUndefinedProperties: true })).toBe(false);
		expect(() => copyJson([undefined], { omitUndefinedProperties: true })).toThrow(/strict JSON/);
	});

	test("preserves null prototypes and own __proto__ data properties", () => {
		const input = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(input, "__proto__", {
			value: { safe: true },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		const copied = copyJson(input) as Record<string, unknown>;
		expect(Object.getPrototypeOf(copied)).toBeNull();
		expect(Object.hasOwn(copied, "__proto__")).toBe(true);
		expect(copied.__proto__).toEqual({ safe: true });
	});

	test("rejects cycles and non-strict container properties", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		const sparse: unknown[] = [];
		sparse[1] = 1;
		const extra = Object.assign([1], { extra: 2 });
		class ArraySubclass extends Array<unknown> {}
		const subclass = new ArraySubclass(1);
		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
		const hidden = Object.defineProperty({}, "value", { enumerable: false, value: 1 });
		const undefinedAccessor = Object.defineProperty({}, "value", {
			enumerable: true,
			get: () => {
				throw new Error("Getter must not execute");
			},
		});
		const hiddenUndefined = Object.defineProperty({}, "value", { enumerable: false, value: undefined });
		const symbol = { [Symbol("value")]: 1 };
		for (const invalid of [
			cyclic,
			sparse,
			extra,
			subclass,
			accessor,
			hidden,
			undefinedAccessor,
			hiddenUndefined,
			symbol,
		]) {
			expect(isJsonValue(invalid)).toBe(false);
			expect(isJsonValue(invalid, { omitUndefinedProperties: true })).toBe(false);
			expect(() => copyJson(invalid)).toThrow(/strict JSON/);
			expect(() => copyJson(invalid, { omitUndefinedProperties: true })).toThrow(/strict JSON/);
		}
	});
});
