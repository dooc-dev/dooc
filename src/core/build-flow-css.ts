// Generator that copies `@xyflow/react/dist/base.css` into a TS constant
// (`flow-base-css.generated.ts`). It runs at the start of every build (`pnpm run build:css`), so
// the published output always carries the same CSS as the installed React Flow. The generated
// file is committed — tsc emits the mount layer (`./flow`) as plain ESM (no bundler), so it
// can't import CSS and the CSS has to live in source as a constant.
// `flow-css.test.ts` detects drift from the installed version.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = "@xyflow/react/dist/base.css";
const OUT = "flow-base-css.generated.ts";

/** Read the base.css (= structure-only stylesheet) of the installed `@xyflow/react`. */
export const readXyflowBaseCss = (): string =>
    readFileSync(createRequire(import.meta.url).resolve(SRC), "utf8");

// Written in a form that matches biome's formatting (so generating doesn't dirty `biome check`).
const HEADER = `// Generated — do not edit by hand (\`pnpm run build:css\` = build-flow-css.ts
// copies it from ${SRC}). A structure-only stylesheet; colors come from
// \`--doc-*\` injected by the consumer (React Flow's default theme = style.css is not included).
`;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const css = readXyflowBaseCss();
    const out = join(dirname(fileURLToPath(import.meta.url)), OUT);
    writeFileSync(out, `${HEADER}export const XYFLOW_BASE_CSS =\n    ${JSON.stringify(css)};\n`);
    console.log(`${OUT} — ${css.length} bytes from ${SRC}`);
}
