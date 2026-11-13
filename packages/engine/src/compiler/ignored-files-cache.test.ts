import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ignoredFiles, withIgnoredFilesCache } from "./ignored-files.js";

it("reuses only the current read and rechecks ignore changes after success or failure", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-ignore-cache-"));
    try {
        mkdirSync(join(root, "nested"));
        writeFileSync(join(root, ".gitignore"), "secret\n");
        withIgnoredFilesCache(() => {
            expect(ignoredFiles(root, ["secret", "public"])).toEqual(new Set(["secret"]));
            writeFileSync(join(root, ".gitignore"), "public\n");
            expect(withIgnoredFilesCache(() => ignoredFiles(root, ["secret", "public"]))).toEqual(
                new Set(["secret"]),
            );
            expect(ignoredFiles(join(root, "nested"), ["secret", "public"])).toEqual(new Set());
        });
        expect(ignoredFiles(root, ["secret", "public"])).toEqual(new Set(["public"]));
        expect(() =>
            withIgnoredFilesCache(() => {
                ignoredFiles(root, ["public"]);
                throw new Error("read failed");
            }),
        ).toThrow("read failed");
        writeFileSync(join(root, ".gitignore"), "secret\n");
        expect(withIgnoredFilesCache(() => ignoredFiles(root, ["public"]))).toEqual(new Set());
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
