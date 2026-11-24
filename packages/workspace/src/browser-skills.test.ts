import { afterEach, expect, it, vi } from "vitest";
import { createMcpOperations } from "../../frontend/src/mcp-operations.js";
import { fs } from "./browser-host.js";
import { handleRpc } from "./mcp.js";
import { createMcpTools } from "./mcp-tools.js";

vi.mock("../../engine/src/compiler/host.js", () => import("./browser-host.js"));
afterEach(() => fs.rmSync("/skills-workspace", { recursive: true, force: true }));

it("reads configured project skills and their source documents through the browser host", async () => {
    const root = "/skills-workspace";
    fs.mkdirSync(`${root}/.agents/skills/review-docs`, { recursive: true });
    fs.writeFileSync(
        `${root}/dooc.yaml`,
        "system:\n  skills: [.agents/skills/review-docs/SKILL.md]\ndocument: {}\n",
    );
    const content =
        "---\nname: review-docs\ndescription: Apply the project checklist.\n---\nUse read_file to read checklist.md.\n";
    fs.writeFileSync(`${root}/.agents/skills/review-docs/SKILL.md`, content);
    fs.writeFileSync(`${root}/checklist.md`, "Check error handling.\n");
    const operations = createMcpOperations(root);
    const tools = createMcpTools((name, args) => operations[name]?.(args), true, true);
    expect(await handleRpc(tools, { jsonrpc: "2.0", id: 1, method: "skills/list" })).toMatchObject({
        result: { skills: [{ uri: "skill://review-docs/SKILL.md" }] },
    });
    expect(
        await handleRpc(tools, {
            jsonrpc: "2.0",
            id: 2,
            method: "resources/read",
            params: { uri: "skill://review-docs/SKILL.md" },
        }),
    ).toMatchObject({ result: { contents: [{ text: content }] } });
    expect(await tools.read_file?.run({ file: "checklist.md" })).toEqual({
        file: "checklist.md",
        content: "Check error handling.\n",
    });
});
