import { iso6393To1 } from "iso-639-3";
import eng from "./locales/eng.json" with { type: "json" };
import jpn from "./locales/jpn.json" with { type: "json" };
import zho from "./locales/zho.json" with { type: "json" };

export const messages: Record<string, Record<string, string>> = { eng, jpn, zho };
export const resolveUiLanguage = (tag: string): string => {
    const primary = tag.toLowerCase().split("-")[0] ?? "en";
    return (
        Object.keys(messages).find((code) => code === primary || iso6393To1[code] === primary) ??
        "eng"
    );
};
export const translate = (
    language: string,
    key: string,
    values: Record<string, string | number> = {},
): string => {
    const text =
        messages[resolveUiLanguage(language)]?.[key] ?? eng[key as keyof typeof eng] ?? key;
    return text.replace(/\{(\w+)\}/g, (token, name: string) =>
        Object.hasOwn(values, name) ? String(values[name]) : token,
    );
};

const STORAGE_KEY = "docs:ui-language";
let language = "eng";
export const t = (key: string, values?: Record<string, string | number>): string =>
    translate(language, key, values);

export const applyUiLanguage = (): void => {
    for (const element of document.querySelectorAll("button.codecopy")) {
        element.setAttribute("title", t("Copy code"));
        element.setAttribute("aria-label", t("Copy code"));
    }
    for (const attr of ["text", "title", "aria-label", "placeholder"]) {
        const marker = attr === "text" ? "data-i18n" : `data-i18n-${attr}`;
        for (const element of document.querySelectorAll(`[${marker}]`)) {
            const value = t(element.getAttribute(marker) ?? "");
            if (attr === "text") element.textContent = value;
            else element.setAttribute(attr, value);
        }
    }
};

export const mountUiLanguage = (): void => {
    const select = document.querySelector<HTMLSelectElement>("#ui-language");
    let preferred = navigator.language;
    try {
        preferred = localStorage.getItem(STORAGE_KEY) || preferred;
    } catch {
        /* Storage is optional; switching still works for this session. */
    }
    const apply = (tag: string): void => {
        language = resolveUiLanguage(tag);
        if (select) select.value = language;
        document.documentElement.lang = iso6393To1[language] ?? language;
        applyUiLanguage();
        document.dispatchEvent(new Event("docs:ui-language"));
    };
    (window as Window & { __docsTranslate?: typeof t }).__docsTranslate = t;
    apply(preferred);
    select?.addEventListener("change", () => {
        apply(select.value);
        try {
            localStorage.setItem(STORAGE_KEY, language);
        } catch {
            /* Persistence may be blocked by the browser. */
        }
    });
    document.addEventListener("docs:ui-refresh", applyUiLanguage);
};
