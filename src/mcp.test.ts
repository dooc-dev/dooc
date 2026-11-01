import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTools, handleRpc } from "./mcp.js";

const fixture = (): string => {
    const root = mkdtempSync(join(tmpdir(), "docs-mcp-"));
    cpSync(new URL("../sample-content", import.meta.url).pathname, root, { recursive: true });
    return root;
};

const call = (tools: ReturnType<typeof createTools>, name: string, args: object) => {
    const res = handleRpc(tools, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
    }) as { result: { content: { text: string }[]; isError: boolean } };
    return { ...JSON.parse(res.result.content[0]?.text ?? "null"), isError: res.result.isError };
};

describe("mcp", () => {
    it("initialize / tools/list / notification", () => {
        const tools = createTools(fixture());
        const init = handleRpc(tools, { jsonrpc: "2.0", id: 0, method: "initialize" }) as {
            result: { capabilities: object };
        };
        expect(init.result.capabilities).toEqual({ tools: {} });
        const list = handleRpc(tools, { jsonrpc: "2.0", id: 1, method: "tools/list" }) as {
            result: { tools: { name: string }[] };
        };
        expect(list.result.tools.map((t) => t.name)).toContain("write_doc");
        expect(
            handleRpc(tools, { jsonrpc: "2.0", method: "notifications/initialized" }),
        ).toBeUndefined();
    });

    it("doc create → write → move → rename → delete", () => {
        const root = fixture();
        const tools = createTools(root);
        expect(call(tools, "add_doc", { id: "new", title: "New", parent: "guide" }).isError).toBe(
            false,
        );
        expect(call(tools, "add_doc", { id: "new", title: "dup" }).isError).toBe(true);
        expect(call(tools, "add_doc", { id: "target", title: "Target" }).isError).toBe(false);
        const w = call(tools, "write_doc", {
            id: "new",
            content: '---\ntitle: "New"\n---\n\nhello [target](doc:target)',
        });
        expect(w.errors).toEqual([]);
        expect(call(tools, "search_docs", { query: "hello" })).toMatchObject({ 0: { id: "new" } });
        expect(call(tools, "move_doc", { id: "new" }).isError).toBe(false);
        expect(call(tools, "list_docs", {}).docs.at(-1)).toMatchObject({ id: "new", depth: 0 });
        expect(call(tools, "rename_doc", { id: "target", new_id: "b" }).updatedRefs).toBe(1);
        expect(readFileSync(join(root, "content/new.md"), "utf8")).toContain("doc:b");
        const blocked = call(tools, "delete_doc", { id: "b" });
        expect(blocked).toMatchObject({ isError: true, referencedBy: ["new.md"] });
        expect(call(tools, "delete_doc", { id: "b", force: true }).isError).toBe(false);
        expect(existsSync(join(root, "content/b.md"))).toBe(false);
        expect(call(tools, "check", {}).errors.length).toBeGreaterThan(0);
    });

    it("figure add → read → delete", () => {
        const root = fixture();
        const tools = createTools(root);
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>Fig.x</title></svg>';
        expect(call(tools, "add_figure", { file: "X Fig.svg", text: svg }).file).toBe("x-fig.svg");
        expect(call(tools, "add_figure", { file: "x-fig.svg", text: svg }).file).toBe("x-fig.svg");
        expect(call(tools, "read_figure", { name: "x-fig" }).kind).toBe("svg");
        expect(call(tools, "add_figure", { file: "y.svg" }).isError).toBe(true);
        expect(call(tools, "delete_figure", { name: "x-fig" }).isError).toBe(false);
        expect(existsSync(join(root, "figures/x-fig.svg"))).toBe(false);
    });
});
