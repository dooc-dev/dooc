import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, StateEffect } from "@codemirror/state";
import {
    Decoration,
    type DecorationSet,
    type EditorView,
    ViewPlugin,
    type ViewUpdate,
} from "@codemirror/view";
import { workspaceId } from "../../workspace/src/connection.js";
import { codeTheme, codeTokens } from "./code-tokens.js";

export const editorCodeBlocks = (state: EditorState, language?: string) => {
    const blocks: { language: string; source: string; chunks: { from: number; to: number }[] }[] =
        [];
    if (language)
        return [
            { language, source: state.doc.toString(), chunks: [{ from: 0, to: state.doc.length }] },
        ];
    (ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)).iterate({
        enter(node) {
            if (node.name !== "FencedCode") return;
            const info = node.node.getChild("CodeInfo");
            if (!info) return false;
            const chunks = node.node.getChildren("CodeText").map(({ from, to }) => ({ from, to }));
            blocks.push({
                language: state.sliceDoc(info.from, info.to).trim().split(/\s/)[0] ?? "",
                source: chunks.map(({ from, to }) => state.sliceDoc(from, to)).join(""),
                chunks,
            });
            return false;
        },
    });
    return blocks;
};

const repainted = StateEffect.define<null>();
export const editorCodeHighlight = (language?: string, workspace = workspaceId()) =>
    ViewPlugin.fromClass(
        class {
            decorations: DecorationSet = Decoration.none;
            private version = 0;
            private timer: ReturnType<typeof setTimeout> | undefined;
            private observer: MutationObserver;
            private media = matchMedia("(prefers-color-scheme: dark)");
            private repaint = () => this.schedule();
            constructor(private view: EditorView) {
                this.observer = new MutationObserver(this.repaint);
                this.observer.observe(document.documentElement, {
                    attributeFilter: ["data-editor-theme"],
                });
                this.media.addEventListener("change", this.repaint);
                this.schedule();
            }
            update(update: ViewUpdate): void {
                this.decorations = this.decorations.map(update.changes);
                if (update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state))
                    this.schedule();
            }
            private schedule(): void {
                clearTimeout(this.timer);
                const version = ++this.version;
                this.timer = setTimeout(() => {
                    void this.paint(version);
                }, 80);
            }
            private async paint(version: number): Promise<void> {
                const doc = this.view.state.doc;
                const theme = codeTheme(this.view.dom);
                try {
                    const marks: ReturnType<Decoration["range"]>[] = [];
                    for (const block of editorCodeBlocks(this.view.state, language)) {
                        const tokens = await codeTokens(
                            block.source,
                            block.language,
                            theme,
                            workspace,
                        );
                        let sourceOffset = 0;
                        let chunkIndex = 0;
                        let chunkOffset = 0;
                        for (const line of tokens) {
                            for (const token of line) {
                                const end = sourceOffset + token.content.length;
                                while (sourceOffset < end) {
                                    const chunk = block.chunks[chunkIndex];
                                    if (!chunk) break;
                                    const chunkEnd = chunkOffset + chunk.to - chunk.from;
                                    if (sourceOffset >= chunkEnd) {
                                        chunkOffset = chunkEnd;
                                        chunkIndex++;
                                        continue;
                                    }
                                    const to = Math.min(end, chunkEnd);
                                    if (token.color)
                                        marks.push(
                                            Decoration.mark({
                                                class: "cm-code-token",
                                                attributes: { style: `color:${token.color}` },
                                            }).range(
                                                chunk.from + sourceOffset - chunkOffset,
                                                chunk.from + to - chunkOffset,
                                            ),
                                        );
                                    sourceOffset = to;
                                }
                            }
                            sourceOffset++;
                        }
                    }
                    if (
                        version !== this.version ||
                        doc !== this.view.state.doc ||
                        theme !== codeTheme(this.view.dom)
                    )
                        return;
                    // Tokens stay within individual lines, so empty lines retain CodeMirror's layout.
                    this.decorations = Decoration.set(marks, true);
                    this.view.dispatch({ effects: repainted.of(null) });
                } catch {
                    // Unsupported grammar features leave the source editable as plain text.
                }
            }
            destroy(): void {
                this.version++;
                clearTimeout(this.timer);
                this.observer.disconnect();
                this.media.removeEventListener("change", this.repaint);
            }
        },
        { decorations: (plugin) => plugin.decorations },
    );
