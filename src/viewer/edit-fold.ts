import { foldable, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from "@codemirror/language";
import {
    Decoration,
    type DecorationSet,
    type EditorView,
    ViewPlugin,
    type ViewUpdate,
    WidgetType,
} from "@codemirror/view";
import { t } from "./i18n.js";

const createFoldButton = (folded: boolean): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-inline-fold";
    button.setAttribute("aria-expanded", String(!folded));
    button.setAttribute("aria-label", t(folded ? "Expand section" : "Collapse section"));
    button.title = button.getAttribute("aria-label") ?? "";
    button.dataset.i18nTitle = folded ? "Expand section" : "Collapse section";
    button.dataset.i18nAriaLabel = button.dataset.i18nTitle;
    button.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
    button.addEventListener("mousedown", (event) => event.preventDefault());
    return button;
};

export const foldPlaceholder = (
    _view: EditorView,
    onclick: (event: MouseEvent) => void,
): HTMLElement => {
    const button = createFoldButton(true);
    button.addEventListener("click", onclick);
    return button;
};

class FoldButton extends WidgetType {
    constructor(
        readonly from: number,
        readonly to: number,
    ) {
        super();
    }
    override eq(other: FoldButton): boolean {
        return this.from === other.from && this.to === other.to;
    }
    toDOM(view: EditorView): HTMLElement {
        const button = createFoldButton(false);
        button.addEventListener("click", () => {
            view.dispatch({
                effects: foldEffect.of({
                    from: this.from,
                    to: this.to,
                }),
            });
            view.focus();
        });
        return button;
    }
    override ignoreEvent(): boolean {
        return true;
    }
}

export const inlineFoldMarkers = (
    view: Pick<EditorView, "state" | "visibleRanges">,
): DecorationSet => {
    const decorations = [];
    let lastLine = -1;
    for (const visible of view.visibleRanges) {
        for (let pos = visible.from; pos <= visible.to; ) {
            const line = view.state.doc.lineAt(pos);
            if (line.from !== lastLine) {
                let range: { from: number; to: number } | undefined;
                foldedRanges(view.state).between(line.from, line.to, (from, to) => {
                    range = { from, to };
                });
                const folded = Boolean(range);
                range ??= foldable(view.state, line.from, line.to) ?? undefined;
                if (range && !folded)
                    decorations.push(
                        Decoration.widget({
                            widget: new FoldButton(range.from, range.to),
                            side: 1,
                        }).range(line.to),
                    );
                lastLine = line.from;
            }
            pos = line.to + 1;
        }
    }
    return Decoration.set(decorations, true);
};

export const inlineFoldButtons = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
            this.decorations = inlineFoldMarkers(view);
        }
        update(update: ViewUpdate): void {
            if (
                update.docChanged ||
                update.viewportChanged ||
                syntaxTree(update.startState) !== syntaxTree(update.state) ||
                update.transactions.some((tr) =>
                    tr.effects.some((effect) => effect.is(foldEffect) || effect.is(unfoldEffect)),
                )
            )
                this.decorations = inlineFoldMarkers(update.view);
        }
    },
    { decorations: (plugin) => plugin.decorations },
);
