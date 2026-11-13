/** Reconcile server navigation while retaining the user's tree and controls. */
export const updateNav = (root: HTMLElement, html: string): void => {
    const template = root.ownerDocument.createElement("template");
    template.innerHTML = html;
    const key = (node: Node): string | undefined => {
        if (!(node instanceof HTMLElement)) return;
        if (node.dataset.docId) return `doc:${node.dataset.docId}`;
        if (node.dataset.nodeId) return `tool:${node.dataset.nodeId}`;
        if (node.id) return `id:${node.id}`;
        if (node.matches(".nav-list[data-parent]")) return `list:${node.dataset.parent}`;
    };
    const keyed = new Map<string, Node>();
    for (const node of root.querySelectorAll("[id], [data-doc-id], [data-node-id], .nav-list")) {
        const id = key(node);
        if (id) keyed.set(id, node);
    }
    const active = root.contains(document.activeElement) ? document.activeElement : null;
    const scroll = [
        root.parentElement,
        root.querySelector("#nav-docs"),
        root.querySelector(".nav-tool-cards"),
    ]
        .filter((node): node is HTMLElement => node instanceof HTMLElement)
        .map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
    const used = new Set<Node>();
    const removed: { parent: Node; node: ChildNode }[] = [];
    const sameType = (a: Node, b: Node): boolean =>
        a.nodeType === b.nodeType &&
        (!(a instanceof Element) ||
            (b instanceof Element &&
                a.localName === b.localName &&
                a.namespaceURI === b.namespaceURI));
    const patch = (parent: Node, source: Node): void => {
        const previous = [...parent.childNodes];
        let cursor = parent.firstChild;
        for (const next of source.childNodes) {
            const id = key(next);
            const candidate = id
                ? keyed.get(id)
                : previous.find(
                      (node) =>
                          !used.has(node) &&
                          !key(node) &&
                          !(node instanceof Element && node.matches(".nav-new-item")) &&
                          sameType(node, next),
                  );
            const current =
                candidate && !used.has(candidate) && sameType(candidate, next)
                    ? candidate
                    : next.cloneNode(false);
            used.add(current);
            if (current !== cursor) {
                const container = parent as HTMLElement & {
                    moveBefore?: (node: Node, before: Node | null) => void;
                };
                if (current.isConnected && container.isConnected && container.moveBefore)
                    container.moveBefore(current, cursor);
                else parent.insertBefore(current, cursor);
            }
            if (current instanceof Element && next instanceof Element) {
                const fresh = current !== candidate;
                for (const name of new Set([
                    ...current.getAttributeNames(),
                    ...next.getAttributeNames(),
                ])) {
                    if (
                        !fresh &&
                        (name === "inert" ||
                            (name === "open" && current.localName === "details") ||
                            (name === "style" && current.matches(".nav-list")) ||
                            (name === "aria-expanded" && current.matches(".nav-tree-toggle")))
                    )
                        continue;
                    let value = next.getAttribute(name);
                    if (!fresh && name === "class" && current.matches(".nav-item")) {
                        const classes = new Set((value ?? "").split(/\s+/).filter(Boolean));
                        for (const state of ["open", "nav-ancestor", "dragging"])
                            if (current.classList.contains(state)) classes.add(state);
                            else classes.delete(state);
                        value = [...classes].join(" ");
                    }
                    if (value === current.getAttribute(name)) continue;
                    if (value === null) current.removeAttribute(name);
                    else current.setAttribute(name, value);
                }
                if (current instanceof HTMLTemplateElement && next instanceof HTMLTemplateElement) {
                    if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
                } else if (!current.matches(".files-upload-status")) patch(current, next);
            } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
            cursor = current.nextSibling;
        }
        for (const node of previous)
            if (!used.has(node) && !(node instanceof Element && node.matches(".nav-new-item")))
                removed.push({ parent, node });
    };
    patch(root, template.content);
    // Reparent descendants before deleting their old branch.
    for (const { parent, node } of removed)
        if (node.parentNode === parent && !used.has(node)) node.remove();
    if (active instanceof HTMLElement && active.isConnected && document.activeElement !== active)
        active.focus({ preventScroll: true });
    for (const { node, top, left } of scroll) {
        if (node.scrollTop !== top) node.scrollTop = top;
        if (node.scrollLeft !== left) node.scrollLeft = left;
    }
};
