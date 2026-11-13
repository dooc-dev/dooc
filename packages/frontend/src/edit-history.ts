import { history, historyField } from "@codemirror/commands";
import { Annotation, Compartment, EditorState, StateField, Transaction } from "@codemirror/state";

export const HISTORY_MAX_BYTES = 32 * 1024 * 1024;
const historySlot = new Compartment();
const resetBytes = Annotation.define<number>();
const emptyHistory = EditorState.create({ extensions: history() }).field(historyField);

const changeBytes = (transaction: Transaction): number => {
    if (/^(?:select\.)?(?:undo|redo)$/.test(transaction.annotation(Transaction.userEvent) ?? ""))
        return 0;
    if (!transaction.docChanged && !transaction.selection) return 0;
    let bytes = 128 + 32 * transaction.newSelection.ranges.length;
    transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        // Reserve UTF-16 text for both undo and redo, plus estimated change metadata.
        bytes += 64 + 2 * (to - from + inserted.length);
    });
    return bytes;
};

// shortcut: charge all edits until reset; use event-level eviction if retaining partial history is needed.
const historyBytes = StateField.define<number>({
    create: () => 0,
    update: (bytes, transaction) =>
        transaction.annotation(resetBytes) ?? bytes + changeBytes(transaction),
});

export const editorHistory = [
    history({ minDepth: 10_000 }),
    historySlot.of([]),
    historyBytes,
    EditorState.transactionExtender.of((transaction) => {
        const bytes = changeBytes(transaction);
        if (transaction.startState.field(historyBytes) + bytes <= HISTORY_MAX_BYTES) return null;
        const oversized = bytes > HISTORY_MAX_BYTES;
        return {
            effects: historySlot.reconfigure(historyField.init(() => emptyHistory)),
            annotations: [
                resetBytes.of(oversized ? 0 : bytes),
                ...(oversized ? [Transaction.addToHistory.of(false)] : []),
            ],
        };
    }),
];
