import { expect, it, vi } from "vitest";
import { createPreviewUpdater } from "./preview-update.js";

class Block {
    children: Block[] = [];
    parentElement: Block | null = null;
    attrs = new Map<string, string>();
    constructor(public outerHTML: string) {}
    get attributes() {
        return [...this.attrs].map(([name, value]) => ({ name, value }));
    }
    hasAttribute(name: string) {
        return this.attrs.has(name);
    }
    getAttribute(name: string) {
        return this.attrs.get(name) ?? null;
    }
    setAttribute(name: string, value: string) {
        this.attrs.set(name, value);
    }
    removeAttribute(name: string) {
        this.attrs.delete(name);
    }
    get childNodes() {
        return this.children;
    }
    get firstElementChild(): Block | null {
        return this.children[0] ?? null;
    }
    get nextElementSibling(): Block | null {
        const siblings = this.parentElement?.children ?? [];
        return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    querySelector(): Block | null {
        return this.children.find((block) => block.outerHTML === "article") ?? null;
    }
    remove() {
        const siblings = this.parentElement?.children;
        if (siblings) siblings.splice(siblings.indexOf(this), 1);
        this.parentElement = null;
    }
    insertBefore = vi.fn((block: Block, before: Block | null) => {
        block.remove();
        this.children.splice(
            before ? this.children.indexOf(before) : this.children.length,
            0,
            block,
        );
        block.parentElement = this;
    });
    moveBefore = vi.fn((block: Block, before: Block | null) => this.insertBefore(block, before));
    replaceChildren(...children: Block[]) {
        for (const block of [...this.children]) block.remove();
        for (const block of children) this.insertBefore(block, null);
    }
}
const content = (...blocks: string[]) => {
    const root = new Block("root");
    const article = new Block("article");
    article.replaceChildren(...blocks.map((markup) => new Block(markup)));
    article.insertBefore.mockClear();
    root.replaceChildren(article);
    return { root: root as unknown as HTMLElement, article, blocks: [...article.children] };
};

it("keeps unchanged cards stationary when preceding blocks change, are inserted or deleted", () => {
    const { root, article, blocks } = content("intro", "card", "card");
    const update = createPreviewUpdater(root);
    (blocks[1] as Block).outerHTML = "interactive card with draft";
    for (const source of [content("edited", "card", "card"), content("card", "card")]) {
        update(root, source.root);
        expect(article.children.slice(-2)).toEqual(blocks.slice(1));
        expect(article.insertBefore.mock.calls.every(([block]) => !blocks.includes(block))).toBe(
            true,
        );
        expect(article.moveBefore).not.toHaveBeenCalled();
    }
});

it("only replaces changed cards and keeps each duplicate separate", () => {
    const { root, article, blocks } = content("card-a", "card-a", "card-b");
    const update = createPreviewUpdater(root);
    update(root, content("card-a", "card-a", "card-c").root);
    expect(article.children.slice(0, 2)).toEqual(blocks.slice(0, 2));
    expect(blocks[2]?.parentElement).toBeNull();
    article.insertBefore.mockClear();
    update(root, content("card-a", "card-a", "card-c").root);
    expect(article.insertBefore).not.toHaveBeenCalled();
});

it("uses state-preserving moves for reordered blocks", () => {
    const { root, article, blocks } = content("card-a", "card-b");
    createPreviewUpdater(root)(root, content("card-b", "card-a").root);
    expect(article.children).toEqual([blocks[1], blocks[0]]);
    expect(article.moveBefore).toHaveBeenCalledWith(blocks[1], blocks[0]);
});

it("updates article attributes without replacing its unchanged cards", () => {
    const { root, article, blocks } = content("card");
    article.setAttribute("lang", "en");
    article.setAttribute("class", "old");
    const next = content("card");
    next.article.setAttribute("lang", "ja");
    createPreviewUpdater(root)(root, next.root);
    expect(article.attributes).toEqual([{ name: "lang", value: "ja" }]);
    expect(article.children).toEqual(blocks);
    expect(article.insertBefore).not.toHaveBeenCalled();
});

it("remembers newly created panes before their cards mount", () => {
    const initial = content("initial");
    const update = createPreviewUpdater(initial.root);
    const root = new Block("empty") as unknown as HTMLElement;
    const source = content("new card");
    update(root, source.root);
    (source.blocks[0] as Block).outerHTML = "mounted card";
    source.article.insertBefore.mockClear();
    update(root, content("new card").root);
    expect(source.article.children).toEqual(source.blocks);
    expect(source.article.insertBefore).not.toHaveBeenCalled();
});
