import { getLanguageService } from "vscode-json-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";

export const formatJson = (content: string): string => {
    JSON.parse(content);
    const document = TextDocument.create("file:///document.json", "json", 0, content);
    const edits = getLanguageService({}).format(document, undefined, {
        tabSize: 2,
        insertSpaces: true,
        eol: content.includes("\r\n") ? "\r\n" : "\n",
    });
    return TextDocument.applyEdits(document, edits);
};
