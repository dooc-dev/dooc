import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildBundle } from "../../../server/src/build.js";
import { textfileResponse } from "../../../server/src/textfile.js";
import { allowedPreviewUrl, parsePreviewSettings } from "../core/previewers.js";
import { schemaResolver } from "../core/schema-refs.js";
import { compileSite } from "./compile.js";
import { exportEntries } from "./export.js";
import { compileSubformatSchema } from "./subformat-schema.js";
import { loadSubformat, subformatResponse } from "./subformats.js";
import { readRemoteTextfile } from "./textfile-remote.js";

vi.mock("./textfile-remote.js", async (original) => ({
    ...(await original<typeof import("./textfile-remote.js")>()),
    readRemoteTextfile: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.resetAllMocks();
});
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-schema-refs-"));
    roots.push(root);
    mkdirSync(join(root, "schemas"));
    const file = "schemas/issue.schema.json";
    const config = { ext: "issue", format: "json" as const, schema: file };
    const content = JSON.stringify({
        type: "object",
        properties: { status: { $ref: "./common.json#/$defs/status", title: "Stage" } },
        required: ["status"],
    });
    writeFileSync(join(root, file), content);
    writeFileSync(
        join(root, "schemas/common.json"),
        JSON.stringify({ $defs: { status: { type: "string", enum: ["Todo", "Done"] } } }),
    );
    writeFileSync(join(root, "dooc.yaml"), `docs: []\nsubformats: ${JSON.stringify([config])}\n`);
    writeFileSync(join(root, "one.issue"), '{"status":"Todo"}');
    return { root, file, config, content };
};

it("keeps file refs while validating, generating controls, saving, and exporting their dependencies", async () => {
    const { root, file, config, content } = fixture();
    const compiled = compileSubformatSchema(content, { root, file });
    expect(compiled.validate({ status: "Done" })).toBe(true);
    expect(compiled.validate({ status: "Other" })).toBe(false);
    const loaded = loadSubformat(root, config);
    expect(loaded.fields).toEqual([
        { name: "status", title: "Stage", type: "string", enum: ["Todo", "Done"] },
    ]);
    expect(JSON.parse(loaded.template)).toEqual({ status: "Todo" });
    expect(subformatResponse(root, { action: "validate", file, content }).status).toBe(200);
    const response = await textfileResponse(root, { action: "read", file: "one.issue" });
    expect(response.status).toBe(200);
    expect(response.body.schemaContext).toBeDefined();
    expect(
        (await textfileResponse(root, { action: "read", file: "schemas/common.json" })).body
            .schemaDocument,
    ).toBe(true);
    const resolve = schemaResolver(compiled.schema, response.body.schemaContext);
    expect(resolve(compiled.schema.properties.status).enum).toEqual(["Todo", "Done"]);
    const registered = subformatResponse(root, {
        action: "register",
        ext: "ticket",
        format: "json",
        schema: "schemas/ticket.schema.json",
        content,
    });
    expect(registered.status).toBe(200);
    expect(readFileSync(join(root, "schemas/ticket.schema.json"), "utf8")).toBe(content);
    expect(exportEntries(root).map((entry) => entry.name)).toContain("schemas/common.json");
});

it("invalidates validators when a referenced file changes and never shares files across workspaces", () => {
    const { root, file, content } = fixture();
    const first = compileSubformatSchema(content, { root, file });
    expect(compileSubformatSchema(content, { root, file }).validate).toBe(first.validate);
    writeFileSync(
        join(root, "schemas/common.json"),
        '{"$defs":{"status":{"type":"string","enum":["New"]}}}',
    );
    const next = compileSubformatSchema(content, { root, file });
    expect(next.validate).not.toBe(first.validate);
    expect(next.validate({ status: "Todo" })).toBe(false);
    expect(next.validate({ status: "New" })).toBe(true);
    const other = fixture();
    expect(compileSubformatSchema(content, other).validate({ status: "Todo" })).toBe(true);
});

it("resolves relative file IDs, anchors, escaped pointers and mutually recursive files", () => {
    const { root, file } = fixture();
    writeFileSync(
        join(root, "schemas/node.json"),
        JSON.stringify({
            $id: "node.json",
            type: "object",
            properties: {
                status: { $ref: "common.json#status" },
                next: { $ref: "issue.schema.json" },
            },
        }),
    );
    writeFileSync(
        join(root, "schemas/common.json"),
        JSON.stringify({
            $defs: { "a/b~c": { $anchor: "status", type: "string", enum: ["Todo", "Done"] } },
        }),
    );
    const content = JSON.stringify({
        $id: "issue.schema.json",
        type: "object",
        properties: { node: { $ref: "node.json" }, status: { $ref: "common.json#/$defs/a~1b~0c" } },
    });
    writeFileSync(join(root, file), content);
    const compiled = compileSubformatSchema(content, { root, file });
    expect(
        compiled.validate({ node: { status: "Todo", next: { node: { status: "Done" } } } }),
    ).toBe(true);
    expect(compiled.validate({ node: { status: "Bad" } })).toBe(false);
    const resolve = schemaResolver(compiled.schema, compiled.context);
    expect(resolve(compiled.schema.properties.status).enum).toEqual(["Todo", "Done"]);
    expect(
        resolve(
            (resolve(compiled.schema.properties.node).properties as Record<string, unknown>).status,
        ).enum,
    ).toEqual(["Todo", "Done"]);
});

it("loads remote schemas with their own relative refs and rechecks domain permission before using cache", async () => {
    const { root, file, config } = fixture();
    const remote: Record<string, unknown> = {
        "https://schemas.example.com/issue.json": {
            type: "object",
            properties: { status: { $ref: "./common.json#status" } },
        },
        "https://schemas.example.com/common.json": {
            $anchor: "status",
            type: "string",
            enum: ["Todo", "Done"],
        },
    };
    vi.mocked(readRemoteTextfile).mockImplementation((uri, domains) => {
        allowedPreviewUrl(uri, domains);
        if (!Object.hasOwn(remote, uri)) throw new Error("File not found");
        return Buffer.from(JSON.stringify(remote[uri]));
    });
    const content = '{"$ref":"https://schemas.example.com/issue.json"}';
    const source = { root, file, domains: ["schemas.example.com"] };
    const compiled = compileSubformatSchema(content, source);
    writeFileSync(join(root, file), content);
    writeFileSync(
        join(root, "dooc.yaml"),
        `center_contents: [{ subformat: issue }]\njson_subformats: ${JSON.stringify([config])}\n`,
    );
    const previews = parsePreviewSettings({ domains: source.domains });
    expect(compileSite(root, { previews }).errors).toEqual([]);
    expect((await buildBundle(root, { format: "zip", urlPreview: "network", previews })).docs).toBe(
        1,
    );
    expect(compiled.validate({ status: "Done" })).toBe(true);
    expect(compiled.validate({ status: "Bad" })).toBe(false);
    const resolve = schemaResolver(compiled.schema, compiled.context);
    expect(
        resolve((resolve(compiled.schema).properties as Record<string, unknown>).status).enum,
    ).toEqual(["Todo", "Done"]);
    expect(() => compileSubformatSchema(content, { ...source, domains: [] })).toThrow(
        "Domain is not allowed",
    );
    remote["https://schemas.example.com/common.json"] = {
        $anchor: "status",
        type: "string",
        enum: ["New"],
    };
    expect(compileSubformatSchema(content, source).validate({ status: "Done" })).toBe(false);
    remote["https://schemas.example.com/common.json"] = { $ref: "file:///etc/passwd" };
    expect(() => compileSubformatSchema(content, source)).toThrow(
        "Remote schemas cannot reference local files",
    );
    remote["https://schemas.example.com/common.json"] = {
        $id: "file:///etc/passwd",
        type: "string",
    };
    expect(() => compileSubformatSchema(content, source)).toThrow(
        "Remote schemas cannot reference local files",
    );
});

it("rejects missing refs, ignored files, traversal and symlinks outside the workspace", () => {
    const { root, file } = fixture();
    const outside = fixture();
    symlinkSync(join(outside.root, outside.file), join(root, "schemas/outside.json"));
    writeFileSync(join(root, ".gitignore"), "schemas/common.json\n");
    for (const ref of [
        "missing.json",
        "common.json",
        "outside.json",
        "../../outside.json",
        "file:///etc/passwd",
        "data:application/json,{}",
        "#/$defs/missing",
    ])
        expect(() =>
            compileSubformatSchema(JSON.stringify({ $ref: ref }), { root, file }),
        ).toThrow();
});

it("preserves null enum values and defaults in the generated record template", () => {
    const { root, file, config } = fixture();
    writeFileSync(
        join(root, file),
        JSON.stringify({
            type: "object",
            properties: {
                status: { enum: [null, "Todo"] },
                other: { type: "null", default: null },
            },
            required: ["status"],
        }),
    );
    const loaded = loadSubformat(root, config);
    expect(JSON.parse(loaded.template)).toEqual({ status: null, other: null });
    expect(loaded.validate(JSON.parse(loaded.template))).toBe(true);
});
