import { createHighlighterCore, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

let grammars: LanguageRegistration[] | undefined;
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
const codeGrammars = (): LanguageRegistration[] =>
    (grammars ??= JSON.parse(document.getElementById("code-grammars")?.textContent ?? "[]"));

export const codeTheme = (): string => {
    const choice = document.documentElement.dataset.theme;
    return choice === "dark" || (!choice && matchMedia("(prefers-color-scheme: dark)").matches)
        ? "github-dark"
        : "github-light";
};

/** Preview and both editors use the same registered grammars and colors. */
export const codeTokens = async (source: string, language: string) => {
    const grammar = codeGrammars().find(
        (entry) => entry.name === language || entry.aliases?.includes(language),
    );
    if (!grammar) return [];
    highlighter ??= createHighlighterCore({
        langs: codeGrammars(),
        themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
        engine: createJavaScriptRegexEngine(),
    });
    return (await highlighter).codeToTokens(source, { lang: grammar.name, theme: codeTheme() })
        .tokens;
};
