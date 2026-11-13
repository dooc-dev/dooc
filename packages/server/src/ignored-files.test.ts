import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { compileSite } from "../../engine/src/compiler/compile.js";

it("refuses an ignored document even when the browser has a previously compiled copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-ignored-document-"));
    try {
        mkdirSync(join(root, "content"));
        writeFileSync(join(root, "dooc.yaml"), "docs: [secret]\n");
        writeFileSync(join(root, "content/secret.md"), "PRIVATE-CONTENT\n");
        vi.stubEnv("DOCS_ROOT", root);
        const { docQueryResponse, siteFrom } = await import("./serve.js");
        const site = siteFrom(compileSite(root));
        expect(docQueryResponse(site, "secret.md").status).toBe(200);
        writeFileSync(join(root, ".gitignore"), "content/secret.md\n");
        const response = docQueryResponse(site, "secret.md");
        expect(response.status).toBe(400);
        expect(JSON.stringify(response)).not.toContain("PRIVATE-CONTENT");
    } finally {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
    }
});
