import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { createTools, handleRpc } from "./mcp.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = (checklist = "Check the change against the project's rules.") => {
    const root = mkdtempSync(join(tmpdir(), "dooc-mcp-skills-"));
    roots.push(root);
    const write = (file: string, content: string | Buffer) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), content);
    };
    write(
        "dooc.yaml",
        stringify({ system: { skills: [".agents/skills/review-docs/SKILL.md"] }, document: {} }),
    );
    const source =
        "---\nname: review-docs\ndescription: Review changes using the project checklist.\nallowed-tools: read_file\n---\nUse dooc's read_file tool to load docs/checklist.md, then evaluate each item.\n";
    write(".agents/skills/review-docs/SKILL.md", source);
    write(".agents/skills/review-docs/references/guide #1.md", "Reference\r\n");
    write(".agents/skills/review-docs/assets/data.bin", Buffer.from([0, 255, 128]));
    write("docs/checklist.md", checklist);
    return { root, write, source, tools: createTools(root, { readOnly: true }) };
};
interface Entry {
    uri: string;
    frontmatter: { name: string; description: string };
    resources: { uri: string; digest: string; size: number }[];
}
interface Result {
    skills: Entry[];
    skill: Entry;
    resources: { uri: string }[];
    content: { text: string }[];
    contents: { uri: string; text?: string; blob?: string }[];
}
const rpc = async (tools: ReturnType<typeof createTools>, method: string, params = {}) =>
    (await handleRpc(tools, { jsonrpc: "2.0", id: 1, method, params })) as {
        result: Result;
        error?: { code: number };
    };

it("serves project workflows through native MCP and the read-only skills tool", async () => {
    const { tools, source } = fixture();
    expect(await rpc(tools, "initialize")).toMatchObject({
        result: {
            capabilities: {
                tools: {},
                resources: {},
                extensions: { "io.modelcontextprotocol/skills": {} },
            },
        },
    });
    const listed = (await rpc(tools, "skills/list")).result;
    const skill = listed.skills[0];
    expect(skill).toMatchObject({
        uri: "skill://review-docs/SKILL.md",
        frontmatter: { name: "review-docs", "allowed-tools": "read_file" },
    });
    expect(skill?.resources).toHaveLength(3);
    const fetched = (await rpc(tools, "skills/get", { uri: skill?.uri })).result;
    expect(fetched.skill).toEqual(skill);
    for (const resource of skill?.resources ?? []) {
        const read = (await rpc(tools, "resources/read", { uri: resource.uri })).result.contents[0];
        const bytes =
            read?.blob === undefined
                ? Buffer.from(read?.text ?? "")
                : Buffer.from(read.blob, "base64");
        expect(bytes.length).toBe(resource.size);
        expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(resource.digest);
    }
    expect((await rpc(tools, "resources/list")).result.resources.map((r) => r.uri)).toEqual([
        skill?.uri,
    ]);
    expect(await rpc(tools, "resources/templates/list")).toMatchObject({
        result: { resourceTemplates: [] },
    });
    const fallback = (
        await rpc(tools, "tools/call", { name: "skills", arguments: { action: "list" } })
    ).result;
    expect(JSON.parse(fallback.content[0]?.text ?? "{}")).toEqual(listed);
    const read = (
        await rpc(tools, "tools/call", {
            name: "skills",
            arguments: { action: "read", uri: skill?.uri },
        })
    ).result;
    expect(JSON.parse(read.content[0]?.text ?? "{}").contents[0].text).toBe(source);
    const checklist = (
        await rpc(tools, "tools/call", {
            name: "read_file",
            arguments: { file: "docs/checklist.md" },
        })
    ).result;
    expect(JSON.parse(checklist.content[0]?.text ?? "{}").content).toBe(
        "Check the change against the project's rules.",
    );
});

it("keeps identical skill URIs scoped to their project and reflects file changes", async () => {
    const first = fixture();
    const second = fixture("Second project's checklist");
    const uri = "skill://review-docs/SKILL.md";
    second.write(
        ".agents/skills/review-docs/SKILL.md",
        second.source.replace("evaluate each item", "report only failing items"),
    );
    const a = (await rpc(first.tools, "skills/get", { uri })).result.skill;
    const b = (await rpc(second.tools, "skills/get", { uri })).result.skill;
    expect(a.uri).toBe(b.uri);
    expect(a.resources).not.toEqual(b.resources);
    first.write("dooc.yaml", stringify({ document: {} }));
    expect((await rpc(first.tools, "skills/list")).result.skills).toEqual([]);
    expect(await rpc(first.tools, "resources/read", { uri })).toMatchObject({
        error: { code: -32602 },
    });
    expect((await rpc(second.tools, "skills/list")).result.skills).toHaveLength(1);
});

it("rejects unknown skills, traversal and invalid params without exposing project files", async () => {
    const { tools } = fixture();
    for (const uri of [
        "skill://missing/SKILL.md",
        "skill://review-docs/../docs/checklist.md",
        "skill://review-docs/%2e%2e/docs/checklist.md",
        "file:///etc/passwd",
        "skill://review-docs/.env",
    ])
        for (const method of ["skills/get", "resources/read"])
            expect(await rpc(tools, method, { uri })).toMatchObject({ error: { code: -32602 } });
    for (const params of [{}, { uri: 42 }, { uri: "" }])
        expect(await rpc(tools, "resources/read", params)).toMatchObject({
            error: { code: -32602 },
        });
    expect(await rpc(tools, "skills/list", { cursor: "bad" })).toMatchObject({
        error: { code: -32602 },
    });
    expect(
        await rpc(tools, "tools/call", {
            name: "skills",
            arguments: { action: "execute", uri: "skill://review-docs/SKILL.md" },
        }),
    ).toMatchObject({ result: { isError: true } });
});
