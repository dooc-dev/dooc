import { workspaceId } from "../../workspace/src/connection.js";
import { paintCode } from "./code-fold.js";
import { codeGrammar, codeTheme, codeTokens } from "./code-tokens.js";

const painted = new WeakMap<Element, string>();
const visible = new Map<Element, boolean>();
const visibility = new IntersectionObserver(
    (entries) => {
        for (const entry of entries) visible.set(entry.target, entry.isIntersecting);
        highlight();
    },
    { rootMargin: "200px" },
);
const highlight = (): void => {
    for (const block of visible.keys())
        if (!block.isConnected) {
            visibility.unobserve(block);
            visible.delete(block);
        }
    for (const block of document.querySelectorAll(".codeblk")) {
        if (!visible.has(block)) {
            visible.set(block, false);
            visibility.observe(block);
        }
        if (!visible.get(block)) continue;
        const theme = codeTheme(block);
        const workspace =
            block.closest<HTMLElement>("[data-workspace]")?.dataset.workspace ?? workspaceId();
        const code = block.querySelector("pre code");
        const lang =
            block.getAttribute("data-lang") ??
            block.querySelector(".codeblk-lang")?.textContent ??
            "";
        if (!code) continue;
        const source = code.textContent ?? "";
        const signature = `${workspace}\0${theme}\0${lang}\0${source}`;
        if (painted.get(code) === signature) continue;
        painted.set(code, signature);
        void codeTokens(source, lang, theme, workspace)
            .then((tokens) => {
                if (!code.isConnected || painted.get(code) !== signature) return;
                paintCode(code, source, codeGrammar(lang, workspace)?.name ?? lang, tokens);
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
