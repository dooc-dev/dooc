import { type CompletionContext, snippet } from "@codemirror/autocomplete";
import { linter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { getLanguageService, type JSONSchema } from "vscode-json-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SUBFORMAT_SCHEMA_VERSION } from "../core/subformats.js";
import { schemaBuilder } from "./edit-schema-builder.js";

export const jsonCompletion = (schema?: JSONSchema, schemaDocument = false) => {
    const service = getLanguageService({});
    const uri = "file:///document.json";
    service.configure({
        allowComments: false,
        schemas: schemaDocument
            ? [{ uri: SUBFORMAT_SCHEMA_VERSION, fileMatch: [uri] }]
            : schema
              ? [{ uri: "file:///record.schema.json", fileMatch: [uri], schema }]
              : [],
    });
    return async (context: CompletionContext) => {
        const before = context.state.sliceDoc(0, context.pos);
        if (!context.explicit && !/["\w$:{,\s]$/.test(before)) return null;
        const document = TextDocument.create(uri, "json", 0, context.state.doc.toString());
        const result = await service.doComplete(
            document,
            document.positionAt(context.pos),
            service.parseJSONDocument(document),
        );
        if (context.aborted || !result?.items.length) return null;
        const items = result.items.filter((item) => {
            const edit = item.textEdit;
            const range = edit && ("range" in edit ? edit.range : edit.replace);
            const prefix = range
                ? before.slice(document.offsetAt(range.start)).replace(/^"/, "")
                : "";
            return item.label.replace(/^"/, "").toLowerCase().startsWith(prefix.toLowerCase());
        });
        if (!items.length) return null;
        return {
            from: context.pos,
            filter: false,
            options: items.map((item) => {
                const edit = item.textEdit;
                const range = edit && ("range" in edit ? edit.range : edit.replace);
                const from = range ? document.offsetAt(range.start) : context.pos;
                const to = range ? document.offsetAt(range.end) : context.pos;
                const text = edit?.newText ?? item.insertText ?? item.label;
                const description = item.documentation;
                return {
                    label: item.label,
                    detail: item.detail,
                    info: typeof description === "string" ? description : description?.value,
                    type: item.kind === 10 ? "property" : "value",
                    apply: (view: import("@codemirror/view").EditorView) => {
                        if (view.state.doc !== context.state.doc) return;
                        if (item.insertTextFormat === 2) {
                            // CodeMirror uses ${n} tab stops; the language service also emits $n.
                            snippet(
                                text.replace(
                                    /\\([$}\\])|\$(\d+)/g,
                                    (_match, escaped, n) => escaped ?? `\${${n}}`,
                                ),
                            )(view, { label: item.label }, from, to);
                        } else view.dispatch({ changes: { from, to, insert: text } });
                    },
                };
            }),
        };
    };
};

export const jsonEditor = (schema?: JSONSchema, schemaDocument = false) => {
    const completion = jsonCompletion(schema, schemaDocument);
    return [
        schemaDocument ? schemaBuilder : [],
        EditorState.languageData.of(() => [{ autocomplete: completion }]),
        linter(async (view) => {
            const content = view.state.doc.toString();
            let message: string | undefined;
            try {
                JSON.parse(content);
                if (schemaDocument) {
                    const response = await fetch("/api/subformat", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ action: "validate", content }),
                    });
                    const result = await response.json();
                    if (!response.ok) message = result.error;
                }
            } catch (error) {
                message = error instanceof Error ? error.message : String(error);
            }
            if (!message) return [];
            const offset = Math.min(
                content.length,
                Number(/position (\d+)/.exec(message)?.[1] ?? 0),
            );
            return [
                {
                    from: offset,
                    to: Math.min(offset + 1, content.length),
                    severity: "error" as const,
                    message,
                },
            ];
        }),
    ];
};
