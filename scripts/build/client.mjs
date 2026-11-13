import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../../", import.meta.url);
export const browserBuild = {
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    minifyWhitespace: true,
    minifySyntax: true,
    // Page event handlers are serialized with toString(), so their local names must survive.
    minifyIdentifiers: false,
    inject: [fileURLToPath(new URL("packages/workspace/src/browser-globals.ts", root))],
    alias: {
        "node:buffer": "buffer",
        "node:events": "events",
        "node:path": "path-browserify",
        "node:stream": "readable-stream",
        "node:url": fileURLToPath(new URL("packages/workspace/src/browser-url.ts", root)),
    },
    plugins: [
        {
            name: "browser-host",
            setup(context) {
                context.onResolve({ filter: /^decode-named-character-reference$/ }, (args) => ({
                    path: createRequire(args.importer).resolve(args.path),
                }));
                context.onResolve({ filter: /(?:^|\/)host\.js$/ }, (args) => {
                    if (args.importer.includes("/packages/"))
                        return {
                            path: fileURLToPath(
                                new URL("packages/workspace/src/browser-host.ts", root),
                            ),
                        };
                });
            },
        },
    ],
};

export const buildBrowserWorkspace = (options = {}) =>
    build({
        ...browserBuild,
        entryPoints: [fileURLToPath(new URL("packages/frontend/src/workspace-worker.ts", root))],
        outfile: fileURLToPath(new URL("dist/workspace-worker.global.js", root)),
        ...options,
    });

export const buildClientEntry = (options = {}) =>
    build({
        entryPoints: [fileURLToPath(new URL("packages/frontend/src/client-entry.ts", root))],
        outfile: fileURLToPath(new URL("dist/client.global.js", root)),
        bundle: true,
        platform: "browser",
        target: "es2022",
        format: "iife",
        minify: true,
        ...options,
    });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
    await Promise.all([buildBrowserWorkspace(), buildClientEntry()]);
