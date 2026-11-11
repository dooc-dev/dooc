import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { previewTextfiles, textfileResponse } from "./textfile.js";

const roots: string[] = [];
const fixture = (): string => {
    const root = mkdtempSync(join(tmpdir(), "docs-textfile-edit-"));
    roots.push(root);
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
    "yaml",
    "json",
    "toml",
])("saves .issue only using its declared %s format and schema", async (format) => {
    const root = fixture();
    const sources = {
        yaml: "title: One\npoints: 2\n",
        json: '{"title":"One","points":2}\n',
        toml: 'title = "One"\npoints = 2\n',
    };
    writeFileSync(
        join(root, "dooc.yaml"),
        `docs: []\nsubformats: [{ext: issue, format: ${format}, schema: issue.schema.json}]\n`,
    );
    writeFileSync(
        join(root, "issue.schema.json"),
        JSON.stringify({
            type: "object",
            required: ["title", "points"],
            properties: { title: { type: "string" }, points: { type: "integer", minimum: 0 } },
        }),
    );
    const content = sources[format as keyof typeof sources];
    const save = (text: string, base: string | null) =>
        textfileResponse(root, { action: "save", file: "one.issue", content: text, base });
    expect((await save(content, null)).status).toBe(200);
    const other = format === "yaml" ? sources.toml : sources.yaml;
    expect((await save(other, content)).status).toBe(400);
    expect((await save(content.replace("2", "-1"), content)).status).toBe(400);
    expect(readFileSync(join(root, "one.issue"), "utf8")).toBe(content);
    const updated = content.replace("One", "Two");
    expect((await save(updated, content)).status).toBe(200);
    expect(readFileSync(join(root, "one.issue"), "utf8")).toBe(updated);
    expect(
        (await textfileResponse(root, { action: "read", file: "one.issue" })).body,
    ).toMatchObject({ language: format, schema: { type: "object" } });
    const schemaRead = await textfileResponse(root, { action: "read", file: "issue.schema.json" });
    expect(schemaRead.body.schemaDocument).toBe(true);
    const invalid = await textfileResponse(root, {
        action: "save",
        file: "issue.schema.json",
        base: schemaRead.body.content,
        content: '{"type":"object","required":["missing"]}',
    });
    expect(invalid.status).toBe(400);
    expect(readFileSync(join(root, "issue.schema.json"), "utf8")).toBe(schemaRead.body.content);
});

it("yields while reading a large local file and returns the complete source", async () => {
    const root = fixture();
    const source = "large file\n".repeat(200_000);
    writeFileSync(join(root, "large.txt"), source);
    let completed = false;
    const loading = textfileResponse(root, { action: "read", file: "large.txt" }).then((result) => {
        completed = true;
        return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    expect((await loading).body.content).toBe(source);
});

it("accepts only local UTF-8 draft overrides without writing them", () => {
    const root = fixture();
    expect(previewTextfiles(root, { "./new.rs": "draft 🦀" })).toEqual(
        new Map([["new.rs", "draft 🦀"]]),
    );
    expect(existsSync(join(root, "new.rs"))).toBe(false);
    for (const input of [
        null,
        [],
        { "../secret": "x" },
        { "https://example.com/file": "x" },
        { x: 1 },
        { x: "\0" },
        { x: "\ud800" },
    ]) {
        expect(() => previewTextfiles(root, input)).toThrow();
    }
});

it("reads, creates nested UTF-8 files and saves edits without changing line endings or permissions", async () => {
    const root = fixture();
    const file = "examples/日本語/hello.rs";
    const source = "// 日本語 🦀\r\nfn main() {}\r\n";
    expect(await textfileResponse(root, { action: "read", file })).toEqual({
        status: 200,
        body: { content: null },
    });
    expect(
        (await textfileResponse(root, { action: "save", file, content: source, base: null }))
            .status,
    ).toBe(200);
    expect((await textfileResponse(root, { action: "read", file })).body.content).toBe(source);
    chmodSync(join(root, file), 0o640);
    expect(
        (await textfileResponse(root, { action: "save", file, content: "", base: source })).status,
    ).toBe(200);
    expect(readFileSync(join(root, file), "utf8")).toBe("");
    expect(statSync(join(root, file)).mode & 0o777).toBe(0o640);
});

it("does not overwrite files created, edited or deleted after they were opened", async () => {
    const root = fixture();
    const file = "hello.rs";
    writeFileSync(join(root, file), "external");
    for (const base of [null, "old"]) {
        expect(
            (await textfileResponse(root, { action: "save", file, content: "mine", base })).status,
        ).toBe(409);
        expect(readFileSync(join(root, file), "utf8")).toBe("external");
    }
    rmSync(join(root, file));
    expect(
        (await textfileResponse(root, { action: "save", file, content: "mine", base: "external" }))
            .status,
    ).toBe(409);
    expect(existsSync(join(root, file))).toBe(false);
});

it("rejects outside paths, outside symlinks, broken symlinks, binary files and invalid requests", async () => {
    const root = fixture();
    const outside = fixture();
    writeFileSync(join(outside, "secret"), "outside");
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(outside, "missing"), join(root, "broken"));
    mkdirSync(join(root, "folder"));
    writeFileSync(join(root, "binary"), Buffer.from([0xff]));
    for (const file of [
        "../secret",
        join(outside, "secret"),
        "escape/secret",
        "escape/new/path.rs",
        "broken/file.rs",
        "folder",
        "binary",
        "..\\secret",
        "",
        "x\0y",
    ]) {
        for (const action of ["read", "save"]) {
            expect(
                (await textfileResponse(root, { action, file, content: "overwrite", base: null }))
                    .status,
                `${action} ${file}`,
            ).toBe(400);
        }
    }
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("outside");
    expect(existsSync(join(outside, "new"))).toBe(false);
    for (const input of [
        undefined,
        {},
        { file: 1, action: "read" },
        { file: "a", action: "delete" },
        { file: "a", action: "save", content: "missing base" },
        { file: "a", action: "save", content: 2, base: null },
        { file: "a", action: "save", content: "\0", base: null },
        { file: "a", action: "save", content: "\ud800", base: null },
    ])
        expect((await textfileResponse(root, input)).status).toBe(400);
    expect(existsSync(join(root, "a"))).toBe(false);
});

it("allows symlinks within the root while preserving the link itself", async () => {
    const root = fixture();
    writeFileSync(join(root, "actual.rs"), "old");
    symlinkSync(join(root, "actual.rs"), join(root, "alias.rs"));
    expect(
        (
            await textfileResponse(root, {
                action: "save",
                file: "alias.rs",
                content: "new",
                base: "old",
            })
        ).status,
    ).toBe(200);
    expect(readFileSync(join(root, "actual.rs"), "utf8")).toBe("new");
    expect((await textfileResponse(root, { action: "read", file: "alias.rs" })).body.content).toBe(
        "new",
    );
});
