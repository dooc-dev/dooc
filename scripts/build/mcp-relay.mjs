import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../../", import.meta.url);
await build({
    entryPoints: [fileURLToPath(new URL("packages/server/src/mcp-relay-entry.ts", root))],
    outfile: fileURLToPath(new URL("dist/mcp-relay.mjs", root)),
    platform: "node",
    format: "esm",
    target: "node22",
    bundle: true,
});
