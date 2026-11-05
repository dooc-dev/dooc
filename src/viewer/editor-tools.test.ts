import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportEntries } from "../compiler/export.js";
import {
    codeBlockAt,
    isLocalToolRequest,
    runCodeTool,
    validateCodeTools,
    validateTextfileCode,
} from "./editor-tools.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(formatter: string, linter = "require('node:fs').writeSync(1,'[]')") {
    const root = await mkdtemp(join(tmpdir(), "editor-tools-"));
    roots.push(root);
    const dir = join(root, ".dooc/editor-tools");
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

describe("complete text file tools", () => {
    it("uses the registered formatter and preserves line endings and embedded fence text", async () => {
        const root = await fixture(
            "const fs=require('node:fs');fs.writeSync(1,fs.readFileSync(0,'utf8').replace('x=1','x = 1;'))",
        );
        for (const content of ["const x=1\n// ```\n", "const x=1\r\n// ```\r\n", "const x=1"]) {
            expect(await validateTextfileCode(root, "js", content)).toEqual({
                content: content.replace("x=1", "x = 1;"),
                findings: [],
            });
        }
        expect(await validateTextfileCode(root, "unconfigured", "a\n\n")).toEqual({
            content: "a\n\n",
            findings: [],
        });
    });
    it("keeps invalid code untouched, maps diagnostics to the file, and rejects empty output", async () => {
        const root = await fixture(
            "throw Error('must not run')",
            "process.stdout.write(JSON.stringify([{line:1,column:1,endLine:1,endColumn:4,message:'Invalid code',severity:'error'}]))",
        );
        expect(await validateTextfileCode(root, "js", "bad code")).toEqual({
            content: "bad code",
            findings: [{ message: "Invalid code", range: [0, 3], ruleId: "error" }],
        });
        const empty = await fixture("");
        await expect(validateTextfileCode(empty, "js", "keep me")).rejects.toThrow("empty output");
        await expect(validateTextfileCode(empty, "../outside", "x")).rejects.toThrow("Invalid");
    });
});

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
        expect(codeBlockAt("> ```js\n> x()\n> ```", 10).code).toBe("x()");
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
            ".dooc/editor-tools/format.cjs",
            ".dooc/editor-tools/js.json",
            ".dooc/editor-tools/lint.cjs",
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

describe("document validation", () => {
    it("keeps incomplete code unchanged and reports original lint positions without running the formatter", async () => {
        const root = await fixture(
            "throw new Error('formatter must not run')",
            "require('node:fs').writeSync(1,JSON.stringify([{message:'Incomplete syntax',line:1,column:11,severity:'error'}]));process.exitCode=1",
        );
        const original = "Title\n=====\n\n```js\nconst x = (\n```\n";
        const result = await validateCodeTools(root, original);
        expect(result.changes).toEqual([]);
        expect(result.findings).toEqual([
            {
                ruleId: "error",
                message: "Incomplete syntax",
                range: [original.indexOf("("), original.indexOf("(") + 1],
            },
        ]);
    });

    it.each([
        "```js",
        "```unknown\nx()",
        "```\nx()",
        "> ```unknown\n> x()",
        "- Item\n\n  ```unknown\n  x()",
    ])("does not repair an open fence, even without a registered tool: %s", async (original) => {
        const root = await fixture("");
        await expect(validateCodeTools(root, original)).rejects.toThrow(
            /fenced code block|Close the code fence/,
        );
    });

    it("rejects formatter output that introduces a syntax error", async () => {
        const root = await fixture(
            "require('node:fs').writeSync(1,'broken(\\n')",
            "const s=require('node:fs').readFileSync(0,'utf8');require('node:fs').writeSync(1,JSON.stringify(s.includes('broken')?[{message:'Incomplete syntax',line:1,column:1,severity:'error'}]:[]))",
        );
        await expect(validateCodeTools(root, body)).rejects.toThrow("code was kept unchanged");
    });

    it("formats every configured block and maps diagnostics into the resulting document", async () => {
        const root = await fixture(
            "const s=require('node:fs').readFileSync(0,'utf8');require('node:fs').writeSync(1,s.replace('x=1','x = 1;'))",
            "require('node:fs').writeSync(1,JSON.stringify([{message:'Check x',line:1,column:7}]))",
        );
        const original = `${body}\n${body}\n\`\`\`unknown\nuntouched\n\`\`\``;
        const result = await validateCodeTools(root, original);
        expect(result.changes).toHaveLength(1);
        let updated = original;
        for (const change of [...result.changes].reverse())
            updated = updated.slice(0, change.from) + change.insert + updated.slice(change.to);
        expect(updated).toContain("untouched");
        expect(result.findings.map((finding) => updated.slice(...finding.range))).toEqual([
            "x",
            "x",
        ]);
        expect(result.findings[1]?.range[0]).toBe(updated.lastIndexOf("const x") + 6);
        expect((await validateCodeTools(root, updated)).changes).toEqual([]);
    });
    it("leaves documents without configured languages alone", async () => {
        const root = await fixture("");
        expect(await validateCodeTools(root, "# Heading\n\nText\n")).toEqual({
            changes: [],
            findings: [],
        });
    });
});

describe("registered tools across page blocks", () => {
    it("formats nested list/quote blocks and runs lint against the formatted positions", async () => {
        const root = await fixture(
            "const s=require('node:fs').readFileSync(0,'utf8');require('node:fs').writeSync(1,s.replace('x()','x();'))",
            "require('node:fs').writeSync(1,JSON.stringify([{message:'check',line:1,column:1}]))",
        );
        const original =
            "![](figures/a.svg)\n\n- Item\n\n  ```js\n  x()\n  ```\n\n> ```js\n> x()\n> ```\n";
        const result = await validateCodeTools(root, original);
        let updated = original;
        for (const change of [...result.changes].reverse())
            updated = updated.slice(0, change.from) + change.insert + updated.slice(change.to);
        expect(updated).toContain("  x();");
        expect(updated).toContain("> x();");
        expect(result.findings.map((finding) => updated.slice(...finding.range))).toEqual([
            "x",
            "x",
        ]);
    });
    it("supports formatter-only and linter-only language registrations", async () => {
        const root = await fixture("");
        const dir = join(root, ".dooc/editor-tools");
        await writeFile(
            join(dir, "fmt.json"),
            JSON.stringify({
                formatter: [process.execPath, "-e", "require('fs').writeSync(1,'changed\\n')"],
            }),
        );
        await writeFile(
            join(dir, "lint.json"),
            JSON.stringify({
                linter: [
                    process.execPath,
                    "-e",
                    "require('fs').writeSync(1,JSON.stringify([{message:'issue',line:1,column:1}]))",
                ],
            }),
        );
        const result = await validateCodeTools(
            root,
            "```fmt\noriginal\n```\n\n```lint\noriginal\n```\n",
        );
        expect(result.changes[0]?.insert).toContain("changed");
        expect(result.findings).toHaveLength(1);
    });
});
