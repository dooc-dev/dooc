import { createHighlighterCore, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const grammars = JSON.parse(
    document.getElementById("code-grammars")?.textContent ?? "[]",
) as LanguageRegistration[];
const known = new Set(grammars.flatMap((grammar) => [grammar.name, ...(grammar.aliases ?? [])]));
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
const painted = new WeakMap<Element, string>();
const highlight = (): void => {
    const choice = document.documentElement.dataset.theme;
    const dark =
        choice === "dark" || (!choice && matchMedia("(prefers-color-scheme: dark)").matches);
    const theme = dark ? "github-dark" : "github-light";
    for (const block of document.querySelectorAll(".codeblk")) {
        const code = block.querySelector("pre code");
        const lang = block.querySelector(".codeblk-lang")?.textContent ?? "";
        if (!code || !known.has(lang)) continue;
        const source = code.textContent ?? "";
        const signature = `${theme}\0${lang}\0${source}`;
        if (painted.get(code) === signature) continue;
        painted.set(code, signature);
        highlighter ??= createHighlighterCore({
            langs: grammars,
            themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
            engine: createJavaScriptRegexEngine(),
        });
        void highlighter
            .then((hl) => {
                if (!code.isConnected || painted.get(code) !== signature) return;
                const nodes: Node[] = [];
                hl.codeToTokens(source, { lang, theme }).tokens.forEach((line, index) => {
                    if (index) nodes.push(document.createTextNode("\n"));
                    for (const token of line) {
                        const span = document.createElement("span");
                        if (token.color) span.style.color = token.color;
                        span.textContent = token.content;
                        nodes.push(span);
                    }
                });
                code.replaceChildren(...nodes);
            })
            .catch(() => {
                /* Unsupported grammar features leave the original text readable. */
            });
    }
};
new MutationObserver(highlight).observe(document.body, { childList: true, subtree: true });
new MutationObserver(highlight).observe(document.documentElement, {
    attributeFilter: ["data-theme"],
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", highlight);
highlight();
