import { fileURLToPath } from "node:url";
import { Connection } from "../../src/connection.ts";

const [scenario, phase] = process.argv.slice(2);
const daemon = fileURLToPath(new URL("./corrupt-daemon.mjs", import.meta.url));
const connection = new Connection({ command: [process.execPath, daemon, scenario, phase] });
try {
	if (phase === "hello") {
		const info = await connection.info();
		console.log(JSON.stringify({ status: "accepted", protocol: info.protocol }));
	} else {
		const result = await connection.request("probe", {});
		console.log(JSON.stringify({ status: "accepted", json: result.json, payload: [...result.payload] }));
	}
} catch (error) {
	console.log(JSON.stringify({ status: "rejected", name: error.name, code: error.code }));
} finally {
	connection.close();
}
