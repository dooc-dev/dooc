import { readdirSync, readFileSync } from "node:fs";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { parseDoc } from "./dialect.js";
import { formatMarkdown } from "./format.js";

describe("Markdown formatting", () => {
    it("normalizes headings, lists, tables and spacing", () => {
        const result = formatMarkdown(
            "Title\n=====\n\n*   one\n*   two\n\n| a | b |\n|---|---|\n|x|long|\n",
        );
        expect(result).toContain("# Title\n");
        expect(result).toContain("- one\n- two\n");
        expect(formatMarkdown(result)).toBe(result);
    });
    it("preserves custom directives, code, and significant inline code spaces", () => {
        const body =
            "# Title\n\n![caption](figures/overview.svg)\n\n~~~schemath Model\na:\n  id: pk\n~~~\n\n```tdl\n  field\n```\n\n`     field`\n";
        const formatted = formatMarkdown(body);
        expect(formatted).toContain("![caption](figures/overview.svg)");
        expect(formatted).toContain("~~~schemath Model\na:\n  id: pk\n~~~");
        expect(formatted).toContain("```tdl\n  field\n```");
        expect(formatted).toContain("`     field`");
        expect(formatMarkdown(formatted)).toBe(formatted);
    });
    it("keeps all sample documents valid and is idempotent", () => {
        const root = new URL("../../../../dooc-docs/contents/md/", import.meta.url);
        for (const file of readdirSync(root).filter((file) => file.endsWith(".md"))) {
            const original = readFileSync(new URL(file, root), "utf8");
            const formatted = formatMarkdown(original);
            expect(parseDoc(formatted).errors, file).toEqual(parseDoc(original).errors);
            expect(formatMarkdown(formatted), file).toBe(formatted);
        }
    });
    it("aligns table separators by visual width for Japanese, links and emoji", () => {
        const table = [
            "| 表現 | 適した内容 | サンプル |",
            "| --- | --- | --- |",
            "| 箇条書き | 条件や確認項目 | [公開前チェック](content/a.md) |",
            "| 図・HTML | 構成や処理の流れ | [図とHTML](content/media.md) |",
            "| 関係図 | コンポーネントの依存 | [処理フロー](content/flow.md) |",
            "| スキーマ | テーブル間の関連 | [データモデル](content/data-model.md) |",
            "| 👩‍💻 | é | English |",
        ].join("\n");
        const formatted = formatMarkdown(table);
        const columns = formatted
            .trimEnd()
            .split("\n")
            .map((line) =>
                [...line.matchAll(/\|/g)].map((match) => stringWidth(line.slice(0, match.index))),
            );
        for (const positions of columns) expect(positions).toEqual(columns[0]);
        expect(formatMarkdown(formatted)).toBe(formatted);
    });
    it("preserves CRLF and handles empty documents", () => {
        expect(formatMarkdown("# Title\r\n\r\nText\r\n")).toBe("# Title\r\n\r\nText\r\n");
        expect(formatMarkdown("")).toBe("");
    });
});
