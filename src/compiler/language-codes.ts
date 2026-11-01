import { iso6393, iso6393To1 } from "iso-639-3";

const codes = new Map(iso6393.map((language) => [language.iso6393, language.name]));
const from1 = new Map(Object.entries(iso6393To1).map(([three, two]) => [two, three]));

export const isContentLanguage = (code: string): boolean => codes.has(code);

/** Accept legacy source-language tags while storing all translation catalogs under ISO 639-3. */
export const contentLanguageCode = (tag: string): string => {
    const primary = tag.toLowerCase().split("-")[0] ?? "";
    const code = from1.get(primary) ?? primary;
    if (!isContentLanguage(code)) throw new Error(`Unknown ISO 639-3 language: ${tag}`);
    return code;
};

export const webLanguage = (code: string): string => iso6393To1[code] ?? code;

export const languageName = (code: string): string => {
    try {
        return (
            new Intl.DisplayNames([webLanguage(code)], { type: "language" }).of(
                webLanguage(code),
            ) ??
            codes.get(code) ??
            code
        );
    } catch {
        return codes.get(code) ?? code;
    }
};
