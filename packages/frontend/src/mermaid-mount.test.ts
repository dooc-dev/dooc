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

it("maps doc tokens onto Mermaid theme variables", async () => {
    const { mermaidThemeVariables } = await import("./mermaid-mount.js");
    const tokens: Record<string, string> = { bg: "#101316", fg: "#f5f6f7", accent: "#e65100" };
    const variables = mermaidThemeVariables((name) => tokens[name] ?? "", true);
    expect(variables).toMatchObject({
        darkMode: true,
        background: "#101316",
        primaryTextColor: "#f5f6f7",
        primaryColor: "#101316",
        pie1: "#e65100",
    });
    expect(variables).not.toHaveProperty("pie2");
    expect(mermaidThemeVariables(() => "", false)).toBeUndefined();
});
