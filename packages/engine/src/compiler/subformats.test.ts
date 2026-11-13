import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resourceIndex, resourceLibraryHtml } from "../../../server/src/resource-library.js";
import type { Subformat } from "../core/subformats.js";
import { filesSnapshot, updateFiles } from "./files.js";
import { readManifest } from "./manifest.js";
import { createDocOps } from "./ops.js";
import {
    compileSubformatSchema,
    loadSubformat,
    parseSubformatRecord,
    subformatResponse,
    validateSubformatRecord,
} from "./subformats.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["title", "status", "due"],
    additionalProperties: false,
    $defs: { status: { type: "string", enum: ["Todo", "Doing", "Done"] } },
    properties: {
        title: { type: "string", minLength: 1 },
        status: { $ref: "#/$defs/status", title: "Status" },
        due: { type: "string", format: "date" },
        updated: { type: "string", format: "date-time" },
        locked: { type: "string", enum: ["A", "B"], readOnly: true },
    },
};
const contents = {
    json:
        JSON.stringify({ title: "One", status: "Todo", due: "2026-11-10", locked: "A" }, null, 2) +
        "\n",
    yaml: "# Keep this comment\ntitle: One\nstatus: Todo # Status comment\ndue: 2026-11-10\nlocked: A\n",
    toml: 'title = "One"\nstatus = "Todo"\ndue = 2026-11-10\nupdated = 2026-11-10T09:00:00+09:00\nlocked = "A"\n',
};
const fixture = (format: Subformat["format"] = "yaml") => {
    const root = mkdtempSync(join(tmpdir(), "dooc-subformats-"));
    roots.push(root);
    mkdirSync(join(root, "schemas"));
    writeFileSync(join(root, "schemas/issue.json"), JSON.stringify(schema));
    const config: Subformat = { ext: "issue", format, schema: "schemas/issue.json" };
    writeFileSync(join(root, "dooc.yaml"), `docs: []\nsubformats: ${JSON.stringify([config])}\n`);
    writeFileSync(join(root, "one.issue"), contents[format]);
    return { root, config };
};

it("reuses unchanged schema validators and immediately validates schema edits", () => {
    const { root, config } = fixture();
    const first = loadSubformat(root, config);
    expect(loadSubformat(root, config).validate).toBe(first.validate);
    const record = parseSubformatRecord(contents.yaml, "yaml");
    expect(() => validateSubformatRecord(first, record)).not.toThrow();

    writeFileSync(
        join(root, config.schema),
        JSON.stringify({ ...schema, required: [...schema.required, "updated"] }),
    );
    const changed = loadSubformat(root, config);
    expect(changed.validate).not.toBe(first.validate);
    expect(() => validateSubformatRecord(changed, record)).toThrow("updated");
    writeFileSync(join(root, config.schema), "{}");
    expect(() => loadSubformat(root, config)).not.toThrow();
    writeFileSync(join(root, config.schema), '{"type":"invalid"}');
    expect(() => loadSubformat(root, config)).toThrow();
    writeFileSync(join(root, config.schema), Buffer.from([0xff]));
    expect(() => loadSubformat(root, config)).toThrow();
    rmSync(join(root, config.schema));
    expect(() => loadSubformat(root, config)).toThrow();
});

it.each([
    "legacy",
    "nested",
])("saves card layouts in %s manifests without changing records or other settings", (kind) => {
    const { root, config } = fixture();
    const key = kind === "nested" ? "json_subformats" : "subformats";
    writeFileSync(
        join(root, "dooc.yaml"),
        `# Keep this comment\n${kind === "nested" ? "center_contents" : "docs"}: []\n${key}:\n  - ext: issue # Keep format comment\n    format: yaml\n    schema: schemas/issue.json\n  - ext: note\n    format: yaml\n    schema: schemas/issue.json\ndefault_subformat_folder: records\n`,
    );
    const request = {
        action: "layouts",
        ext: "issue",
        key: "card_title",
        value: "due",
        base: null,
    };
    expect(subformatResponse(root, request)).toEqual({ status: 200, body: { file: "dooc.yaml" } });
    expect(readManifest(root).subformats).toEqual([
        { ...config, layouts: { card_title: "due" } },
        { ...config, ext: "note" },
    ]);
    expect(readManifest(root).defaultSubformatFolder).toBe("records");
    const saved = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(saved).toContain("# Keep this comment");
    expect(saved).toContain("# Keep format comment");
    expect(resourceIndex(root, [config.schema, "one.issue"]).subformats[0]?.layouts).toEqual({
        card_title: "due",
    });
    expect(subformatResponse(root, { ...request, value: "title" }).status).toBe(409);
    for (const change of [
        { value: "missing" },
        { value: 3 },
        { key: "unknown" },
        { ext: "missing" },
        { base: 3 },
    ]) {
        expect(subformatResponse(root, { ...request, base: "due", ...change }).status).toBe(400);
        expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(saved);
    }
    expect(subformatResponse(root, { ...request, value: "", base: "due" }).status).toBe(200);
    expect(readManifest(root).subformats?.[0]?.layouts).toEqual({ card_title: "" });
    for (const [key, value] of [
        ["group_by", "status"],
        ["sort_by", "due"],
        ["sort_order", "desc"],
    ]) {
        expect(subformatResponse(root, { ...request, key, value }).status).toBe(200);
    }
    expect(readManifest(root).subformats?.[0]?.layouts).toEqual({
        card_title: "",
        group_by: "status",
        sort_by: "due",
        sort_order: "desc",
    });
    const beforeInvalid = readFileSync(join(root, "dooc.yaml"), "utf8");
    for (const change of [
        { key: "group_by", value: "due", base: "status" },
        { key: "sort_order", value: "sideways", base: "desc" },
    ]) {
        expect(subformatResponse(root, { ...request, ...change }).status).toBe(400);
        expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(beforeInvalid);
    }
    expect(readFileSync(join(root, "one.issue"), "utf8")).toBe(contents.yaml);
});

it.each([
    "legacy",
    "nested",
])("deletes only the selected %s subformat registration and sidebar page", (kind) => {
    const { root, config } = fixture();
    const nested = kind === "nested";
    writeFileSync(
        join(root, "dooc.yaml"),
        `# Keep this comment\n${nested ? "center_contents" : "docs"}:\n  - subformat: issue\n    title: Issues\n${nested ? "json_subformats" : "subformats"}:\n  - ext: issue\n    format: yaml\n    schema: schemas/issue.json\n  - ext: note # Keep other format comment\n    format: yaml\n    schema: schemas/issue.json\ndefault_subformat_folder: records\n`,
    );
    const beforeSchema = readFileSync(join(root, config.schema), "utf8");
    const request = { action: "delete", ext: "issue", base: config };
    const before = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(
        subformatResponse(root, { ...request, base: { ...config, format: "json" } }).status,
    ).toBe(409);
    expect(subformatResponse(root, { ...request, base: undefined }).status).toBe(400);
    expect(subformatResponse(root, { ...request, ext: "missing" }).status).toBe(400);
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(before);
    expect(subformatResponse(root, request)).toEqual({ status: 200, body: { file: "dooc.yaml" } });
    const manifest = readManifest(root);
    expect(manifest.errors).toEqual([]);
    expect(manifest.tree).toEqual([]);
    expect(manifest.subformats).toEqual([{ ...config, ext: "note" }]);
    expect(manifest.defaultSubformatFolder).toBe("records");
    const saved = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(saved).toContain("# Keep this comment");
    expect(saved).toContain("# Keep other format comment");
    expect(readFileSync(join(root, config.schema), "utf8")).toBe(beforeSchema);
    expect(readFileSync(join(root, "one.issue"), "utf8")).toBe(contents.yaml);
    expect(
        subformatResponse(root, { action: "delete", ext: "note", base: { ...config, ext: "note" } })
            .status,
    ).toBe(200);
    expect(readManifest(root).subformats).toEqual([]);
});

it("keeps child pages and changed definitions when deleting a subformat", () => {
    const { root, config } = fixture();
    writeFileSync(
        join(root, "dooc.yaml"),
        `docs: [{subformat: issue, title: Issues, children: [guide]}]\nsubformats: ${JSON.stringify([config])}\n`,
    );
    const before = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(subformatResponse(root, { action: "delete", ext: "issue", base: config })).toMatchObject(
        {
            status: 400,
            body: { error: "Move or remove this subformat page's child pages before deleting it." },
        },
    );
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(before);
    writeFileSync(
        join(root, "dooc.yaml"),
        `docs: []\nsubformats: ${JSON.stringify([{ ...config, layouts: { card_title: "title" } }])}\n`,
    );
    expect(subformatResponse(root, { action: "delete", ext: "issue", base: config }).status).toBe(
        409,
    );
});

it.each([
    "legacy",
    "nested",
])("registers a subformat and schema without overwriting %s settings", (kind) => {
    const { root, config } = fixture();
    writeFileSync(
        join(root, "dooc.yaml"),
        `# Keep this comment\n${kind === "nested" ? "center_contents: []\njson_subformats" : "docs: []\nsubformats"}: ${JSON.stringify([config])}\ndefault_subformat_folder: records\n`,
    );
    const result = subformatResponse(root, { action: "register", ext: "note", format: "json" });
    expect(result.status).toBe(200);
    expect(result.body.collection).toMatchObject({
        ext: "note",
        schema: "note.schema.json",
        format: "json",
        change: "added",
        defaultFolder: "records",
    });
    expect(existsSync(join(root, result.body.collection?.schema ?? "missing"))).toBe(true);
    expect(readManifest(root).subformats?.map((item) => item.ext)).toEqual(["issue", "note"]);
    const raw = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(raw).toContain("# Keep this comment");
    expect(readManifest(root).defaultSubformatFolder).toBe("records");
    expect(
        subformatResponse(root, { action: "register", ext: "note", format: "yaml" }).status,
    ).toBe(400);
    expect(
        subformatResponse(root, {
            action: "register",
            ext: "bad",
            format: "json",
            schema: "../outside.json",
        }).status,
    ).toBe(400);
    expect(
        subformatResponse(root, { action: "register", ext: ".bad", format: "json" }).status,
    ).toBe(400);
    writeFileSync(join(root, "invalid.json"), "invalid schema");
    expect(
        subformatResponse(root, {
            action: "register",
            ext: "bad",
            format: "json",
            schema: "invalid.json",
        }).status,
    ).toBe(400);
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(raw);
    const schema = readFileSync(join(root, config.schema), "utf8");
    expect(
        subformatResponse(root, {
            action: "register",
            ext: "task",
            format: "toml",
            schema: config.schema,
        }).status,
    ).toBe(200);
    expect(readFileSync(join(root, config.schema), "utf8")).toBe(schema);
});

it.each([
    "json",
    "yaml",
    "toml",
] as const)("creates %s records without overwriting existing files", (format) => {
    const { root, config } = fixture(format);
    const template = parseSubformatRecord(loadSubformat(root, config).template, format);
    expect(template).toMatchObject({ title: "", status: "Todo" });
    expect(template.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const file = "nested/new.issue";
    const response = subformatResponse(root, { action: "create", file, content: contents[format] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(parseSubformatRecord(contents[format], format));
    expect(readFileSync(join(root, file), "utf8")).toBe(contents[format]);
    expect(
        subformatResponse(root, { action: "create", file, content: contents[format] }).status,
    ).toBe(409);
    expect(
        subformatResponse(root, { action: "create", file: "bad.issue", content: "{}" }).status,
    ).toBe(400);
    expect(
        subformatResponse(root, {
            action: "create",
            file: "../outside.issue",
            content: contents[format],
        }).status,
    ).toBe(400);
    expect(
        subformatResponse(root, { action: "create", file: "bad.txt", content: contents[format] })
            .status,
    ).toBe(400);
    expect(readFileSync(join(root, file), "utf8")).toBe(contents[format]);
});

it.each([
    "json",
    "yaml",
    "toml",
] as const)("validates and saves enum moves in %s without changing other values", (format) => {
    const { root, config } = fixture(format);
    const loaded = loadSubformat(root, config);
    expect(loaded.fields).toContainEqual({
        name: "status",
        title: "Status",
        type: "string",
        enum: ["Todo", "Doing", "Done"],
    });
    const before = parseSubformatRecord(contents[format], format);
    expect(() => validateSubformatRecord(loaded, before)).not.toThrow();
    const response = subformatResponse(root, {
        file: "one.issue",
        base: contents[format],
        field: "status",
        value: "Done",
    });
    expect(response.status).toBe(200);
    const saved = readFileSync(join(root, "one.issue"), "utf8");
    expect(parseSubformatRecord(saved, format)).toEqual({ ...before, status: "Done" });
    if (format === "yaml") {
        expect(saved).toContain("# Keep this comment");
        expect(saved).toContain("# Status comment");
    }
    if (format === "toml") expect(saved).toContain("due = 2026-11-10");
    const index = resourceIndex(
        root,
        filesSnapshot(root).files.map((file) => file.path),
    );
    expect(index.errors).toEqual([]);
    expect(index.subformats[0]?.records).toMatchObject([
        { file: "one.issue", data: { status: "Done" } },
    ]);
    expect(index.codeblocks[0]).toMatchObject({ format: "issue", language: format });
    expect(resourceLibraryHtml(index, "codeblocks")).toContain('value="issue"');
    const board = resourceLibraryHtml(index, "subformats");
    expect(board).toContain('<option value="issue">issue</option>');
    expect(board).toContain('role="region"');
    expect(board).toContain("data-subformats");
    expect(board).not.toContain('value=""');
    expect(board).not.toContain("resource-code");
});

it("rejects invalid enum moves, readonly fields, schema violations and stale writes without overwriting", () => {
    const { root } = fixture();
    const request = { file: "one.issue", base: contents.yaml, field: "status", value: "Doing" };
    for (const change of [
        { value: "Unknown" },
        { field: "title" },
        { field: "locked", value: "B" },
        { file: "../one.issue" },
        { base: null },
    ]) {
        expect(subformatResponse(root, { ...request, ...change }).status).toBe(400);
        expect(readFileSync(join(root, "one.issue"), "utf8")).toBe(contents.yaml);
    }
    const invalid = contents.yaml.replace("2026-11-10", "2026-02-30");
    writeFileSync(join(root, "one.issue"), invalid);
    expect(subformatResponse(root, request).status).toBe(409);
    expect(subformatResponse(root, { ...request, base: invalid }).status).toBe(400);
    expect(readFileSync(join(root, "one.issue"), "utf8")).toBe(invalid);
});

it("keeps multiple subformats in configuration order and parses each only in its declared format", () => {
    const { root, config } = fixture();
    const release = { ext: "release", format: "json", schema: config.schema };
    writeFileSync(
        join(root, "dooc.yaml"),
        `docs: []\nsubformats: ${JSON.stringify([release, config])}\n`,
    );
    writeFileSync(join(root, "one.release"), contents.json);
    writeFileSync(join(root, "wrong.issue"), contents.toml);
    writeFileSync(join(root, "wrong.release"), contents.yaml);
    const index = resourceIndex(
        root,
        filesSnapshot(root).files.map((file) => file.path),
    );
    expect(index.subformats.map((format) => [format.ext, format.records.length])).toEqual([
        ["release", 1],
        ["issue", 1],
    ]);
    expect(index.errors).toHaveLength(2);
    const html = resourceLibraryHtml(index, "subformats");
    expect(html).toContain('<option value="release">release</option>');
    expect(html).toContain('<option value="issue">issue</option>');
    expect(html.indexOf('<option value="release"')).toBeLessThan(
        html.indexOf('<option value="issue"'),
    );
});

it("keeps unreadable and invalid records out of cards and escapes record content in page data", () => {
    const { root } = fixture("json");
    writeFileSync(
        join(root, "one.issue"),
        JSON.stringify({
            title: "</template><script>bad()</script>",
            status: "Todo",
            due: "2026-11-10",
        }),
    );
    writeFileSync(join(root, "broken.issue"), "[");
    writeFileSync(join(root, "array.issue"), "[]");
    const outside = fixture().root;
    symlinkSync(join(outside, "one.issue"), join(root, "alias.issue"));
    expect(
        subformatResponse(root, {
            file: "alias.issue",
            base: contents.yaml,
            field: "status",
            value: "Done",
        }).status,
    ).toBe(400);
    const index = resourceIndex(
        root,
        filesSnapshot(root).files.map((file) => file.path),
    );
    expect(index.subformats[0]?.records).toHaveLength(1);
    expect(index.errors).toHaveLength(2);
    const html = resourceLibraryHtml(index, "codeblocks");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/template&gt;&lt;script&gt;");
});

it("preserves configuration through document operations and updates moved schema paths", () => {
    const { root, config } = fixture();
    expect(createDocOps(root).add("guide", "Guide")).toMatchObject({ id: "guide" });
    expect(readManifest(root).subformats).toEqual([config]);
    updateFiles(root, {
        action: "rename",
        file: config.schema,
        name: "renamed.json",
        revision: filesSnapshot(root).revision,
    });
    expect(readManifest(root).subformats?.[0]?.schema).toBe("schemas/renamed.json");
    expect(
        resourceIndex(
            root,
            filesSnapshot(root).files.map((file) => file.path),
        ).errors,
    ).toEqual([]);
});

it("rejects non-JSON numeric values and defaults schemas to 2020-12", () => {
    expect(() => parseSubformatRecord("value = inf", "toml")).toThrow("finite JSON-compatible");
    expect(() => parseSubformatRecord("value = 9007199254740993", "toml")).toThrow(
        "finite JSON-compatible",
    );
    const { root, config } = fixture("json");
    writeFileSync(
        join(root, config.schema),
        JSON.stringify({ type: "object", properties: { status: { enum: ["Todo", "Done"] } } }),
    );
    expect(
        subformatResponse(root, {
            file: "one.issue",
            base: contents.json,
            field: "status",
            value: "Done",
        }).status,
    ).toBe(200);
});

it("requires strict 2020-12 schemas before registration writes any files", () => {
    const { root } = fixture();
    const before = readFileSync(join(root, "dooc.yaml"), "utf8");
    for (const invalid of [
        { ...schema, $schema: "http://json-schema.org/draft-07/schema#" },
        { ...schema, typo: true },
        { ...schema, required: ["missing"] },
        { ...schema, properties: { title: { minLength: 1 } } },
        { ...schema, properties: { title: { type: "string", format: "unknown" } } },
    ]) {
        const content = JSON.stringify(invalid);
        expect(() => compileSubformatSchema(content)).toThrow();
        expect(subformatResponse(root, { action: "validate", content }).status).toBe(400);
        expect(
            subformatResponse(root, { action: "register", ext: "bad", format: "json", content })
                .status,
        ).toBe(400);
    }
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(before);
    expect(existsSync(join(root, "bad.schema.json"))).toBe(false);
    const content = JSON.stringify(schema, null, 2);
    const created = subformatResponse(root, {
        action: "register",
        ext: "custom",
        format: "json",
        content,
    });
    expect(created.status).toBe(200);
    expect(readFileSync(join(root, created.body.collection?.schema ?? "missing"), "utf8")).toBe(
        content,
    );
    expect(
        subformatResponse(root, {
            action: "register",
            ext: "other",
            format: "json",
            schema: created.body.collection?.schema ?? "missing",
            content: "{}",
        }).status,
    ).toBe(409);
});

it("validates linked sample records, their create templates, and cross-schema references", () => {
    const root = join(process.cwd(), "dooc-docs");
    const configs = readManifest(root).subformats ?? [];
    // The reference workspace grows; every record type listed below must stay in it.
    expect(configs.map((config) => config.ext)).toEqual(
        expect.arrayContaining(["team", "project", "milestone", "issue", "note"]),
    );
    // Each value has the shape of another record type's reference.
    const invalid: Record<string, Record<string, unknown>> = {
        team: { lead: "Not An Id" },
        project: { team: "contents/issue/write-getting-started.issue" },
        milestone: { project: "contents/team/docs.team" },
        issue: { project: "contents/team/docs.team" },
        note: { issues: ["contents/project/sample-refresh.project"] },
    };
    for (const config of configs.filter((item) => item.ext in invalid)) {
        const format = loadSubformat(root, config);
        expect(() =>
            validateSubformatRecord(format, parseSubformatRecord(format.template, config.format)),
        ).not.toThrow();
        const directory = `contents/${config.ext}`;
        const files = readdirSync(join(root, directory));
        expect(files.length).toBeGreaterThan(1);
        for (const file of files) {
            const record = parseSubformatRecord(
                readFileSync(join(root, directory, file), "utf8"),
                config.format,
            );
            expect(() => validateSubformatRecord(format, record)).not.toThrow();
            expect(() =>
                validateSubformatRecord(format, { ...record, ...invalid[config.ext] }),
            ).toThrow();
        }
    }
});

it("changes only a TOML enum value, preserving quoted keys, comments, tables and CRLF", () => {
    const { root, config } = fixture("toml");
    writeFileSync(
        join(root, config.schema),
        JSON.stringify({
            ...schema,
            properties: { ...schema.properties, details: { type: "object" } },
        }),
    );
    const base = `${contents.toml}[details]\nstatus = "Todo" # Unrelated field\n`
        .replace('status = "Todo"', "'status' = '''Todo''' # Keep this comment")
        .replaceAll("\n", "\r\n");
    writeFileSync(join(root, "one.issue"), base);
    const result = subformatResponse(root, {
        file: "one.issue",
        base,
        field: "status",
        value: "Done",
    });
    expect(result.status).toBe(200);
    expect(readFileSync(join(root, "one.issue"), "utf8")).toBe(
        base.replace("'''Todo'''", '"Done"'),
    );
    const missing = base.replace("'status' = '''Todo''' # Keep this comment\r\n", "");
    writeFileSync(join(root, "one.issue"), missing);
    expect(
        subformatResponse(root, {
            file: "one.issue",
            base: missing,
            field: "status",
            value: "Doing",
        }).status,
    ).toBe(200);
    expect(readFileSync(join(root, "one.issue"), "utf8")).toBe(`status = "Doing"\r\n${missing}`);
});
