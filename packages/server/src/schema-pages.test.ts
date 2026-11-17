import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { compileSite } from "../../engine/src/compiler/compile.js";
import { subformatSchemaPath } from "../../engine/src/core/routing.js";
import { buildBundle } from "./build.js";
import { pageDataResponse, publishHtml, siteFrom } from "./serve.js";

vi.mock("./serve.js", async (original) => ({
    ...(await original<typeof import("./serve.js")>()),
    bundleClient: vi.fn().mockResolvedValue(""),
}));

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-schema-pages-"));
    roots.push(root);
    mkdirSync(join(root, "schemas"));
    const write = (file: string, content: string) => writeFileSync(join(root, file), content);
    write(
        "dooc.yaml",
        "docs: [{subformat: issue, title: Issues}]\nsubformats: [{ext: issue, format: json, schema: schemas/issue.json}]\n",
    );
    write(
        "schemas/issue.json",
        JSON.stringify({
            type: "object",
            title: "Issue definition",
            properties: {
                title: { type: "string" },
                status: { $ref: "common.json#/$defs/status" },
            },
            required: ["title", "status"],
        }),
    );
    write(
        "schemas/common.json",
        '{"$defs":{"status":{"type":"string","enum":["Todo","Done"],"description":"Shared status"}}}',
    );
    write("one.issue", '{"title":"First","status":"Todo"}');
    const site = () => ({ ...siteFrom(compileSite(root)), root });
    return { root, write, site };
};

it("opens the schema by extension and keeps that URL after its registered file moves", () => {
    const { root, write, site } = fixture();
    const path = subformatSchemaPath("issue");
    const response = pageDataResponse(site(), path);
    expect(response).toMatchObject({ status: 200, body: { resource: true, path } });
    const html = (response.body as { html: string }).html;
    expect(html).toContain('class="res-page json-schema-page"');
    expect(html).toContain("Shared status");
    expect(html).toContain("Required");
    expect(html).toContain('href="/_files/file/schemas%2Fissue.json"');
    expect(html).not.toContain(root);
    renameSync(join(root, "schemas/issue.json"), join(root, "schemas/renamed.json"));
    write(
        "dooc.yaml",
        readFileSync(join(root, "dooc.yaml"), "utf8").replace(
            "schemas/issue.json",
            "schemas/renamed.json",
        ),
    );
    expect(pageDataResponse(site(), path)).toMatchObject({ status: 200 });
    expect(JSON.stringify(pageDataResponse(site(), path).body)).toContain("Shared status");
    expect(pageDataResponse(site(), subformatSchemaPath("unknown"))).toMatchObject({ status: 404 });
    expect(pageDataResponse(site(), subformatSchemaPath("../issue"))).toMatchObject({
        status: 404,
    });
});

it("reports unavailable and invalid schemas without exposing ignored files", () => {
    const { root, write, site } = fixture();
    write("schemas/issue.json", "{ broken JSON");
    expect(JSON.stringify(pageDataResponse(site(), subformatSchemaPath("issue")).body)).toContain(
        'role=\\"alert\\"',
    );
    write(".gitignore", "schemas/issue.json\n");
    const response = pageDataResponse(site(), subformatSchemaPath("issue"));
    expect(JSON.stringify(response.body)).toContain(
        "Subformat schema is not available in the workspace",
    );
    expect(JSON.stringify(response.body)).not.toContain("broken JSON");
    rmSync(join(root, "schemas/issue.json"));
    expect(pageDataResponse(site(), subformatSchemaPath("issue"))).toMatchObject({ status: 200 });
});

it("includes readable schema pages and their sources in standalone HTML from the build root", async () => {
    const { root, site } = fixture();
    for (const html of [
        publishHtml(site(), ""),
        (await buildBundle(root, { format: "html" })).data,
    ]) {
        expect(html).toContain('data-route="_files/schema/issue"');
        expect(html).toContain("Issue definition");
        expect(html).toContain("Shared status");
        expect(html).toContain('href="#/_files/file/schemas%2Fissue.json"');
        expect(html).toContain('data-route="_files/file/schemas%2Fissue.json"');
        expect(html).not.toContain(root);
    }
});
