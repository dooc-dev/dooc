// Browser-safe Japanese language adapter. Prose lint is attached by the viewer.
import type { LanguageAdapter } from "../language.js";

export const ja: LanguageAdapter = {
    code: "ja",
    // Browsers do not spellcheck Japanese; check embedded English words instead.
    spellcheckLang: "en",
};
