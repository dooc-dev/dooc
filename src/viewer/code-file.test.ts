import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compileSite } from "../compiler/compile.js";
import { codeFilePlan } from "../core/code-file.js";
import { codeFileResponse } from "./code-file.js";

const roots: string[] = [];
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-code-file-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "manifest.yaml"), "files: {defaultLayout: true}\ndocs: [a]\n");
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each([
    ["ts", "const x = 1;"],
    ["termth", "name: API\ndefinition: Contract"],
    ["grapth", "[A]: A\n[B]: B\n[A] -> [B]"],
])("extracts %s to the default folder and keeps its rendered block", (lang, source) => {
    const root = fixture();
    const body = `\`\`\`${lang}\n${source}\n\`\`\``;
    writeFileSync(join(root, "content/a.md"), `---\ntitle: A\n---\n\n${body}\n`);
    const before = compileSite(root).artifact.docs[0]?.blocks[0];
    const result = codeFileResponse(root, { body, position: 2, documentId: "a" });
    expect(result.status).toBe(200);
    if (!("file" in result.body) || !result.body.file || !("change" in result.body))
        throw new Error("missing result");
    const { file, change } = result.body;
    expect(file).toBe(`files/${lang}/a-1.${lang}`);
    expect(readFileSync(join(root, file), "utf8")).toBe(`${source}\n`);
    writeFileSync(
        join(root, "content/a.md"),
        `---\ntitle: A\n---\n\n${body.slice(0, change.from)}${change.insert}${body.slice(change.to)}\n`,
    );
    const built = compileSite(root);
    expect(built.errors).toEqual([]);
    expect(built.artifact.docs[0]?.blocks[0]?.type).toBe(before?.type);
    const again = codeFileResponse(root, { body, position: 2, documentId: "a" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ file: `files/${lang}/a-1-2.${lang}` });
});
it("preserves CRLF content and isolates HTML source with a line fragment", () => {
    const plan = codeFilePlan(
        "before\r\n```html\r\n<p>x</p>\r\n```\r\nafter",
        10,
        "files/html/a.html",
    );
    expect(plan.content).toBe("<p>x</p>\r\n");
    expect(plan.change.insert).toBe("\r\n![](files/html/a.html#L1)\r\n");
});
it("rejects unclosed, nested and conflicting extraction without overwriting bytes", () => {
    expect(() => codeFilePlan("```ts\nlet x=1", 2, "x.ts")).toThrow();
    expect(() => codeFilePlan("> ```ts\n> 1\n> ```", 4, "x.ts")).toThrow();
    const root = fixture();
    writeFileSync(join(root, "x.ts"), Buffer.from([255, 0]));
    expect(
        codeFileResponse(root, { body: "```ts\n1\n```", position: 2, file: "x.ts" }).status,
    ).toBe(409);
    expect(readFileSync(join(root, "x.ts"))).toEqual(Buffer.from([255, 0]));
    expect(
        codeFileResponse(root, { body: "```ts\n1\n```", position: 2, file: "../outside.ts" })
            .status,
    ).toBe(400);
});
