import { type EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, lineNumberMarkers } from "@codemirror/view";
import { diffLines } from "diff";

export const setGitBase = StateEffect.define<string | null>();
export const gitBaseState = StateField.define<string | null>({
    create: () => null,
    update: (base, transaction) => {
        const change = transaction.effects.find((effect) => effect.is(setGitBase));
        return change ? change.value : base;
    },
});

class DiffMarker extends GutterMarker {
    override elementClass: string;
    constructor(readonly kind: string) {
        super();
        this.elementClass = `cm-git-${kind}`;
    }
    override eq(other: DiffMarker): boolean {
        return this.kind === other.kind;
    }
}

const decorations = (state: EditorState): RangeSet<GutterMarker> => {
    const base = state.field(gitBaseState);
    if (base === null) return RangeSet.empty;
    // shortcut: skip expensive diffs after 40ms; move to a worker if large documents need them.
    const changes = diffLines(base, state.doc.toString(), { stripTrailingCr: true, timeout: 40 });
    const marks: ReturnType<GutterMarker["range"]>[] = [];
    let line = 1;
    for (const [index, change] of (changes ?? []).entries()) {
        if (change.removed) {
            if (!changes?.[index + 1]?.added) {
                const edge = line > state.doc.lines ? "end" : "start";
                marks.push(
                    new DiffMarker(`deleted-${edge}`).range(
                        state.doc.line(Math.min(line, state.doc.lines)).from,
                    ),
                );
            }
            continue;
        }
        if (change.added) {
            const kind = changes?.[index - 1]?.removed ? "modified" : "added";
            for (let offset = 0; offset < change.count; offset++)
                marks.push(new DiffMarker(kind).range(state.doc.line(line + offset).from));
        }
        line += change.count;
    }
    return RangeSet.of(marks, true);
};

export const gitDiffState = StateField.define<RangeSet<GutterMarker>>({
    create: decorations,
    update: (value, transaction) =>
        transaction.docChanged || transaction.effects.some((effect) => effect.is(setGitBase))
            ? decorations(transaction.state)
            : value,
    provide: (field) => [
        lineNumberMarkers.from(field),
        EditorView.decorations.compute([field], (state) => {
            const lines: ReturnType<Decoration["range"]>[] = [];
            for (const cursor = state.field(field).iter(); cursor.value; cursor.next())
                lines.push(
                    Decoration.line({ class: cursor.value.elementClass }).range(cursor.from),
                );
            return Decoration.set(lines);
        }),
    ],
});

export const gitDiffTheme = EditorView.baseTheme({
    ".cm-lineNumbers .cm-git-added": { boxShadow: "inset -1.5px 0 #2ea043" },
    ".cm-lineNumbers .cm-git-modified": { boxShadow: "inset -1.5px 0 #d88a18" },
    ".cm-lineNumbers .cm-git-deleted-start, .cm-lineNumbers .cm-git-deleted-end": {
        boxShadow: "inset -1.5px 0 #e5534b",
    },
    ".cm-line.cm-git-added": { backgroundColor: "#2ea04310" },
    ".cm-line.cm-git-modified": { backgroundColor: "#d88a1814" },
    ".cm-line.cm-git-deleted-start, .cm-line.cm-git-deleted-end": { backgroundColor: "#e5534b10" },
});
