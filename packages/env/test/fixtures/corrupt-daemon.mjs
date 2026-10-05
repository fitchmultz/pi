const [scenario, phase] = process.argv.slice(2);
const token = process.argv[process.argv.indexOf("--token") + 1];
process.stdout.write(`PI-ENV ${token}\n`);

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
		const length = buffer.readUInt32BE(0);
		const id = buffer.readUInt32BE(5);
		const jsonLength = buffer.readUInt32BE(9);
		const request = JSON.parse(buffer.subarray(13, 13 + jsonLength).toString("utf8"));
		buffer = buffer.subarray(4 + length);
		const hello = request.op === "hello";
		const corrupt = scenario !== "valid" && (phase === "hello" ? hello : !hello);
		const json = hello
			? {
					protocol: 1,
					version: "fixture",
					os: "linux",
					arch: "x86_64",
					home: "/home/fixture",
					tmpdir: "/tmp",
					separator: "/",
					cwd: "/home/fixture",
					driveCwds: {},
					pid: process.pid,
				}
			: { value: 42 };
		const body = Buffer.from(
			corrupt && scenario === "invalid-json"
				? "{"
				: corrupt && scenario === "null-json"
					? "null"
					: corrupt && scenario === "array-json"
						? "[]"
						: JSON.stringify(json),
		);
		const payload = corrupt || hello ? Buffer.alloc(0) : Buffer.from([0, 255, 123]);
		const header = Buffer.alloc(13);
		header.writeUInt32BE(corrupt && scenario === "length-overrun" ? 9 : 9 + body.length + payload.length, 0);
		header.writeUInt8(2, 4);
		header.writeUInt32BE(id, 5);
		header.writeUInt32BE(body.length, 9);
		process.stdout.write(Buffer.concat([header, body, payload]));
	}
});
