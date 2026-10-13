import { setTimeout } from "node:timers/promises";

const mode = process.argv[2];
const limit = Number(process.argv[3]);
const write = (bytes) => new Promise((resolve) => process.stdout.write(bytes, resolve));

if (mode === "frames") {
	await write("\r\n \t\nnot json\n{\"jsonrpc\":\"1.0\"}\n");
	await write(`${"x".repeat(limit + 1)}\n`);
	const json = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "é😀" }));
	const line = Buffer.concat([json, Buffer.from(`${" ".repeat(limit - json.length - 1)}\r`)]);
	const split = json.indexOf(Buffer.from("é")) + 1;
	for (const part of [line.subarray(0, split), line.subarray(split, split + 3), line.subarray(split + 3)]) {
		await write(part);
		await setTimeout(5);
	}
	await write("\n");
	await write("x".repeat(limit));
	await setTimeout(5);
	await write("x");
	await setTimeout(5);
	await write('\n{"jsonrpc":"2.0","id":2,"result":true}\n{"jsonrpc":"2.0","id":3,"result":null}\n');
} else {
	await write(mode === "incomplete" ? '{"jsonrpc":' : " \t\r\n \t");
}
