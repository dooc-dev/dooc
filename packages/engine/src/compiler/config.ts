// Loads `<docs root>/docs.config.mjs` (optional): language adapters.
// The file is a JS module, so loading it runs
// its code — it belongs to the docs root like a build config. Read once per process; restart
// after changing it.

import { isLangTag, type LanguageAdapter } from "../core/language.js";
import { existsSync, join, pathToFileURL } from "./host.js";
import { ignoredFiles } from "./ignored-files.js";

export const CONFIG_FILE = "docs.config.mjs";

export interface ResolvedConfig {
    languages: LanguageAdapter[];
}

const FUNCTION_KEYS = ["isTermBoundary", "compareTerms", "lint"] as const;

const checkAdapter = (value: unknown, i: number): LanguageAdapter => {
    const at = `${CONFIG_FILE}: languages[${i}]`;
    if (typeof value !== "object" || value == null || Array.isArray(value)) {
        throw new Error(`${at} must be an object`);
    }
    const a = value as Record<string, unknown>;
    if (typeof a.code !== "string" || !isLangTag(a.code)) {
        throw new Error(`${at}.code must be a BCP 47 language tag`);
    }
    for (const key of FUNCTION_KEYS) {
        if (a[key] !== undefined && typeof a[key] !== "function") {
            throw new Error(`${at}.${key} must be a function`);
        }
    }
    if (a.spellcheckLang !== undefined && typeof a.spellcheckLang !== "string") {
        throw new Error(`${at}.spellcheckLang must be a string`);
    }
    return value as LanguageAdapter;
};

/** Reads docs.config.mjs; defaults when absent. Throws with a readable message when invalid. */
export const loadDocsConfig = async (root: string): Promise<ResolvedConfig> => {
    const file = join(root, CONFIG_FILE);
    if (!existsSync(file) || ignoredFiles(root, [CONFIG_FILE]).has(CONFIG_FILE)) {
        return {
            languages: [],
        };
    }
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    const config = mod.default;
    if (typeof config !== "object" || config == null || Array.isArray(config)) {
        throw new Error(`${CONFIG_FILE}: the default export must be an object`);
    }
    if ("defaultLang" in config) throw new Error(`${CONFIG_FILE}: move defaultLang to dooc.yaml`);
    const { languages } = config as Record<string, unknown>;
    if (languages !== undefined && !Array.isArray(languages)) {
        throw new Error(`${CONFIG_FILE}: languages must be an array`);
    }
    return {
        languages: (languages ?? []).map(checkAdapter),
    };
};
