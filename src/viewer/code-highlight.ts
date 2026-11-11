import { paintCode } from "./code-fold.js";
import { codeGrammar, codeTheme, codeTokens } from "./code-tokens.js";

const painted = new WeakMap<Element, string>();
const highlight = (): void => {
    for (const block of document.querySelectorAll(".codeblk")) {
        const theme = codeTheme(block);
        const code = block.querySelector("pre code");
        const lang =
            block.getAttribute("data-lang") ??
            block.querySelector(".codeblk-lang")?.textContent ??
            "";
        if (!code) continue;
        const source = code.textContent ?? "";
        const signature = `${theme}\0${lang}\0${source}`;
        if (painted.get(code) === signature) continue;
        painted.set(code, signature);
        void codeTokens(source, lang, theme)
            .then((tokens) => {
                if (!code.isConnected || painted.get(code) !== signature) return;
                paintCode(code, source, codeGrammar(lang)?.name ?? lang, tokens);
            })
            .catch(() => {
                /* Unsupported grammar features leave the original text readable. */
            });
    }
};
new MutationObserver(highlight).observe(document.body, { childList: true, subtree: true });
new MutationObserver(highlight).observe(document.documentElement, {
    attributeFilter: ["data-theme"],
    subtree: true,
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", highlight);
highlight();
