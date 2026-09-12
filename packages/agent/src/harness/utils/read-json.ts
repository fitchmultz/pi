import { type Static, Type } from "typebox";
import { Pointer } from "typebox/value";

export const readJsonSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description:
					'JSON Pointer to select (default: "" for the root). Use /rows/0 for an array element; escape ~ as ~0 and / as ~1.',
			}),
		),
		fields: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Literal immediate keys to keep on the selected object or every object in the selected array. Absent fields are omitted.",
			}),
		),
	},
	{
		description:
			"Select and pretty-print JSON before applying offset, limit, and output caps. Use {} for the whole document.",
	},
);

export type ReadJsonOptions = Static<typeof readJsonSchema>;

export function extractReadJson(text: string, { path = "", fields }: ReadJsonOptions): string {
	if ((path !== "" && !path.startsWith("/")) || /~(?:[^01]|$)/.test(path)) {
		throw new Error(
			'JSON selection: json.path must be a JSON Pointer ("" for the root, /rows/0 for an array element; escape ~ as ~0 and / as ~1).',
		);
	}

	let value: unknown;
	try {
		value = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		throw new Error(`JSON selection requires valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	for (const key of Pointer.Indices(path)) {
		if (
			value === null ||
			typeof value !== "object" ||
			(Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) ||
			!Object.hasOwn(value, key)
		) {
			throw new Error(
				`JSON selection: json.path ${JSON.stringify(path)} does not exist. Use an existing object key or array index.`,
			);
		}
		value = (value as Record<string, unknown>)[key];
	}

	if (fields !== undefined) {
		const pickFields = (item: unknown) => {
			if (item === null || typeof item !== "object" || Array.isArray(item)) {
				throw new Error(
					"JSON selection: json.fields requires an object or an array containing only objects. Narrow json.path to an object or omit json.fields.",
				);
			}
			return Object.fromEntries(
				fields
					.filter((key) => Object.hasOwn(item, key))
					.map((key) => [key, (item as Record<string, unknown>)[key]]),
			);
		};
		value = Array.isArray(value) ? value.map(pickFields) : pickFields(value);
	}

	return JSON.stringify(value, null, 2);
}
