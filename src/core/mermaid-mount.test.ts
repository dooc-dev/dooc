import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it.each(["iife", "esm"] as const)("excludes elkjs from the %s diagram bundle", async (format) => {
    const { metafile } = await build({
        entryPoints: [fileURLToPath(new URL("./schema-graph-global.tsx", import.meta.url))],
        bundle: true,
        format,
        splitting: format === "esm",
        target: "es2022",
        minify: true,
        outdir: "dist/graph",
        write: false,
        metafile: true,
    });
    expect(Object.keys(metafile.inputs).filter((file) => file.includes("/elkjs/"))).toEqual([]);
});
