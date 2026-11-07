import { createHighlighterCore, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

let grammars: LanguageRegistration[] | undefined;
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
const codeGrammars = (): LanguageRegistration[] =>
    (grammars ??= JSON.parse(document.getElementById("code-grammars")?.textContent ?? "[]"));

export const codeTheme = (element?: Element): string => {
    const choice = element?.closest("#panel")
        ? document.documentElement.dataset.editorTheme
        : (element?.closest<HTMLElement>("[data-theme]")?.dataset.theme ??
          document.documentElement.dataset.theme);
    return choice === "dark" ||
        ((!choice || choice === "auto") && matchMedia("(prefers-color-scheme: dark)").matches)
        ? "github-dark"
        : "github-light";
};

/** Preview and both editors use the same registered grammars and colors. */
export const codeTokens = async (source: string, language: string, theme?: string) => {
    // Large sources remain plain text so tokenization cannot stall either editor or the preview.
    if (source.length > 100_000 || source.split("\n").some((line) => line.length > 10_000))
        return [];
    const grammar = codeGrammars().find(
        (entry) => entry.name === language || entry.aliases?.includes(language),
    );
    if (!grammar) return [];
    highlighter ??= createHighlighterCore({
        langs: codeGrammars(),
        themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
        engine: createJavaScriptRegexEngine(),
    });
    return (await highlighter).codeToTokens(source, {
        lang: grammar.name,
        theme: theme ?? codeTheme(),
    }).tokens;
};
