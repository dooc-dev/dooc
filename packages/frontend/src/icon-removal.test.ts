import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { compileSite } from "../../engine/src/compiler/compile.js";
import { createDocumentApplication } from "./document-application.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
    "explicit",
    "shared default",
    "owned default",
])("clears an icon without deleting shared assets (%s)", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-icon-removal-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    mkdirSync(join(root, "icons"));
    for (const id of ["a", "b"]) writeFileSync(join(root, `content/${id}.md`), `${id}\n`);
    const file = kind === "explicit" ? "shared.svg" : "icons/a.svg";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
    writeFileSync(join(root, file), svg);
    writeFileSync(
        join(root, "dooc.yaml"),
        "defaultLang: eng\ndocs: [a, b]\n" +
            (kind === "explicit"
                ? "icon: shared.svg\nfiles:\n  icons: { a: shared.svg, b: shared.svg }\n"
                : kind === "shared default"
                  ? "files:\n  icons: { b: icons/a.svg }\n"
                  : ""),
    );
    const unused = (): never => {
        throw new Error("Unexpected host operation");
    };
    const application = createDocumentApplication(root, {
        fontCss: unused,
        readWorkspaceSource: unused,
        sourceFileBase: unused,
        gitBaseBody: unused,
        gitBaseText: unused,
        setSubformatChanges: unused,
        runCodeTool: unused,
        validateCodeTools: unused,
        validateTextfileCode: unused,
    });
    const request = Object.assign(
        Readable.from([Buffer.from(JSON.stringify({ file: "a.md", data: null }))]),
        { method: "POST", url: "/api/icon", headers: {} },
    );
    const response = { writeHead: vi.fn(), end: vi.fn() };
    await application.handle(
        "edit",
        request as IncomingMessage,
        response as unknown as ServerResponse,
    );
    expect(response.writeHead.mock.calls[0]?.[0]).toBe(kind === "shared default" ? 409 : 200);
    expect(existsSync(join(root, file))).toBe(kind !== "owned default");
    if (kind !== "owned default") expect(readFileSync(join(root, file), "utf8")).toBe(svg);
    const site = compileSite(root);
    expect(site.docs.find((doc) => doc.id === "a")?.icon).toBe(
        kind === "shared default" ? svg : undefined,
    );
    expect(site.docs.find((doc) => doc.id === "b")?.icon).toBe(
        kind === "owned default" ? undefined : svg,
    );
});
