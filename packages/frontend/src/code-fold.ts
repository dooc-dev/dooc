import { isCollection, isNode, isPair, isSeq, parseAllDocuments, visit } from "yaml";

/** Inclusive source-line ranges; the opening line remains visible when folded. */
export const codeFoldRanges = (source: string, language: string): Map<number, number> => {
    const folds = new Map<number, number>();
    // shortcut: Match the 100,000-character highlighting cap; add incremental parsing for larger files.
    if (source.length > 100_000) return folds;
    const lines = source.split("\n");
    const add = (from: number, to: number) => {
        while (to > from && !lines[to]?.trim()) to--;
        if (to > from) folds.set(from, Math.max(to, folds.get(from) ?? 0));
    };
    if (language === "json" || language === "yaml" || language === "yml") {
        const starts = [0];
        for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
        const lineAt = (offset: number) => {
            let lo = 0;
            let hi = starts.length;
            while (lo + 1 < hi) {
                const mid = (lo + hi) >>> 1;
                if ((starts[mid] ?? 0) <= offset) lo = mid;
                else hi = mid;
            }
            return lo;
        };
        const addOffsets = (from: number, end: number) => {
            const to = lineAt(end - 1);
            const suffix = lines[to]?.slice(end - (starts[to] ?? 0)) ?? "";
            add(lineAt(from), /^[\s,}\]]*(?:#.*)?$/.test(suffix) ? to : to - 1);
        };
        for (const doc of parseAllDocuments(source)) {
            if (doc.errors.length) continue;
            visit(doc, (_key, node) => {
                if (isPair(node) && isNode(node.key) && isNode(node.value)) {
                    if (node.key.range && node.value.range)
                        addOffsets(node.key.range[0], node.value.range[1]);
                } else if (isCollection(node) && node.flow && node.range) {
                    addOffsets(node.range[0], node.range[1]);
                }
                if (isSeq(node) && !node.flow)
                    for (const item of node.items)
                        if (isNode(item) && item.range) addOffsets(item.range[0], item.range[1]);
            });
        }
    } else if (language === "toml") {
        const sections: number[] = [];
        const brackets: { char: string; line: number }[] = [];
        let quote = "";
        let stringStart = 0;
        lines.forEach((line, index) => {
            const continuedString = Boolean(quote);
            let plain = "";
            for (let i = 0; i < line.length; i++) {
                const char = line[i] ?? "";
                if (quote) {
                    if (quote[0] === '"' && char === "\\") i++;
                    else if (line.slice(i, i + quote.length) === quote) {
                        if (quote.length === 3) add(stringStart, index);
                        i += quote.length - 1;
                        quote = "";
                    }
                } else if (char === "#") break;
                else if (char === '"' || char === "'") {
                    quote = line.slice(i, i + 3) === char.repeat(3) ? char.repeat(3) : char;
                    stringStart = index;
                    i += quote.length - 1;
                    plain += "x";
                } else plain += char;
            }
            if (!continuedString && !brackets.length && /^\s*\[\[?.+\]\]?\s*$/.test(plain)) {
                sections.push(index);
                return;
            }
            for (const char of plain) {
                if (char === "[" || char === "{") brackets.push({ char, line: index });
                else if (char === "]" || char === "}") {
                    const open = brackets.pop();
                    if (open && (open.char === "[" ? char === "]" : char === "}"))
                        add(open.line, index);
                }
            }
        });
        sections.forEach((from, i) => {
            add(from, (sections[i + 1] ?? lines.length) - 1);
        });
    }
    return folds;
};

const states = new WeakMap<Element, { source: string; language: string; folded: Set<number> }>();

export const paintCode = (
    code: Element,
    source: string,
    language: string,
    tokens: { content: string; color?: string }[][],
): void => {
    const ranges = codeFoldRanges(source, language);
    if (!tokens.length && !ranges.size) return;
    let state = states.get(code);
    if (!state || state.source !== source || state.language !== language) {
        state = { source, language, folded: new Set() };
        states.set(code, state);
    }
    const folded = state.folded;
    const lines = source.split("\n");
    const nodes: Node[] = [];
    const rows: HTMLElement[] = [];
    const apply = () => {
        let hiddenTo = -1;
        rows.forEach((row, index) => {
            row.hidden = index <= hiddenTo;
            row.classList.toggle("code-line-folded", folded.has(index));
            const button = row.querySelector("button");
            if (button) {
                const label = folded.has(index) ? "Expand section" : "Collapse section";
                const translate = (window as Window & { __docsTranslate?: (key: string) => string })
                    .__docsTranslate;
                button.setAttribute("aria-expanded", String(!folded.has(index)));
                button.setAttribute("aria-label", translate?.(label) ?? label);
                button.title = button.getAttribute("aria-label") ?? label;
                button.dataset.i18nTitle = label;
                button.dataset.i18nAriaLabel = label;
            }
            if (folded.has(index)) hiddenTo = Math.max(hiddenTo, ranges.get(index) ?? index);
        });
    };
    lines.forEach((text, index) => {
        const row = document.createElement("span");
        row.className = "code-line";
        const content = document.createElement("span");
        content.className = "code-line-text";
        const lineTokens = tokens[index];
        for (const token of lineTokens?.map((token) => token.content).join("") === text
            ? lineTokens
            : [{ content: text }]) {
            const span = document.createElement("span");
            if (token.color) span.style.color = token.color;
            span.textContent = token.content;
            content.append(span);
        }
        if (ranges.has(index)) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "code-section-fold";
            button.innerHTML =
                '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
            button.addEventListener("click", () => {
                if (!folded.delete(index)) folded.add(index);
                apply();
            });
            row.append(button);
        }
        row.append(content);
        if (index < lines.length - 1) row.append(document.createTextNode("\n"));
        rows.push(row);
        nodes.push(row);
    });
    code.classList.toggle("code-foldable", ranges.size > 0);
    code.replaceChildren(...nodes);
    apply();
};
