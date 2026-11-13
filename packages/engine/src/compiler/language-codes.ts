import { iso6393, iso6393To1 } from "iso-639-3";

export { contentLanguageCode, isContentLanguage } from "../core/language.js";

export const contentLanguages = iso6393
    .map(({ iso6393: code, name }) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

const codes = new Map(iso6393.map((language) => [language.iso6393, language.name]));

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
