export const createPreviewUpdater = (root: ParentNode) => {
    // Compare source markup before interactive cards and diagrams mutate their DOM.
    const markup = new WeakMap<Element, string>();
    const remember = (source: ParentNode): void => {
        for (const block of source.querySelector("article")?.children ?? [])
            markup.set(block, block.outerHTML);
    };
    remember(root);
    return (target: HTMLElement, source: ParentNode): void => {
        const current = target.querySelector("article");
        const next = source.querySelector("article");
        if (!current || !next) {
            remember(source);
            target.replaceChildren(...source.childNodes);
            return;
        }
        for (const { name } of [...current.attributes])
            if (!next.hasAttribute(name)) current.removeAttribute(name);
        for (const { name, value } of next.attributes)
            if (current.getAttribute(name) !== value) current.setAttribute(name, value);
        const available = new Map<string, Element[]>();
        for (const block of current.children) {
            const key = markup.get(block);
            if (key === undefined) continue;
            const matches = available.get(key) ?? [];
            matches.push(block);
            available.set(key, matches);
        }
        const desired = [...next.children].map((block) => {
            const key = block.outerHTML;
            const reused = available.get(key)?.shift() ?? block;
            markup.set(reused, key);
            return reused;
        });
        const keep = new Set(desired);
        // Remove obsolete blocks first so an earlier edit never moves an unchanged iframe.
        for (const block of [...current.children]) if (!keep.has(block)) block.remove();
        let cursor = current.firstElementChild;
        for (const block of desired) {
            if (block !== cursor) {
                const parent = current as Element & {
                    moveBefore?: (node: Node, before: Node | null) => void;
                };
                if (block.parentElement === current && parent.moveBefore)
                    parent.moveBefore(block, cursor);
                // shortcut: older browsers reload reordered frames; drop the fallback when moveBefore is widely supported.
                else current.insertBefore(block, cursor);
            }
            cursor = block.nextElementSibling;
        }
    };
};
