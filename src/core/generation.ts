// Generation of the data format recorded in artifact/docs.json; independent of the package
// version. Bump it for changes to the wire contract (including additions) or incompatible
// directive changes. Add a docs-json-schema/<generation>.json and register it in
// docs-json-schema.ts; keep released schemas unchanged.
export const GENERATION = 17;

/**
 * Generation 11 introduces term IDs; generation 17 replaces their inline syntax with file links.
 * Consumers can render their own or earlier generations within each compatible format family.
 */
export const canRenderGeneration = (consumerGen: number, dataGen: number): boolean =>
    consumerGen >= dataGen &&
    [11, 17].every((version) => consumerGen >= version === dataGen >= version);
