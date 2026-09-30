# MCP Servers

Pi connects to [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio or streamable HTTP. Every server connects lazily by default, including servers with `direct` exposure. Set `connection: "eager"` only for servers that should connect at session startup.

## Configure servers

Pi reads these files in order:

1. `~/.config/mcp/mcp.json` (shared configuration)
2. `~/.pi/agent/mcp.json` (Pi global configuration)
3. `.pi/mcp.json` in a trusted project

Later sources replace the **whole entry** with the same server name; fields are not merged. Project configuration is ignored until the project is trusted, because stdio entries run commands.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "exposure": "direct"
    },
    "startup": {
      "url": "https://example.com/startup/mcp",
      "connection": "eager"
    }
  }
}
```

- stdio entries take `command`, `args`, `env`, and `cwd`. `command` is one executable, not a shell string. Relative `cwd` resolves against the session directory; a leading `~/` in `command`, an argument, or `cwd` names the home directory.
- HTTP entries take `url`, `headers`, and `oauth` (see [Sign in with OAuth](#sign-in-with-oauth)). Legacy SSE is not supported. `type` is optional; when supplied, use `stdio`, `http`, or `streamable-http`.
- `env`, `headers`, and `oauth.clientSecret` values accept `${NAME}` environment references or a whole-value `!command`. A header command must print the complete header, for example `"Authorization": "!echo Bearer $(gh auth token)"`.
- `connection` is `lazy` (default) or `eager`, independently of [exposure](#exposure). `description` supplies a short server description for discovery.
- `timeout` is the per-request timeout in seconds (default 60); progress notifications reset it. `enabled: false` keeps an entry without connecting.
- Server names contain only letters, digits, `_`, and `-`. Invalid entries are reported and skipped without stopping other servers.

Use `pi mcp add` and `pi mcp remove` for Pi-owned files:

```sh
pi mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
pi mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN --exposure direct
pi mcp add startup --url https://example.com/startup/mcp --connection eager
pi mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
pi mcp remove docs
```

`add` replaces an existing entry in its destination. Add `-l` for the project file; otherwise commands edit the global Pi file. Pi never edits the shared file. Changing an inherited shared entry in `/mcp` copies that whole entry into Pi's global file and applies the change there. To stop using an inherited server, disable it in `/mcp`; removing a Pi override exposes the shared entry again.

Pi-owned config files may be symlinks to writable dotfiles. Management and import update the real file under its lock and leave the link intact, preserving unrelated settings, indentation, and permissions. Dangling links, nonregular or read-only targets, and links to the shared source are refused.

After adding or editing entries outside a session, run `/reload` or start a new session.

## Connections and catalogs

Startup restores matching cached tool, resource, and prompt descriptors and assigned tool names from `~/.pi/agent/mcp-catalog.json` without starting lazy processes, opening server connections, executing secret commands, or starting browser consent. A cold server has no tool schemas yet; discover it by server or namespace before calling it. Eager servers connect at startup; the first prompt waits up to 10 seconds for eager servers with direct tools.

Catalogs and live bindings are bound to the profile name, working directory, transport configuration, resolved environment-backed credentials, and OAuth grant identity. The store retains the eight most recently saved identities per profile, so discovery in another project does not immediately replace your catalog. OAuth refresh preserves the account's catalog identity; sign-in, grant import, and logout change it. Stale metadata is withdrawn before calls are admitted.

For stdio, identity includes the effective working directory and environment, except known inherited Pi routing and shell/terminal bookkeeping. Explicit `env` values always count; set a bookkeeping field there if your server uses it as configuration. Credential-agent, executable-path, mise, and unknown environment inputs remain included.

Credentials supplied by opaque `!command` expressions cannot be identified without executing them, so those profiles **skip cached restore** and require live discovery. Status and global search do not execute the commands to fill that gap. Once connected through a native transport, an unchanged resolved credential preserves tool bindings through reconnect; a changed credential revokes prepared calls.

Lazy connections close after 10 minutes without an active request and reconnect on use. Their cached descriptors remain available. Eager connections stay open until shutdown or an explicit management action. Running sessions notice external native CLI sign-in or logout on the next turn; eager profiles attempt reconnection then, while lazy profiles wait for discovery or use. A dropped connection reconnects on the next call. Tool-list and prompt-list notifications update descriptors; withdrawn tools become unreachable and withdrawn prompt commands are removed.

HTTP connection setup retries transient network errors and statuses 408, 429, and 5xx except 501 twice. Resource and prompt reads retry a transient HTTP error once. An expired HTTP session confirmed by 404 can be recreated. Tool calls with an uncertain outcome are never automatically replayed: a timeout, cancellation, or dropped response may mean the operation ran. Check the server's state before repeating a write.

Server logging notifications go to `~/.pi/agent/mcp.log`; the file rotates to `mcp.log.1` past 5 MB. Stopping stdio closes stdin, then sends SIGTERM and finally SIGKILL to the whole process group, including wrappers such as `npx` and `uvx`.

## Discover and call tools

Each server has namespace `mcp__<server>`. Native tool names are `mcp__<server>__<tool>`, sanitized to provider-compatible characters and shortened or disambiguated with a hash suffix when needed. Use names returned by discovery rather than guessing them.

Global `tool_search` and `searchTools()` inspect registered metadata and matching cached catalogs only. They do not connect undiscovered servers and report incomplete coverage when catalogs are missing. A server-scoped or namespace-scoped search connects only that server, without starting browser consent:

```json
{ "query": "search documents", "server": "docs", "limit": 3 }
```

Pass this to `tool_search` to make matching deferred tools available from the next model call. For a cold direct server, scoped discovery registers its permitted direct tools even if no deferred matches are returned. `namespace: "mcp__docs"` is an alternative to `server: "docs"`; do not supply both. Canonical namespaces, raw server names, and unambiguous normalized aliases are accepted; ambiguous aliases fail.

Codemode can discover and call in one script:

```js
const matches = await searchTools("search documents", { server: "docs", limit: 3 });
if (!matches.length) throw new Error("No matching tool");
// This example assumes the best match accepts { query: string }.
const result = await callTool(matches[0].name, { query: "MCP" });
text(result.structuredContent ?? result.content);
```

The argument `{ query: "MCP" }` is illustrative; use the selected tool's schema. `tools` and `ALL_TOOLS` are snapshots taken when the script starts. Use `callTool(name, args)` for tools discovered later in that same script. `await describeNamespace("docs")` discovers that server and returns `{ name, description?, instructions?, tools }`; `describeTool(name)` reads a currently callable tool's declaration without discovering a server.

The deferred native `mcp_discover` tool exposes coverage directly: `{}` is cache-only; `{ server: "docs" }` discovers that server. Its result contains `servers`, `complete`, and `undiscovered`.

## Manage servers

`/mcp` opens the server manager in the TUI and prints status in other modes. Opening it does not connect dormant servers. It shows configured sources, cached counts, live state, and errors. Select a server to connect or reconnect, sign in or out, inspect cached tools and prompts, change exposure, or enable or disable it. Extension-server changes are session-local; configuration changes are saved to Pi-owned files.

```text
/mcp reconnect docs
/mcp login sentry
/mcp logout sentry
/mcp prompts docs
```

From a shell:

```sh
pi mcp list --json            # Configuration and matching catalogs only
pi mcp list --connect --json  # Probe every enabled server, then close the connections
pi mcp login sentry
pi mcp logout sentry
```

Ordinary `list` reports `configured`, `cached`, or `disabled`, not a health check. It reports `cache-error` if reading a catalog fails and exits with 1 for configuration or catalog errors. `--connect` also exits with 1 if an enabled server cannot connect or its catalog cannot be saved, and refreshes successful catalogs. Shell commands do not load extensions; they see configuration-file servers only. See [MCP commands](cli.md#mcp-commands) for options.

## Sign in with OAuth

HTTP servers without an `Authorization` header use OAuth when challenged:

```json
{ "mcpServers": { "sentry": { "url": "https://mcp.sentry.dev/mcp" } } }
```

Discovery can report `needs-auth`, but never opens a consent page. Sign in explicitly with `/mcp login sentry`, the manager's **Sign in**, or `pi mcp login sentry`. Pi opens the authorization URL and listens on a temporary loopback callback. If the browser runs on another machine, paste the **full redirect URL**, including `code` and `state`, into the sign-in screen. A shell login accepts pasted URLs when stdin is a terminal and otherwise waits for the loopback callback.

The deferred `mcp_auth` tool supports the same flow in non-interactive model workflows:

1. `{ "action": "begin", "server": "sentry" }` opens the browser and returns `state: "pending"`, `id`, `authorizationUrl`, and `redirectUrl`. On a remote host, open `authorizationUrl` in your local browser.
2. `{ "action": "complete", "id": "<returned id>" }` uses the captured callback, waiting if necessary. If the local browser cannot reach the remote host, use `{ "action": "complete", "id": "<returned id>", "redirectUrl": "<full browser redirect URL>" }` instead. Pi validates the callback address, state, and issuer before committing the grant. If the pasted URL fails the initial callback-address, state, or code checks, the flow stays pending; correct the URL and retry with the same `id` before expiry. Cancelling a waiting `complete` call cancels its flow.
3. `{ "action": "cancel", "id": "<returned id>" }` discards the pending flow and closes its listener. Pending flows expire after five minutes and are discarded on session shutdown or reload.

`begin` alone does not save tokens. `complete` returns `state: "signed-in"` after storing the grant; it does not connect unrelated servers or discover the newly signed-in profile's tools. Discover that profile next. UI and shell login also reconnect the selected server.

Native grants live in `~/.pi/agent/mcp-auth.json`, bound to the configured profile, endpoint, and client identity. Pi serializes refresh, completion, logout, and import for that identity, including across processes. Pending PKCE secrets and OAuth state stay in the owning runtime. Stored URL-keyed credentials from older Pi versions and adapter credentials are not an automatic fallback. Separate profiles for the same URL do not share grants or catalogs.

Pi supports dynamic client registration, pre-registered clients, and HTTPS client metadata documents (`oauth.clientMetadataUrl`). Configure a fixed client when needed:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "clientId": "my-client",
        "clientSecret": "${EXAMPLE_SECRET}",
        "callbackPort": 8765
      }
    }
  }
}
```

`clientSecret` is optional. `callbackPort` sets `http://127.0.0.1:<port>/callback`; `callbackUrl` supplies another registered HTTP loopback URI on `localhost`, `127.0.0.1`, or `[::1]`, without credentials, query, or fragment. A new callback URL without a port gets `callbackPort` or a free port appended. A stored registration fixes its exact redirect URI, including host, path, and port; Pi does not silently substitute another address if it cannot listen there.

`scope` supplies space-separated scopes to request. Pi stores the actual grant, which may be narrower. Further consent requests include prior requested and granted scopes plus unresolved server challenges; partial consent leaves authorized operations usable. The server decides scope hierarchies and operation permissions. Refresh happens automatically for expired or rejected access tokens, but a request denied with `insufficient_scope` is not refreshed or replayed. Additional consent requires explicit sign-in again. Logout deletes the profile's grant and withdraws its old account metadata.

## Exposure

`exposure` controls how tools are reached, not when a server connects:

| Exposure | Behavior |
|---|---|
| `codemode` (default) | Deferred native tools, callable from codemode; Pi activates codemode unless `autoEnableCodemode` is false |
| `codemode-deferred` | Deferred native tools, callable from codemode; Pi activates codemode unless disabled |
| `deferred` | Deferred tools loaded by `tool_search` for direct calls; Pi activates tool search |
| `direct` | Declared and callable when discovered and selected; a cold lazy server activates tool search for scoped discovery |
| `hidden` | Registered tools cannot be called |

Both native codemode exposures keep MCP schemas out of the inline codemode description. The model receives a bounded server inventory; scoped search and `describeNamespace()` supply current schemas and usage instructions. This keeps a connection or idle cleanup from rewriting codemode's tool description.

`toolExposure` overrides individual raw server tool names. An exact name wins; otherwise the first matching `*` pattern wins:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "exposure": "deferred",
      "toolExposure": {
        "search_code": "direct",
        "get_*": "codemode",
        "delete_*": "hidden"
      }
    }
  }
}
```

Deferred tools are reachable through codemode or tool search, subject to configured tool restrictions. Direct tools are callable only while selected. Native saved selections survive `/tree`, resume, and fork; missing permitted names wait for lazy registration, and explicitly deselected tools stay deselected. Adapter `mcp-tool-selection` entries map selected raw server/tool pairs to actual native names as they are discovered, and map gateway/script features to tool search/codemode. This does not make adapter scripts or tool names interchangeable with native ones.

To keep codemode active without MCP, set `"defaultTools": ["+codemode"]`. Set `"autoEnableCodemode": false` at the top level of `mcp.json` to disable its automatic activation; higher-precedence configuration wins. Pi warns when neither codemode nor tool search can reach configured indirect tools.

Catalog reuse and stable descriptions avoid unnecessary declaration churn. A migration, changed schema, account, tool selection, provider, or context boundary can still change the request prefix and cause a cache miss. These controls are not a guarantee of provider cache hits.

## Results and permissions

Direct calls and codemode calls use Pi's argument validation, live tool admission, and `tool_call`/`tool_result` hooks. A cached definition that changes on reconnection must be rediscovered before execution; account changes revoke old bindings. Codemode calls carry `parentToolCallId`. Server annotations are unverified permission hints, available through `pi.getAllTools()`; resource tools are marked read-only.

When structured data is retained, codemode receives the complete **hook-permitted** MCP `CallToolResult`: `content`, optional `structuredContent`, and `isError`, without the server's top-level `_meta`. An MCP `isError` result resolves as data in scripts and is an error for direct model calls. `image(result.content[0])` can forward an image block.

After all result hooks, Pi saves the permitted tool or resource result as private JSON (mode `0600`). The model sees its path; script results also carry `fullResultPath` when structured content remains. Model-facing text over 20 KiB keeps its start and end around an omission marker. Read the JSON artifact for complete data, including structured fields and permitted binary blobs; it is not a separate unredacted server response. A hook that replaces only `content` drops stale `structuredContent`. File-save failures are reported rather than claiming an artifact exists.

For a result shaped as `{ structuredContent: { rows: [...] }, ... }`, call `read` with:

```json
{
  "path": "/tmp/pi-mcp-<result>.json",
  "json": { "path": "/structuredContent/rows", "fields": ["name", "status"] },
  "limit": 100
}
```

Use the actual returned path and payload shape. JSON selection happens before paging and output limits; continue with the same selectors and the returned offset. See [JSON selection with read](sdk.md#json-selection-with-read). Binary resource files are also derived from the final permitted payload.

## Resources and prompts

`list_mcp_resources` and `list_mcp_resource_templates` accept `server` and optional `cursor`. A scoped call connects only that server and returns one page with `nextCursor`. Without `server`, they connect eligible servers and follow every page; partial failures appear in `errors`. `read_mcp_resource` requires `server` and `uri`, returning `{ server, uri, contents }` to scripts and text, images, or saved binaries to the model. Cold resource-only servers can be discovered through these tools too.

Resource tools reach enabled servers whose server-level exposure is not `hidden`; their exposure is the widest of those servers (`direct`, then codemode, codemode-deferred, deferred). Listings omit resource icons and MCP Apps (`ui://` or `text/html;profile=mcp-app`), which Pi does not render.

MCP prompts register cached slash commands, normally `/mcp__<server>__<prompt>`, with the same name sanitization and collision suffixing as tools. `/mcp prompts [server]` lists cached commands without connecting; use `/mcp reconnect <server>` to discover a cold prompt catalog. Running a prompt command connects only its owner, verifies the current account and prompt, and sends the returned content as a user message. Multiple messages retain role labels; they do not inject assistant transcript entries.

Arguments can be positional in the advertised order or `name=value`, with quoting and escapes:

```text
/mcp__docs__summarize topic="native MCP" style=brief
```

Missing required arguments, extra positional arguments, and unfinished quotes fail before fetching. Disabled, hidden, withdrawn, or old-account prompts cannot run. A cached prompt from an old account is refused before starting a server transport.

## Import adapter configuration

`pi mcp import-adapter` is explicit, copy-only migration. It never runs as a discovery or authentication fallback. Supply expanded source files in increasing precedence order; later adapter entries merge partial overrides before conversion to native whole entries:

```sh
pi mcp import-adapter --config /path/base.json --config /path/override.json --dry-run
pi mcp import-adapter --config /path/base.json --config /path/override.json
```

Import targets Pi's global `mcp.json`, rejects existing destination entries and native grants, and leaves all source files intact. It translates supported stdio/HTTP settings and secret-reference syntax without executing commands. Adapter entries default to native `codemode-deferred`; lifecycle `eager`/`keep-alive` maps to `connection: "eager"`, and other supported lazy lifecycles map to `lazy`. Unsupported transports, implicit imports, nonempty adapter global settings, tool filtering/approval policies, or unsupported OAuth flows fail rather than being silently discarded. Translate those settings explicitly before importing.

Grants are optional. For a JSON export containing adapter `AuthEntry` objects keyed by exact profile name, use:

```sh
pi mcp import-adapter --config /path/adapter.json --credentials /path/grants.json --adapter-stopped --dry-run
pi mcp import-adapter --config /path/adapter.json --credentials /path/grants.json --adapter-stopped
```

On macOS, `--keychain` is an explicit read-only alternative to `--credentials`; it is never accessed by default. Stop **all adapter sessions and other hosts using those grants**, pass `--adapter-stopped`, and keep those users stopped after copying. Rotating refresh tokens cannot be used as independent copies. To run native and adapter clients independently, sign in separately instead.

Dry-run validates the explicitly requested credentials as well as configuration, without destination writes. Grant import checks the profile endpoint, issuer, client, and exact registered callback, and verifies copied data. It never overwrites grants or deletes adapter credentials. If config is copied but a grant write fails, the error says so; inspect native destinations before retrying. Source preservation does not make copied rotating grants safe for simultaneous use.

<a id="other-mcp-extensions"></a>
<a id="sdk"></a>

## Extensions and SDK hosts

`pi.registerMcpServer(name, config)` adds a session-local server with the same lazy default and explicit `connection: "eager"` option. File configuration takes precedence over registrations of the same name. See [MCP extension APIs](extensions.md#mcp-servers).

An extension that owns `/mcp`, such as `pi-mcp-adapter`, replaces the built-in session connector. Remove or disable it to use native MCP; shell `pi mcp` remains native. Disable native sessions explicitly with `"extensions": ["-builtin:mcp"]` or **Built-in** in `pi config`. Tools named `codemode` or `tool_search` likewise replace the corresponding builtin.

SDK sessions opt into `createMcpExtension()`, codemode, and tool search through the resource loader, then bind extensions. See [SDK](sdk.md#codemode-mcp). Standalone `@earendil-works/pi-mcp` clients connect when the host calls `client.connect()`; CLI lifecycle settings do not govern them.

Native support covers these tool, resource, prompt, result, and browser OAuth workflows. MCP Apps are unsupported. Separately managed ATB/TARS adapter hosts are outside the CLI migration. Importing does not disable or remove an adapter, alter Pi's extension settings, install a runtime, or prove parity for deployed profiles. Before a future cutover, qualify the chosen installed revision against the actual profiles and workflows; expect changed native names and possible initial cache misses.
