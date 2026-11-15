// Validate every record of every type registered in dooc.yaml and print them as JSON.
// usage: node records.mjs [dooc.yaml] [ext]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

const manifest = resolve(process.argv[2] ?? "dooc.yaml");
const only = process.argv[3];
const root = dirname(manifest);
const read = (file) => readFileSync(join(root, file), "utf8");
const parsers = { yaml: parseYaml, toml: parseToml, json: JSON.parse };

// dooc.yaml is the single source: extension, storage format, and schema path per record type.
const types = (parseYaml(readFileSync(manifest, "utf8")).json_subformats ?? []).filter(
    (type) => !only || type.ext === only,
);
if (!types.length) throw new Error(`No record type${only ? ` "${only}"` : "s"} in ${manifest}`);

// A $ref to another schema file is loaded on demand, relative to the referring schema.
const ajv = new Ajv({ allErrors: true, loadSchema: async (path) => JSON.parse(read(path)) });
addFormats(ajv);

const skipped = /^(?:\.git|node_modules|dist|themes|locales)(?:\/|$)/;
const files = readdirSync(root, { recursive: true })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !skipped.test(file))
    .sort();

const records = [];
let failed = 0;
for (const { ext, format, schema } of types) {
    // A schema already loaded through another type's $ref is reused.
    const validate =
        ajv.getSchema(schema) ??
        (await ajv.compileAsync({ ...JSON.parse(read(schema)), $id: schema }));
    for (const file of files.filter((name) => name.endsWith(`.${ext}`))) {
        try {
            const data = parsers[format](read(file));
            if (!validate(data)) throw new Error(ajv.errorsText(validate.errors));
            records.push({ type: ext, file, data });
        } catch (error) {
            failed += 1;
            console.error(`${file}: ${error.message}`);
        }
    }
}
console.log(JSON.stringify(records));
process.exitCode = failed ? 1 : 0;
