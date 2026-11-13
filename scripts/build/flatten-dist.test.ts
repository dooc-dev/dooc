import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("flattens package and SDK paths, including nested imports and declarations", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-dist-"));
    const fixtures = [
        ["packages/engine/src/index.js", "export const engine = true;", "engine/index.js"],
        ["plugins/src/index.js", "export const sdk = true;", "plugins/index.js"],
        [
            "packages/server/src/index.js",
            'export * from "../../engine/src/index.js";\nexport * from "../../../plugins/src/index.js";',
            "server/index.js",
        ],
        [
            "packages/server/src/plugins/runtime.d.ts",
            'export * from "../../../../plugins/src/index.js";',
            "server/plugins/runtime.d.ts",
        ],
    ] as const;
    try {
        for (const [source, contents] of fixtures) {
            if (source.startsWith("packages/")) {
                mkdirSync(join(root, source.split("/").slice(0, 2).join("/")), { recursive: true });
            }
            const file = join(root, "dist", source);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, contents);
        }
        execFileSync(
            process.execPath,
            [fileURLToPath(new URL("flatten-dist.mjs", import.meta.url))],
            {
                cwd: root,
            },
        );
        for (const [, , output] of fixtures)
            expect(readFileSync(join(root, "dist", output), "utf8")).toBeTruthy();
        expect(readFileSync(join(root, "dist/server/index.js"), "utf8")).toBe(
            'export * from "../engine/index.js";\nexport * from "../plugins/index.js";',
        );
        expect(readFileSync(join(root, "dist/server/plugins/runtime.d.ts"), "utf8")).toBe(
            'export * from "../../plugins/index.js";',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
