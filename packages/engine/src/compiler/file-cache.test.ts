import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createFileCache } from "./file-cache.js";

it("reloads equal-size edits with unchanged timestamps and reuses identical parsed contents", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-cache-"));
    const file = join(root, "value.txt");
    const cache = createFileCache<{ raw: string }>();
    const parse = vi.fn((raw: string) => ({ raw }));
    try {
        writeFileSync(file, "jpn");
        const stamp = statSync(file).mtime;
        utimesSync(file, stamp, stamp);
        const first = cache.get(file, parse);
        expect(cache.get(file, parse)).toBe(first);
        writeFileSync(file, "eng");
        utimesSync(file, stamp, stamp);
        expect(cache.get(file, parse)).toEqual({ raw: "eng" });
        expect(parse).toHaveBeenCalledTimes(2);
        rmSync(file);
        expect(() => cache.get(file, parse)).toThrow();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
