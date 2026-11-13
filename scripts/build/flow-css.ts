// Generator that copies `@xyflow/react/dist/base.css` into a TS constant
// (`flow-base-css.generated.ts`). It runs at the start of every build (`pnpm run build:css`), so
// the published output always carries the same CSS as the installed React Flow. The generated
// file is committed — tsc emits the mount layer (`./flow`) as plain ESM (no bundler), so it
// can't import CSS and the CSS has to live in source as a constant.
// `flow-css.test.ts` detects drift from the installed version.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const SRC = "@xyflow/react/dist/base.css";
const OUT = new URL("../../packages/frontend/src/flow-base-css.generated.ts", import.meta.url);

/** Read the base.css (= structure-only stylesheet) of the installed `@xyflow/react`. */
export const readXyflowBaseCss = (): string =>
    readFileSync(createRequire(import.meta.url).resolve(SRC), "utf8");

// Written in a form that matches biome's formatting (so generating doesn't dirty `biome check`).
const HEADER = `// Generated — do not edit by hand (\`pnpm run build:css\` = scripts/build/flow-css.ts
// copies it from ${SRC}). A structure-only stylesheet; colors come from
// \`--doc-*\` injected by the consumer (React Flow's default theme = style.css is not included).
`;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const css = readXyflowBaseCss();
    writeFileSync(OUT, `${HEADER}export const XYFLOW_BASE_CSS =\n    ${JSON.stringify(css)};\n`);
    console.log(`flow-base-css.generated.ts — ${css.length} bytes from ${SRC}`);
}
