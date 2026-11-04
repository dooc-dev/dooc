// Generation of the data format recorded in artifact/docs.json; independent of the package
// version. Bump it for changes to the wire contract (including additions) or incompatible
// directive changes. Add a docs-json-schema/<generation>.json and register it in
// docs-json-schema.ts; keep released schemas unchanged.
export const GENERATION = 13;

/**
 * Generation 11 replaces dictionaries with ID-based terms. Older artifacts need migration;
 * within each compatible format family, consumers can render their own or earlier generations.
 */
export const canRenderGeneration = (consumerGen: number, dataGen: number): boolean =>
    consumerGen >= dataGen && consumerGen >= 11 === dataGen >= 11;
