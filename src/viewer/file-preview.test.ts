import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { compileSite } from "../compiler/compile.js";
import { filePreviewState, setFilePreviews } from "./edit-file-preview.js";
import { fileReferences } from "./file-references.js";
import { filePreviewResults, siteFrom } from "./serve.js";

describe("file preview indicators", () => {
    it("finds text, HTML and figure references without treating examples as references", () => {
        expect(
            fileReferences(
                [
                    "![](<./examples/日本語 & file.txt#L2>)",
                    "![](figures/card.html)",
                    "![Caption](figures/flow.drawio.svg)",
                    "```md",
                    "![](figures/hidden.html)",
                    "```",
                    "```grapth",
                    "![](figures/hidden.svg)",
                    "```",
                    "    ![](hidden.txt)",
                    "![]()",
                ].join("\n"),
            ),
        ).toEqual([
            { line: 1, file: "examples/日本語 & file.txt", kind: "textfile" },
            { line: 2, file: "figures/card.html", kind: "html" },
            { line: 3, file: "figures/flow.drawio.svg", kind: "figure" },
        ]);
    });

    it("scopes missing files, HTML validation and range failures to their own file", () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-file-preview-"));
        mkdirSync(join(root, "content"));
        mkdirSync(join(root, "figures"));
        writeFileSync(join(root, "manifest.yaml"), "- page\n");
        writeFileSync(join(root, "ok.txt"), "Original text\n");
        writeFileSync(join(root, "range.txt"), "Only one line");
        writeFileSync(join(root, "figures/good.html"), "<!--fig\ntitle: Good\n-->\n<p>Good</p>");
        writeFileSync(join(root, "figures/bad.html"), "<p>Missing metadata</p>");
        writeFileSync(
            join(root, "figures/image.svg"),
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Image</title></svg>',
        );
        writeFileSync(
            join(root, "content/page.md"),
            [
                "---",
                "title: Files",
                "---",
                "",
                "![](./ok.txt)",
                "",
                "![](missing.txt)",
                "",
                "![](range.txt#L10)",
                "",
                "![](range.txt)",
                "",
                "![](figures/good.html)",
                "",
                "![](figures/bad.html)",
                "",
                "![](figures/image.svg)",
                "",
                "![](figures/missing.png)",
                "",
            ].join("\n"),
        );
        const site = siteFrom(compileSite(root), []);
        const entry = site.entries[0];
        if (!entry) throw new Error("Missing fixture document");
        const previews = filePreviewResults(entry, site);
        expect(previews["ok.txt"]).toEqual([]);
        expect(previews["figures/good.html"]).toEqual([]);
        expect(previews["figures/image.svg"]).toEqual([]);
        expect(previews["missing.txt"]).toEqual(["File not found"]);
        expect(previews["figures/missing.png"]).toEqual(["File not found"]);
        expect(previews["figures/bad.html"]?.join()).toContain("meta comment");
        expect(previews["range.txt"]).toHaveLength(1);
        expect(previews["range.txt"]?.join()).toContain("range line 10 does not exist");
        writeFileSync(
            join(root, "content/page.md"),
            "---\ntitle: Files\n---\n\n![](figures/image.svg#bad)\n\n![](figures/good.html)\n",
        );
        const invalidSite = siteFrom(compileSite(root), []);
        const invalidEntry = invalidSite.entries[0];
        if (!invalidEntry) throw new Error("Missing fixture document");
        const invalid = filePreviewResults(invalidEntry, invalidSite);
        expect(invalid["figures/image.svg"]?.join()).toContain("Use #L10");
        expect(invalid["figures/good.html"]).toEqual([]);
        writeFileSync(
            join(root, "content/page.md"),
            "---\ntitle: Files\n---\n\n:::callout\n![](figures/good.html)\n:::\n",
        );
        const nestedSite = siteFrom(compileSite(root), []);
        const nestedEntry = nestedSite.entries[0];
        if (!nestedEntry) throw new Error("Missing fixture document");
        expect(nestedEntry.errors.join()).toContain("standalone paragraph");
        expect(filePreviewResults(nestedEntry, nestedSite)["figures/good.html"]).toBeUndefined();
    });

    it("shares status between references, survives edits and keeps each editor's state separate", () => {
        let state = EditorState.create({
            doc: "![](__proto__)\n![](figures/card.html)\n![](figures/card.html)\n",
            extensions: [filePreviewState],
        });
        expect(state.field(filePreviewState).decorations.size).toBe(3);
        const old = state;
        state = state.update({
            effects: setFilePreviews.of({
                "figures/card.html": { state: "error", message: "Missing" },
            }),
        }).state;
        const widgets: string[] = [];
        state
            .field(filePreviewState)
            .decorations.between(0, state.doc.length, (_from, _to, decoration) => {
                widgets.push((decoration.spec.widget as { label: string }).label);
            });
        expect(widgets.filter((label) => label.endsWith("\nMissing"))).toHaveLength(2);
        expect(old.field(filePreviewState).previews).toEqual({});
        state = state.update({ changes: { from: 0, to: state.doc.line(1).to + 1 } }).state;
        expect(state.field(filePreviewState).decorations.size).toBe(2);
        expect(state.field(filePreviewState).previews["figures/card.html"]?.state).toBe("error");
    });
});
