// Built-in language adapters for the Node tools (viewer / CLI / MCP): the browser-safe core
// adapters plus their Node-only prose lint. docs.config.mjs adapters take precedence.

import type { LanguageRegistration } from "shiki/core";
import { loadCodeLanguages } from "../../engine/src/compiler/code-languages.js";
import { loadDocsConfig } from "../../engine/src/compiler/config.js";
import type { LanguageAdapter } from "../../engine/src/core/language.js";
import { ja } from "../../engine/src/core/languages/ja.js";
import { allowsWorkspaceCode } from "./workspace-trust.js";

export const BUILTIN_LANGUAGES: readonly LanguageAdapter[] = [
    // textlint is heavy; load it on the first lint request.
    { ...ja, lint: async (body) => (await import("./ja-lint.js")).lintJa(body) },
];

export interface SiteLanguages {
    languages: readonly LanguageAdapter[];
    codeLanguages?: string[];
    codeGrammars?: LanguageRegistration[];
}

export const DEFAULT_SITE_LANGUAGES: SiteLanguages = {
    languages: BUILTIN_LANGUAGES,
};

/** docs.config.mjs + built-ins (configured adapters first, so they override a built-in code). */
export const loadSiteLanguages = async (root: string): Promise<SiteLanguages> => {
    const config = allowsWorkspaceCode() ? await loadDocsConfig(root) : { languages: [] };
    return {
        ...(await loadCodeLanguages(root)),
        languages: [...config.languages, ...BUILTIN_LANGUAGES],
    };
};
