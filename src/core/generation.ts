// Generation of the data format recorded in artifact/docs.json; independent of the package
// version. Bump it for changes to the wire contract (including additions) or incompatible
// directive changes. Add a docs-json-schema/<generation>.json and register it in
// docs-json-schema.ts; keep released schemas unchanged.
export const GENERATION = 10;

/**
 * Directional compatibility check: if the consumer's logic generation >= the data generation, it
 * can render fully. If lower, either keep rendering on the assumption that unknown elements
 * degrade to placeholders, or prompt for an update.
 */
export const canRenderGeneration = (consumerGen: number, dataGen: number): boolean =>
    consumerGen >= dataGen;
