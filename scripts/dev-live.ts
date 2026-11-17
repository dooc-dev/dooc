import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDevWorkspace, watchDevWorkspace } from "./dev-workspace.js";

const [product = "all", port = product === "reader" ? "2001" : "2000", readerPort = "2001"] =
    process.argv.slice(2);
if (
    (product !== "all" && product !== "editor" && product !== "reader") ||
    process.argv.length > (product === "all" ? 5 : 4)
)
    throw new Error("Expected all, editor or reader followed by its ports");
const applications =
    product === "all"
        ? [
              { product: "editor", port },
              { product: "reader", port: readerPort },
          ]
        : [{ product, port }];
if (
    applications.some(({ port }) => !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
)
    throw new Error("Choose ports between 1 and 65535");
if (new Set(applications.map(({ port }) => Number(port))).size !== applications.length)
    throw new Error("Editor and reader need different ports");

const root = fileURLToPath(
    new URL(`../build/dev/${product === "all" ? "workspace" : product}/`, import.meta.url),
);
createDevWorkspace(root);
const watcher = watchDevWorkspace(root);
const servers = applications.map(({ product, port }) =>
    spawn(
        process.execPath,
        [
            createRequire(import.meta.url).resolve("tsx/cli"),
            "watch",
            "--clear-screen=false",
            "--include",
            "./packages/frontend/src/**",
            "--include",
            "./packages/workspace/src/**",
            "scripts/dev-server.ts",
            product,
            root,
            port,
        ],
        {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            stdio: "inherit",
            env: { ...process.env, DOOC_USER_DIR: join(root, ".dooc/user") },
        },
    ),
);
const stop = (signal: NodeJS.Signals = "SIGTERM") => {
    watcher.close();
    for (const server of servers) server.kill(signal);
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(signal));
for (const server of servers) {
    server.on("error", (error) => {
        console.error(error);
        process.exitCode = 1;
        stop();
    });
    server.on("exit", (code, signal) => {
        process.exitCode ||= code ?? (signal === "SIGINT" ? 130 : signal ? 1 : 0);
        stop();
    });
}
