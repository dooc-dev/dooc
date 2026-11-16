Build or run the editor and reader as selected components. These commands create or serve an application; [publishing a document](contents/md/publishing.md) creates an HTML or source bundle instead.

For everyday local authoring, use `dooc editor`; use `dooc reader` for read-only access. These are aliases for `dooc editor run node --all` and `dooc reader run node --all`. They open `dooc.yaml` in the current directory and start all three components on port `3000`. Override defaults with options such as `dooc editor --port 4000 --project docs/dooc.yaml` or `dooc reader --no-mcp`. Use this page when you need separate hosting, a browser-only workspace or explicit component selection.

## Command structure

```text
dooc <editor|reader> <build|run> <node|web> [components] [options]
```

| Axis | Choice | Meaning |
| ---- | ------ | ------- |
| Product | `editor` | Edit a workspace |
| Product | `reader` | Read a workspace; backend and MCP operations must enforce read-only access |
| Action | `build` | Write the selected components as artifacts, then exit |
| Action | `run` | Start the selected components |
| Runtime | `node` | Run the workspace backend in Node |
| Runtime | `web` | Run the workspace backend in a browser Worker |

The runtime names describe where the workspace backend executes. A Node backend can run on the same computer or on another host. The frontend runs in the browser in either case and is distributed as static assets. A `run web` command may use Node to serve those assets while the workspace backend runs in the browser. There is no CSR/SSR mode switch.

dooc remains one installation. Users can deploy its Node components in their own containers or host the generated frontend files independently.

## Components

| Flag | `node` | `web` |
| ---- | ------ | ----- |
| `--client` | Static frontend for a Node workspace connection | Static frontend for a browser workspace |
| `--server` | Node workspace backend, with a WebSocket service when run | Workspace backend in a browser Worker |
| `--mcp` | MCP interface over HTTP or stdio | Connector to a Desktop or hosted MCP relay |

For `build`, these flags select the code and assets included in the output. For `run`, they select the components to activate. A build does not start listeners. In the Node runtime, MCP can use workspace operations without enabling the WebSocket service; `--mcp` does not implicitly enable `--server`.

For explicit `build`/`run` commands, all components default to off. The `dooc editor [options]` and `dooc reader [options]` shortcuts supply `run node --all` when no action or runtime is given. `--all` selects all three, and `--no-client`, `--no-server`, or `--no-mcp` overrides `--all` regardless of argument order. If the effective selection is empty, report that a component is required and exit without building or starting anything.

| Selection | Client | Server | MCP |
| --------- | ------ | ------ | --- |
| Explicit `build`/`run`, no component flags | Off | Off | Off |
| `dooc editor` or `dooc reader` shortcut | On | On | On |
| `--client` | On | Off | Off |
| `--server --mcp` | Off | On | On |
| `--all` | On | On | On |
| `--all --no-mcp` | On | On | Off |

Web MCP requires `--client` and `--server`. Without `--relay-url`, connect through a Desktop integration; add `--relay-url <https-origin>` for a hosted relay. Use `web --all --no-mcp` when no relay connection is needed. `run web --server` requires `--client` to serve the Worker; `build web --server` can emit the Worker on its own. A web client built without its Worker needs the Worker to be supplied separately before it can open a workspace.

## Component options

| Option | Applies to | Meaning |
| ------ | ---------- | ------- |
| `--mcp-transport stdio\|http` | Node `--mcp` | Connection transport; default `http`; preserved in Node builds |
| `--project <path>` | Node backend or MCP | Workspace folder or manifest; default `./dooc.yaml` |
| `--port <port>` | `run` | Shared port, from `1` through `65535`; default `3000` |
| `--out <directory>` | `build` | Empty output directory; default `./dooc-<editor\|reader>-<node\|web>` |
| `--server-url <ws-url>` | Node client | Backend address; default `ws://localhost:<port>/server` |
| `--relay-url <https-origin>` | Web MCP | Optional hosted relay origin; omit for Desktop connections |
| `--client-origin <origin>` | Node backend | Exact permitted browser origin; default `http://localhost:<port>` |
| `--reader-plugins <module>` | Node backend or MCP | Workspace plugin module; MCP uses its Git origin |
| `--repo <git-url>` | `run node` backend or MCP | Clone Git and resolve `--project` inside the repository |
| `--tls-cert <pem> --tls-key <pem>` | `run node` | HTTPS and secure WebSockets; defaults from `DOOC_TLS_CERT` and `DOOC_TLS_KEY` |
| `--shared <branch>` | `editor run node --server` | Shared-workspace identity and snapshots on the named branch; cannot use `--mcp` |

Client-only and web commands do not read a Node workspace. Choose a folder or saved browser workspace in the web client. Editor web clients also support creating and cloning browser workspaces. Reader clients request read-only folder access and cannot create, clone, edit, or switch branches. A Node reader client requires a read-only Node backend.

## Run port and paths

`run --port <port>` selects one port; the default is `3000`. The Node runtime separates components by path so document routes cannot collide with backend endpoints:

| Component | Path | Default URL | With `--port 4000` |
| --------- | ---- | ----------- | ------------------ |
| Client HTTP | `/client/` | `http://localhost:3000/client/` | `http://localhost:4000/client/` |
| Workspace WebSocket | `/server` | `ws://localhost:3000/server` | `ws://localhost:4000/server` |
| MCP HTTP | `/mcp` | `http://localhost:3000/mcp` | `http://localhost:4000/mcp` |

Disabled components leave their routes unavailable. When the client is enabled, `/` redirects to `/client/`. A document named `mcp` or `server` remains under `/client/mcp` or `/client/server` and does not occupy an API endpoint. The client origin is the origin alone, such as `http://localhost:3000`, without `/client/`.

The Node client opens its configured server workspace directly. Editor and reader servers watch document changes and update the open page automatically. Application source hot reload is enabled by the development tasks `mise run editor` and `mise run reader`; regular `dooc` commands keep watching document data only.

HTTP MCP uses stateless Streamable HTTP: JSON replies to POST requests, no session ID, and no GET/SSE stream. Supported protocol versions are `2025-03-26`, `2025-06-18`, and `2025-11-25`. Select `--mcp-transport stdio` for local MCP hosts. Stdio uses stdin/stdout for protocol messages and stderr for logs, with the same editor/reader permissions and reader publication selection as HTTP.

A Node run selecting only `--mcp --mcp-transport stdio` opens no port. It rejects `--port`, `--client-origin` and explicit TLS settings, and ignores HTTP TLS environment defaults. Stdio can run alongside selected client/server components; those components still use the shared HTTP port, while `/mcp` stays unavailable. Closing stdin or receiving a shutdown signal releases all selected components and temporary workspaces. Web MCP uses its relay connector and does not accept `--mcp-transport`.

All listeners bind to loopback. The workspace socket requires the configured client origin; MCP accepts local requests without an Origin header or with an Origin matching its HTTP origin. Use `localhost` consistently, or set `--client-origin` explicitly. If the port cannot be opened, the command releases its workspace service and exits.

The web runtime serves its static client at `/` on the selected port. Its workspace backend is a browser Worker and has no WebSocket endpoint. With `--mcp`, its browser connector receives and answers requests over HTTPS through the configured relay.

## Examples

```sh
dooc editor run node --all
dooc editor run node --all --project ./dooc-docs --port 4000
dooc editor run node --server --mcp --port 4000
dooc editor run node --mcp --mcp-transport stdio --project ./dooc-docs
dooc reader run node --mcp --mcp-transport stdio --project ./dooc-docs
dooc editor build node --server --mcp
dooc editor build web --client --server
dooc editor build web --all --relay-url https://relay.example.com
dooc editor run web --all --no-mcp --port 4000
dooc reader run node --all
dooc reader build web --client --server
```

The reader's read-only restriction applies to its backend and MCP operations as well as its UI. Building a web frontend and Worker produces static files; serving them does not require a Node workspace backend.

## Build output

`build` never starts a listener or copies the workspace's documents. Existing nonempty output directories are rejected without overwriting their files. Build the client and Worker together for a browser-only application:

```sh
dooc editor build web --client --server --out ./public-editor
dooc reader build web --client --server --out ./public-reader
```

Serve static output at the host root with document routes falling back to `index.html`; missing `/assets/*` and `/api/*` requests must remain 404s. When client and Worker are built separately, place the Worker at `assets/workspace-worker.js` and set `worker` to `true` in the client's `dooc-client.json`.

Node builds that select `--server` or `--mcp` include `start.mjs` and `package.json`. The launcher runs the selected components using the same version of `@dooc-dev/dooc`; install that version's package before starting it. Client assets are included under `client/` only when selected, with document routes falling back to `client/index.html`. The launcher serves `/client/` using assets from its installed dooc dependency; the exported `client/` directory can also be hosted independently. Supply the workspace separately, for example through a container volume:

```sh
dooc editor build node --all --out ./editor-service
cd editor-service
npm install
node start.mjs --project /path/to/documents --port 4000
```

For an unreleased source build, install the matching local package instead of the published package. A build-time `--project` or `--reader-plugins` path is stored as an absolute path in the launcher; provide a run-time override when deploying elsewhere. Node client-only builds contain a `client/` directory of static assets and no launcher; host that directory at `/client/`. `dooc build html` and `dooc build zip` still produce document bundles; the component build commands produce applications.

## Separate server and client

Select only the components needed by each process. The server's permitted origin must match the client:

```sh
dooc editor run node --server --project ./dooc.yaml --port 3000 --client-origin http://localhost:3001
dooc editor run node --client --port 3001 --server-url ws://localhost:3000/server
```

Open `http://localhost:3001/client/`. The server exposes only `/server` over WebSocket. Both listeners bind to loopback. Use `localhost` consistently, or configure `127.0.0.1` explicitly.

To deploy a client for a Node backend, build its static assets and host the output's `client/` directory at `/client/`:

```sh
dooc editor build node --client --out ./public-editor --server-url wss://workspace.example/server
```

For a browser workspace with no Node backend, build the client and Worker together:

```sh
dooc editor build web --client --server --out ./public-editor
```

Host web output at the host root. Document routes must fall back to `index.html`; missing `/assets/*` and `/api/*` paths must remain 404s. An HTTPS frontend needs a secure WebSocket endpoint. A reverse proxy must preserve the browser's `Origin` and send a loopback `Host` header to the workspace server.

## MCP connections

`dooc editor run node --mcp --mcp-transport stdio` serves an existing workspace; use `reader` for read-only publication access. `dooc relay --stdio` starts a Desktop-managed loopback relay for a browser workspace; relay is included in dooc. Hosted relays are deployed separately from the static application. See [Web MCP and Desktop connections](contents/md/web-mcp.md) for pairing, deployment, permissions and tab lifetime.
