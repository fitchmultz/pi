import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

/** MCP server protected by OAuth, with its own authorization server (discovery, DCR, PKCE, refresh). */
export interface OAuthMcpServerOptions {
	scopesSupported?: string[];
	grantScope?: string;
	writeScope?: string;
	/** A server-owned scope hierarchy, independent of literal requested tokens. */
	writeGrant?: string;
	challengeStatus?: 401 | 403;
	callbackIssuer?: "exact" | "trailing-slash" | "empty";
}

export async function startOAuthMcpServer(options: OAuthMcpServerOptions = {}) {
	const log: string[] = [];
	const validTokens = new Map<string, string | undefined>();
	const refreshTokens = new Map<string, string | undefined>();
	const challenges = new Map<string, string>();
	let issued = 0;
	let writes = 0;
	let grantScope = options.grantScope;
	let origin = "";

	const issueTokens = (scope?: string) => {
		issued++;
		const tokens = { access_token: `access-${issued}`, refresh_token: `refresh-${issued}` };
		validTokens.set(tokens.access_token, scope);
		refreshTokens.set(tokens.refresh_token, scope);
		return { ...tokens, token_type: "Bearer", expires_in: 3600, ...(scope === undefined ? {} : { scope }) };
	};

	const handleMcp = async (request: IncomingMessage, response: ServerResponse) => {
		if (request.method !== "POST") {
			response.writeHead(request.method === "GET" ? 405 : 200).end();
			return;
		}
		const token = request.headers.authorization?.replace(/^Bearer /, "");
		if (!token || !validTokens.has(token)) {
			log.push(`401 ${token ?? "none"}`);
			response
				.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				})
				.end();
			return;
		}
		const message = JSON.parse(await readBody(request)) as {
			id?: number;
			method: string;
			params?: { name?: string };
		};
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		let result: unknown;
		if (message.method === "initialize") {
			result = {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "issues", version: "1.0.0" },
			};
		} else if (message.method === "tools/list") {
			result = {
				tools: (options.writeScope ? ["whoami", "write"] : ["whoami"]).map((name) => ({
					name,
					inputSchema: { type: "object", properties: {} },
				})),
			};
		} else if (message.method === "tools/call") {
			if (message.params?.name === "write" && options.writeScope) {
				const scopes = validTokens.get(token)?.split(/\s+/) ?? [];
				if (!scopes.includes(options.writeScope) && !scopes.includes(options.writeGrant ?? options.writeScope)) {
					log.push(`write denied ${token}`);
					response
						.writeHead(options.challengeStatus ?? 403, {
							"www-authenticate": `Bearer error="insufficient_scope", scope="${options.writeScope}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
						})
						.end();
					return;
				}
				writes++;
				log.push(`write ${token}`);
			}
			log.push(`call ${token}`);
			result = { content: [{ type: "text", text: `token ${token}` }] };
		} else {
			result = {};
		}
		json(response, 200, { jsonrpc: "2.0", id: message.id, result });
	};

	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", origin);
		switch (url.pathname) {
			case "/mcp":
				return handleMcp(request, response);
			case "/.well-known/oauth-protected-resource/mcp":
				return json(response, 200, {
					resource: `${origin}/mcp`,
					authorization_servers: [origin],
					scopes_supported: options.scopesSupported,
				});
			case "/.well-known/oauth-authorization-server":
				return json(response, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			case "/register": {
				const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
				log.push("register");
				return json(response, 201, { ...metadata, client_id: "client-1" });
			}
			case "/authorize": {
				const code = `code-${challenges.size + 1}`;
				challenges.set(code, url.searchParams.get("code_challenge") ?? "");
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", code);
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				if (options.callbackIssuer !== undefined) {
					redirect.searchParams.set(
						"iss",
						options.callbackIssuer === "empty"
							? ""
							: `${origin}${options.callbackIssuer === "trailing-slash" ? "/" : ""}`,
					);
				}
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			case "/token": {
				const params = new URLSearchParams(await readBody(request));
				if (params.get("grant_type") === "authorization_code") {
					const challenge = challenges.get(params.get("code") ?? "");
					const verifier = createHash("sha256")
						.update(params.get("code_verifier") ?? "")
						.digest("base64url");
					if (!challenge || challenge !== verifier) return json(response, 400, { error: "invalid_grant" });
					challenges.delete(params.get("code") ?? "");
					log.push("token code");
					return json(response, 200, issueTokens(grantScope));
				}
				const refresh = params.get("refresh_token") ?? "";
				if (!refreshTokens.has(refresh)) return json(response, 400, { error: "invalid_grant" });
				const scope = refreshTokens.get(refresh);
				refreshTokens.delete(refresh);
				log.push("token refresh");
				return json(response, 200, issueTokens(scope));
			}
			default:
				response.writeHead(404).end();
		}
	};

	const server: Server = createServer((request, response) => {
		void handle(request, response).catch((error) => {
			response.writeHead(500).end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind to TCP");
	origin = `http://127.0.0.1:${address.port}`;
	return {
		url: `${origin}/mcp`,
		log,
		writes: () => writes,
		setGrantScope: (scope: string) => {
			grantScope = scope;
		},
		/** Simulates access token expiry. */
		expireAccessTokens: () => validTokens.clear(),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
