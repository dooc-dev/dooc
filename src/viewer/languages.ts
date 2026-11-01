// Built-in language adapters for the Node tools (viewer / CLI / MCP): the browser-safe core
// adapters plus their Node-only prose lint. docs.config.mjs adapters take precedence.

import { loadDocsConfig } from "../compiler/config.js";
import { DEFAULT_LANG, type LanguageAdapter } from "../core/language.js";
import { ja } from "../core/languages/ja.js";

export const BUILTIN_LANGUAGES: readonly LanguageAdapter[] = [
    // textlint is heavy; load it on the first lint request.
    { ...ja, lint: async (body) => (await import("./ja-lint.js")).lintJa(body) },
];

export interface SiteLanguages {
    defaultLang: string;
    languages: readonly LanguageAdapter[];
}

export const DEFAULT_SITE_LANGUAGES: SiteLanguages = {
    defaultLang: DEFAULT_LANG,
    languages: BUILTIN_LANGUAGES,
};

/** docs.config.mjs + built-ins (configured adapters first, so they override a built-in code). */
export const loadSiteLanguages = async (root: string): Promise<SiteLanguages> => {
    const config = await loadDocsConfig(root);
    return {
        defaultLang: config.defaultLang,
        languages: [...config.languages, ...BUILTIN_LANGUAGES],
    };
};
