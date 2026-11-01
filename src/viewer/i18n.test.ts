import { describe, expect, it } from "vitest";
import { messages, resolveUiLanguage, translate } from "./i18n.js";

describe("editor UI catalogs", () => {
    it("has matching translation keys for every supported ISO 639-3 language", () => {
        expect(Object.keys(messages)).toEqual(["eng", "jpn", "zho"]);
        for (const catalog of Object.values(messages)) {
            expect(Object.keys(catalog).sort()).toEqual(Object.keys(messages.eng ?? {}).sort());
            expect(Object.values(catalog).every((value) => value.trim())).toBe(true);
        }
    });
    it("maps browser language preferences, falls back, and substitutes values as text", () => {
        expect(resolveUiLanguage("ja-JP")).toBe("jpn");
        expect(resolveUiLanguage("zh-CN")).toBe("zho");
        expect(resolveUiLanguage("jpn")).toBe("jpn");
        expect(resolveUiLanguage("fr")).toBe("eng");
        expect(translate("jpn", "Save")).toBe("保存");
        expect(translate("zho", "Save")).toBe("保存");
        expect(translate("eng", "Saved {time}", { time: "10:00" })).toBe("Saved 10:00");
        expect(translate("jpn", "Unknown diagnostic")).toBe("Unknown diagnostic");
    });
});
