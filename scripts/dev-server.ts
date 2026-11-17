import { parseApplicationOptions, runApplication } from "../packages/server/src/application.js";

const [product, project, port] = process.argv.slice(2);
if (
    process.argv.length !== 5 ||
    (product !== "editor" && product !== "reader") ||
    !project ||
    !port
)
    throw new Error("Expected editor or reader, a development workspace and port");
const options = parseApplicationOptions(product, [
    "--project",
    project,
    "--port",
    port,
    "--reader-plugins",
    "./sample/examples/reader-plugins/index.mjs",
]);
if (!options) throw new Error("Missing development options");
const running = await runApplication(options, true);
for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void running.close());
