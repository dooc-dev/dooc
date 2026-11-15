import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { compileSite } from "../../engine/src/compiler/compile.js";
import { readManifest } from "../../engine/src/compiler/manifest.js";
import { createDocOps } from "../../engine/src/compiler/ops.js";
import { subformatPageId } from "../../engine/src/core/content-metadata.js";
import { createDocumentApplication } from "./document-application.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const iconApplication = (root: string) => {
    const unused = (): never => {
        throw new Error("Unexpected host operation");
    };
    return createDocumentApplication(root, {
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
};

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
    const application = iconApplication(root);
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

it.each([
    "nested",
    "legacy",
])("replacing a copied page icon preserves the type SVG (%s)", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-subformat-icon-"));
    roots.push(root);
    const svg = '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6"/></svg>';
    const replacement = '<svg viewBox="0 0 20 20"><path d="M1 1h10v10z"/></svg>';
    writeFileSync(join(root, "type.svg"), svg);
    writeFileSync(join(root, "issue.schema.json"), "{}");
    writeFileSync(
        join(root, "dooc.yaml"),
        `${kind === "nested" ? "center_contents: []\njson_subformats" : "docs: []\nsubformats"}: [{ext: issue, format: json, schema: issue.schema.json, icon: type.svg}]\n`,
    );
    const id = subformatPageId("issue");
    expect(createDocOps(root).addSubformat("issue", "Issues")).toEqual({ id });
    const request = Object.assign(
        Readable.from([
            Buffer.from(
                JSON.stringify({
                    file: `${id}.md`,
                    data: Buffer.from(replacement).toString("base64"),
                }),
            ),
        ]),
        { method: "POST", url: "/api/icon", headers: {} },
    );
    const response = { writeHead: vi.fn(), end: vi.fn() };
    await iconApplication(root).handle(
        "edit",
        request as IncomingMessage,
        response as unknown as ServerResponse,
    );
    expect(response.writeHead.mock.calls[0]?.[0]).toBe(200);
    expect(readFileSync(join(root, "type.svg"), "utf8")).toBe(svg);
    const manifest = readManifest(root);
    expect(manifest.subformats?.[0]?.icon).toBe("type.svg");
    expect(manifest.files?.icons?.[id]).not.toBe("type.svg");
    expect(compileSite(root).docs[0]?.icon).toContain('<path d="M1 1h10v10z"/>');
});
