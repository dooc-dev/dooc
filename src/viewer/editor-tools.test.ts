import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportEntries } from "../compiler/export.js";
import { codeBlockAt, isLocalToolRequest, runCodeTool } from "./editor-tools.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(formatter: string, linter = "require('node:fs').writeSync(1,'[]')") {
    const root = await mkdtemp(join(tmpdir(), "editor-tools-"));
    roots.push(root);
    const dir = join(root, ".document-system/editor-tools");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "format.cjs"), formatter);
    await writeFile(join(dir, "lint.cjs"), linter);
    await writeFile(
        join(dir, "js.json"),
        JSON.stringify({
            formatter: [process.execPath, join(dir, "format.cjs")],
            linter: [process.execPath, join(dir, "lint.cjs")],
        }),
    );
    return root;
}
const body = "# Title\n\n```js\nconst x=1\n```\n\nAfter\n";
const position = body.indexOf("const");

describe("code tool virtual blocks", () => {
    it("selects the current block and maps CRLF/indentation without touching prose", () => {
        const text = "before\r\n  ~~~js\r\n  x()\r\n y()\r\n  ~~~\r\nafter";
        const block = codeBlockAt(text, text.indexOf("x()"));
        expect(block.code).toBe("x()\ny()");
        expect(block.offsets).toEqual([text.indexOf("x()"), text.indexOf("y()")]);
        expect(block.eol).toBe("\r\n");
        expect(text.slice(block.from, block.to)).toBe("  x()\r\n y()\r\n");
    });
    it("does not treat fence-looking prose or open/nested code as replaceable", () => {
        expect(() => codeBlockAt(body, 2)).toThrow("cursor");
        expect(() => codeBlockAt("```js\nx()", 7)).toThrow("Close");
        expect(() => codeBlockAt("> ```js\n> x()\n> ```", 10)).toThrow("top-level");
        expect(() => codeBlockAt(body, NaN)).toThrow("position");
    });
    it("handles an empty fence and picks the second of multiple fences", () => {
        expect(codeBlockAt("```js\n```", 4).code).toBe("");
        const text = `${body}~~~py\nprint(1)\n~~~`;
        expect(codeBlockAt(text, text.indexOf("print")).language).toBe("py");
    });
});

describe("external editor tools", () => {
    it("includes editor configuration and adapters in source exports", async () => {
        const root = await fixture("");
        expect(exportEntries(root).map((entry) => entry.name)).toEqual([
            ".document-system/editor-tools/format.cjs",
            ".document-system/editor-tools/js.json",
            ".document-system/editor-tools/lint.cjs",
        ]);
    });
    it("refuses empty formatter output instead of deleting code", async () => {
        const root = await fixture("");
        await expect(runCodeTool(root, body, position, "format")).rejects.toThrow("empty output");
    });
    it("formats stdin with only the code body replaced", async () => {
        const root = await fixture(
            "const s=require('node:fs').readFileSync(0,'utf8');require('node:fs').writeSync(1,s.replace('x=1','x = 1;'))",
        );
        const result = await runCodeTool(root, body, position, "format");
        expect(result.change).toEqual({
            from: position,
            to: body.indexOf("```", position),
            insert: "const x = 1;\n",
        });
    });
    it("preserves CRLF and indentation", async () => {
        const root = await fixture("require('node:fs').writeSync(1,'x();\\n')");
        const text = "  ```js\r\n  x()\r\n  ```";
        const result = await runCodeTool(root, text, text.indexOf("x()"), "format");
        expect(result.change?.insert).toBe("  x();\r\n");
    });
    it("maps diagnostics into the Markdown and accepts lint exit 1", async () => {
        const root = await fixture(
            "",
            "require('node:fs').writeSync(1,JSON.stringify([{message:'Missing spaces',line:1,column:8,endLine:1,endColumn:9,severity:'warning'}]));process.exitCode=1",
        );
        const result = await runCodeTool(root, body, position, "lint");
        expect(result.findings).toEqual([
            { message: "Missing spaces", range: [position + 7, position + 8], ruleId: "warning" },
        ]);
    });
    it("rejects missing configuration, malformed diagnostics, and invalid coordinates", async () => {
        const root = await fixture(
            "",
            'require("node:fs").writeSync(1,\'[{"message":"bad","line":99,"column":1}]\')',
        );
        await expect(runCodeTool(root, body, position, "lint")).rejects.toThrow("position");
        await expect(
            runCodeTool(root, body.replace("```js", "```unknown"), position, "format"),
        ).rejects.toThrow("configure");
        const malformed = await fixture("", "require('node:fs').writeSync(1,'not JSON')");
        await expect(runCodeTool(malformed, body, position, "lint")).rejects.toThrow();
    });
    it("rejects failed tools and output that would close the fence", async () => {
        const root = await fixture(
            "require('node:fs').writeSync(2,'formatter failed');process.exitCode=2",
        );
        await expect(runCodeTool(root, body, position, "format")).rejects.toThrow(
            "formatter failed",
        );
        const fence = await fixture("require('node:fs').writeSync(1,'```\\n')");
        await expect(runCodeTool(fence, body, position, "format")).rejects.toThrow(
            "close the code fence",
        );
    });
});

describe("local code-tool request boundary", () => {
    it("requires local host, matching Origin, and JSON", () => {
        expect(
            isLocalToolRequest("127.0.0.1:5199", "http://127.0.0.1:5199", "application/json"),
        ).toBe(true);
        expect(
            isLocalToolRequest(
                "[::1]:5199",
                "http://[::1]:5199",
                "application/json; charset=utf-8",
            ),
        ).toBe(true);
        expect(
            isLocalToolRequest("localhost:5199", "https://example.com", "application/json"),
        ).toBe(false);
        expect(
            isLocalToolRequest("evil.example:5199", "http://evil.example:5199", "application/json"),
        ).toBe(false);
        expect(isLocalToolRequest("localhost:5199", undefined, "application/json")).toBe(false);
        expect(isLocalToolRequest("localhost:5199", "http://localhost:5199", "text/plain")).toBe(
            false,
        );
    });
});
