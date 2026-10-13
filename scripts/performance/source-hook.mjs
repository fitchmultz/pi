import http from "node:http";
import https from "node:https";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_PERF_REPO;
if (!root) throw new Error("Use scripts/performance/run.mjs to select and isolate the source root");
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("/pi-performance-source/")) {
			specifier = pathToFileURL(resolve(root, specifier.slice("/pi-performance-source/".length))).href;
		}
		return nextResolve(specifier, context);
	},
});

const denied = () => {
	throw new Error("Network calls are disabled in offline performance fixtures");
};
globalThis.fetch = denied;
globalThis.WebSocket = class {
	constructor() {
		denied();
	}
};
http.request = http.get = https.request = https.get = denied;
// Local Unix sockets are needed by the background-command lease; deny TCP instead.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const options = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (typeof options !== "object" || typeof options?.path !== "string") denied();
	return connect.apply(this, args);
};
syncBuiltinESMExports();
