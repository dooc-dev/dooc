import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { visit } from "unist-util-visit";
import { parseMdast } from "../compiler/dialect.js";

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

/** A closed, top-level fenced block. Offsets are UTF-16 offsets in the editor body. */
export function codeBlockAt(body: string, position: number) {
    if (!Number.isInteger(position) || position < 0 || position > body.length) {
        throw new Error("Invalid cursor position");
    }
    const tree = parseMdast(body);
    let block:
        | {
              from: number;
              to: number;
              language: string;
              code: string;
              indent: string;
              eol: string;
              marker: string;
              offsets: number[];
          }
        | undefined;
    visit(tree, "code", (node, _index, parent) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start == null || end == null || position < start || position > end) return;
        // shortcut: nested fences need container-prefix reconstruction; reject until supported.
        if (parent !== tree) throw new Error("Code tools currently support top-level fences only");
        const lineStart = body.lastIndexOf("\n", start - 1) + 1;
        const raw = body.slice(lineStart, end);
        const opening = /^( {0,3})(`{3,}|~{3,})[^\r\n]*\r?\n/.exec(raw);
        if (!opening?.[2]) throw new Error("Select a fenced code block");
        const closing = /(?:^|\n)( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(raw);
        if (
            !closing?.[2] ||
            closing[2][0] !== opening[2][0] ||
            closing[2].length < opening[2].length
        ) {
            throw new Error("Close the code fence before running a tool");
        }
        const from = lineStart + opening[0].length;
        const to = lineStart + closing.index + (raw[closing.index] === "\n" ? 1 : 0);
        if (to < from) throw new Error("Invalid code fence");
        const offsets: number[] = [];
        let offset = from;
        const lines = body.slice(from, to).split(/\r?\n/);
        lines.pop();
        const code = lines
            .map((line) => {
                const removed = Math.min(
                    (opening[1] ?? "").length,
                    /^ */.exec(line)?.[0].length ?? 0,
                );
                offsets.push(offset + removed);
                offset += line.length + (body[offset + line.length] === "\r" ? 2 : 1);
                return line.slice(removed);
            })
            .join("\n");
        if (!offsets.length) offsets.push(from);
        block = {
            from,
            to,
            language: node.lang ?? "",
            code,
            indent: opening[1] ?? "",
            eol: opening[0].endsWith("\r\n") ? "\r\n" : "\n",
            marker: opening[2],
            offsets,
        };
    });
    if (!block) throw new Error("Place the cursor inside a fenced code block");
    return block;
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
    const path = join(root, ".document-system", "editor-tools", `${block.language}.json`);
    let config: Record<string, unknown>;
    try {
        config = JSON.parse(await readFile(path, "utf8"));
    } catch {
        throw new Error(
            `Create .document-system/editor-tools/${block.language}.json to configure this language`,
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
        if (lines.some((line) => fence.test(block.indent + line)))
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
