import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SKIP, visit } from "unist-util-visit";
import { codeBlockAt, offsetAt, parseMdast } from "../core/markdown.js";

export { codeBlockAt } from "../core/markdown.js";

import { formatMarkdown } from "../compiler/format.js";
import { findDirective } from "../core/taxonomy.js";

export function isLocalToolRequest(
    host: string,
    origin: string | undefined,
    contentType: string | undefined,
): boolean {
    return (
        ["localhost", "127.0.0.1", "[::1]"].includes(host.replace(/:\d+$/, "")) &&
        origin === `http://${host}` &&
        contentType?.split(";")[0]?.trim() === "application/json"
    );
}

function command(value: unknown): [string, ...string[]] {
    if (
        !Array.isArray(value) ||
        !value.length ||
        value.some((v) => typeof v !== "string" || v.includes("\0")) ||
        !value[0]
    ) {
        throw new Error("Tool command must be a nonempty array of strings");
    }
    return value as [string, ...string[]];
}

function execute(
    args: [string, ...string[]],
    cwd: string,
    input: string,
    lint: boolean,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = execFile(
            args[0],
            args.slice(1),
            {
                cwd,
                timeout: 10_000,
                killSignal: "SIGKILL",
                maxBuffer: 1024 * 1024,
                encoding: "utf8",
            },
            (error, stdout, stderr) => {
                if (error && !(lint && error.code === 1 && !error.killed)) {
                    reject(new Error(stderr.trim().slice(0, 2000) || error.message));
                } else resolve(stdout);
            },
        );
        child.stdin?.on("error", () => {
            /* Process exit is handled by execFile. */
        });
        child.stdin?.end(input);
    });
}

export async function runCodeTool(
    root: string,
    body: string,
    position: number,
    action: "format" | "lint",
) {
    const block = codeBlockAt(body, position);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_+-]*$/.test(block.language))
        throw new Error("Unsupported code language identifier");
    const path = join(root, ".dooc", "editor-tools", `${block.language}.json`);
    let config: Record<string, unknown>;
    try {
        config = JSON.parse(await readFile(path, "utf8"));
    } catch {
        throw new Error(
            `Create .dooc/editor-tools/${block.language}.json to configure this language`,
        );
    }
    if (!config || typeof config !== "object") throw new Error("Invalid editor tool configuration");
    const output = await execute(
        command(config[action === "format" ? "formatter" : "linter"]),
        root,
        `${block.code}\n`,
        action === "lint",
    );
    if (action === "format") {
        const normalized = output.replace(/\r\n/g, "\n").replace(/\n$/, "");
        if (!normalized && block.code.trim())
            throw new Error("Formatter returned empty output; code was kept unchanged");
        const lines = normalized ? normalized.split("\n") : [];
        const fence = new RegExp(`^ {0,3}${block.marker[0]}{${block.marker.length},}[ \\t]*$`);
        if (lines.some((line) => fence.test(line)))
            throw new Error("Formatter output would close the code fence");
        return {
            change: {
                from: block.from,
                to: block.to,
                insert: lines.map((line) => block.indent + line + block.eol).join(""),
            },
        };
    }
    const diagnostics: unknown = JSON.parse(output);
    if (!Array.isArray(diagnostics)) throw new Error("Linter must return a JSON array");
    const lines = block.code.split("\n");
    const at = (line: unknown, column: unknown): number => {
        if (
            typeof line !== "number" ||
            typeof column !== "number" ||
            !Number.isInteger(line) ||
            !Number.isInteger(column) ||
            line < 1 ||
            line > block.offsets.length ||
            column < 1 ||
            column > (lines[line - 1]?.length ?? 0) + 1
        )
            throw new Error("Invalid diagnostic position");
        return (block.offsets[line - 1] ?? block.from) + column - 1;
    };
    const findings = diagnostics.map((d: unknown) => {
        if (!d || typeof d !== "object" || !("message" in d) || typeof d.message !== "string")
            throw new Error("Invalid diagnostic");
        const item = d as Record<string, unknown>;
        const from = at(item.line, item.column);
        const to =
            item.endLine == null && item.endColumn == null
                ? Math.min(from + 1, block.to)
                : at(item.endLine, item.endColumn);
        if (to < from) throw new Error("Invalid diagnostic range");
        const severity = item.severity ?? "warning";
        if (!["error", "warning", "info"].includes(String(severity)))
            throw new Error("Invalid diagnostic severity");
        return {
            range: [from, to] as [number, number],
            message: d.message,
            ruleId: String(severity),
        };
    });
    return { findings };
}

export async function validateCodeTools(root: string, body: string) {
    const original = body;
    const configuredBlocks = async (text: string, tool: "formatter" | "linter") => {
        const blocks: number[] = [];
        const nodes: import("mdast").Code[] = [];
        visit(parseMdast(text), (node) => {
            if (node.type === "containerDirective" && findDirective("container", node.name)?.raw)
                return SKIP;
            if (node.type === "code") nodes.push(node);
        });
        for (const node of nodes) {
            if (node.position) {
                const position = offsetAt(
                    text,
                    node.position.start.line,
                    node.position.start.column,
                );
                if (/^ {0,3}(`{3,}|~{3,})/.test(text.slice(position))) {
                    codeBlockAt(text, position);
                }
            }
            if (
                node.type !== "code" ||
                node.position?.start.offset == null ||
                !node.lang ||
                !/^[a-zA-Z0-9][a-zA-Z0-9_+-]*$/.test(node.lang)
            )
                continue;
            let raw: string;
            try {
                raw = await readFile(join(root, ".dooc/editor-tools", `${node.lang}.json`), "utf8");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                throw error;
            }
            const config = JSON.parse(raw);
            if (!config || typeof config !== "object")
                throw new Error("Invalid editor tool configuration");
            if (config[tool] != null)
                blocks.push(offsetAt(text, node.position.start.line, node.position.start.column));
        }
        return blocks;
    };
    const originalFindings = [];
    for (const position of await configuredBlocks(body, "linter")) {
        const result = await runCodeTool(root, body, position, "lint");
        originalFindings.push(...(result.findings ?? []));
    }
    if (originalFindings.some((finding) => finding.ruleId === "error")) {
        return { changes: [], findings: originalFindings };
    }
    for (const position of (await configuredBlocks(body, "formatter")).reverse()) {
        const { change } = await runCodeTool(root, body, position, "format");
        if (change && body.slice(change.from, change.to) !== change.insert) {
            body = body.slice(0, change.from) + change.insert + body.slice(change.to);
        }
    }
    body = formatMarkdown(body);
    if (body === original) return { changes: [], findings: originalFindings };
    const findings = [];
    for (const position of await configuredBlocks(body, "linter")) {
        const result = await runCodeTool(root, body, position, "lint");
        findings.push(...(result.findings ?? []));
    }
    if (findings.some((finding) => finding.ruleId === "error")) {
        throw new Error("Formatted code failed validation; code was kept unchanged");
    }
    let from = 0;
    while (from < original.length && from < body.length && original[from] === body[from]) from++;
    let to = original.length;
    let end = body.length;
    while (to > from && end > from && original[to - 1] === body[end - 1]) {
        to--;
        end--;
    }
    return {
        changes: from === to && from === end ? [] : [{ from, to, insert: body.slice(from, end) }],
        findings,
    };
}

/** Apply the same registered formatter/linter to a complete file without writing to disk. */
export async function validateTextfileCode(root: string, language: string, content: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_+-]*$/.test(language) || content.includes("\0"))
        throw new Error("Invalid text file tool request");
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const marker = "`".repeat(
        [...content.matchAll(/`+/g)].reduce(
            (length, match) => Math.max(length, match[0].length + 1),
            3,
        ),
    );
    const prefix = `${marker}${language}${eol}`;
    const separator = content && !content.endsWith("\n") ? eol : "";
    let body = `${prefix}${content}${separator}${marker}${eol}`;
    const result = await validateCodeTools(root, body);
    for (const change of [...result.changes].reverse())
        body = body.slice(0, change.from) + change.insert + body.slice(change.to);
    const block = codeBlockAt(body, 0);
    let formatted = body.slice(block.from, block.to);
    if (separator) formatted = formatted.replace(/\r?\n$/, "");
    return {
        content: formatted,
        findings: result.findings.map((finding) => ({
            ...finding,
            range: finding.range.map((offset) =>
                Math.max(0, Math.min(formatted.length, offset - block.from)),
            ) as [number, number],
        })),
    };
}
