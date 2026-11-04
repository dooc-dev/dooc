import { codeTheme, codeTokens } from "./code-tokens.js";

const painted = new WeakMap<Element, string>();
const highlight = (): void => {
    const theme = codeTheme();
    for (const block of document.querySelectorAll(".codeblk")) {
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
        void codeTokens(source, lang)
            .then((tokens) => {
                if (!tokens.length || !code.isConnected || painted.get(code) !== signature) return;
                const nodes: Node[] = [];
                tokens.forEach((line, index) => {
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
