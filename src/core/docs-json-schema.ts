// Versioned wire contracts. Keep released schemas unchanged and append new generations here.
import { Ajv, type SchemaObject } from "ajv";
import schema10 from "./docs-json-schema/10.json" with { type: "json" };
import schema11 from "./docs-json-schema/11.json" with { type: "json" };
import schema12 from "./docs-json-schema/12.json" with { type: "json" };
import schema13 from "./docs-json-schema/13.json" with { type: "json" };
import schema14 from "./docs-json-schema/14.json" with { type: "json" };
import schema15 from "./docs-json-schema/15.json" with { type: "json" };
import schema16 from "./docs-json-schema/16.json" with { type: "json" };
import schema17 from "./docs-json-schema/17.json" with { type: "json" };
import { GENERATION } from "./generation.js";

const schemas = [schema10, schema11, schema12, schema13, schema14, schema15, schema16, schema17];
const ajv = new Ajv({ allErrors: true }).addSchema(schemas);

/** Bundled schema versions, in ascending order (independent of the package version). */
export const listDocsJsonSchemas = (): number[] =>
    schemas.map((schema) => schema.properties.generation.const).sort((a, b) => a - b);

/** A self-contained JSON Schema, suitable for any draft-07 validator. */
export const getDocsJsonSchema = (
    version: number | string = "latest",
): SchemaObject & { $id: string } => {
    const selected = version === "latest" ? String(GENERATION) : String(version);
    const schema = schemas.find((s) => String(s.properties.generation.const) === selected);
    if (!schema) {
        throw new Error(
            `Unknown docs.json schema version "${version}". Available: ${listDocsJsonSchemas().join(", ")}`,
        );
    }
    return schema;
};

/** Validate against the artifact's generation. Returns errors (empty on success); never mutates data. */
export const validateDocsArtifact = (value: unknown): string[] => {
    const generation =
        value !== null && typeof value === "object" && "generation" in value
            ? value.generation
            : undefined;
    if (typeof generation !== "number" || !Number.isInteger(generation)) {
        return ["docs.json/generation: must be an integer"];
    }
    const schema = schemas.find((s) => s.properties.generation.const === generation);
    if (!schema) {
        return [
            `docs.json/generation: unsupported schema version ${String(generation)} (available: ${listDocsJsonSchemas().join(", ")})`,
        ];
    }
    const validate = ajv.getSchema(schema.$id);
    if (!validate) throw new Error(`Missing validator for ${schema.$id}`);
    return validate(value)
        ? []
        : (validate.errors ?? []).map(
              (error) => `docs.json${error.instancePath}: ${error.message}`,
          );
};
