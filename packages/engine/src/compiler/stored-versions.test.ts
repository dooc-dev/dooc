import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
    prepareStoredVersion,
    storedDocumentVersions,
    storedVersionRoot,
} from "./stored-versions.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("retains source versions only after successful builds and detects concurrent builds", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-hash-versions-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
    writeFileSync(join(root, "content/guide.md"), "Original\n");
    const config = { major: 2, minor: "hash", patch: "hash" } as const;
    const first = prepareStoredVersion(root, config);
    expect(first.version).toBe("2.0.0");
    expect(storedDocumentVersions(root)).toEqual([]);
    first.commit();
    const same = prepareStoredVersion(root, config);
    expect(same.version).toBe("2.0.0");
    same.commit();
    writeFileSync(join(root, "content/guide.md"), "Changed\n");
    const next = prepareStoredVersion(root, config);
    const concurrent = prepareStoredVersion(root, config);
    expect(next.version).toBe("2.0.1");
    writeFileSync(join(root, ".dooc/versions.lock"), "");
    expect(() => next.commit()).toThrow("locked");
    expect(storedDocumentVersions(root)).toHaveLength(1);
    rmSync(join(root, ".dooc/versions.lock"));
    next.commit();
    expect(() => concurrent.commit()).toThrow("changed during the build");
    const rows = storedDocumentVersions(root);
    expect(rows.map((row) => row.version)).toEqual(["2.0.0", "2.0.1"]);
    const snapshot = storedVersionRoot(root, rows[0]?.revision ?? "");
    expect(readFileSync(join(snapshot, "content/guide.md"), "utf8")).toBe("Original\n");
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\ntitle: New title\n");
    expect(prepareStoredVersion(root, config).version).toBe("2.1.0");
    expect(() => storedVersionRoot(root, "../other")).toThrow();
});
