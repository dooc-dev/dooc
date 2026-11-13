// Pins what each package may depend on. Test files are exempt (fixtures may reach anywhere), and
// so are type-only imports (they vanish at build time).
//   engine    : nothing else; the platform only through compiler/host.ts
//   plugins   : nothing else
//   workspace : engine
//   frontend  : engine, workspace, plugins
//   server    : everything (it serves the frontend and hosts the workspace)
import { readdirSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const ALLOWED: Record<string, string[]> = {
    engine: [],
    plugins: [],
    workspace: ["engine"],
    frontend: ["engine", "workspace", "plugins"],
    server: ["engine", "workspace", "frontend", "plugins"],
};
// The engine's door to the platform (public-file.ts is part of that door).
const HOST = [
    "packages/engine/src/compiler/host.ts",
    "packages/engine/src/compiler/public-file.ts",
];

const root = new URL("../../", import.meta.url);
const sources = (pkg: string): string[] => {
    const directory = pkg === "plugins" ? "plugins/src" : `packages/${pkg}/src`;
    return readdirSync(new URL(directory, root), { recursive: true, encoding: "utf8" })
        .map((file) => `${directory}/${file.replaceAll("\\", "/")}`)
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.|\.d\.ts$/.test(file));
};
/** Module specifiers of value imports and re-exports. */
const imports = (file: string): string[] =>
    [
        ...readFileSync(new URL(file, root), "utf8").matchAll(
            /^(?:import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)";|\bimport\("([^"]+)"\)/gms,
        ),
    ].flatMap((match) => (match[1] ? [] : [match[2] ?? match[3] ?? ""]));

describe("layers", () => {
    for (const [pkg, allowed] of Object.entries(ALLOWED)) {
        it(`${pkg} imports only ${allowed.join(", ") || "itself"}`, () => {
            const others = Object.keys(ALLOWED).filter((p) => p !== pkg && !allowed.includes(p));
            const bad = sources(pkg).flatMap((file) =>
                imports(file)
                    .filter((spec) => others.some((other) => spec.includes(`/${other}/src/`)))
                    .map((spec) => `${file} -> ${spec}`),
            );
            expect(bad).toEqual([]);
        });
    }

    it.each([
        "engine",
        "workspace",
        "frontend",
        "plugins",
    ])("%s does not import Node built-ins", (pkg) => {
        const bad = sources(pkg)
            .filter((file) => !HOST.includes(file))
            .filter((file) => imports(file).some((spec) => spec.startsWith("node:")));
        expect(bad).toEqual([]);
    });

    it("the engine bundles for a browser once the host is substituted", async () => {
        const names = [
            ...readFileSync(new URL(HOST[0] ?? "", root), "utf8").matchAll(/export \{([^}]+)\}/g),
        ].flatMap((match) => (match[1] ?? "").split(",").map((name) => name.trim()));
        const result = await build({
            entryPoints: sources("engine")
                .filter((file) => !HOST.includes(file))
                .map((file) => new URL(file, root).pathname),
            bundle: true,
            write: false,
            platform: "browser",
            format: "esm",
            outdir: "out",
            logLevel: "silent",
            plugins: [
                {
                    name: "host",
                    setup(setup) {
                        setup.onLoad({ filter: /compiler[\\/]host\.ts$/ }, () => ({
                            contents: names
                                .filter(Boolean)
                                .map((name) => `export const ${name} = undefined;`)
                                .join("\n"),
                        }));
                    },
                },
            ],
        }).catch((error: { errors?: { text: string }[] }) => ({
            errors: error.errors ?? [{ text: String(error) }],
        }));
        expect(result.errors.map((error) => error.text)).toEqual([]);
    }, 60_000);
});
