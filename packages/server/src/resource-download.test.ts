import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readDownloadFile } from "./resource-download.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-download-"));
    roots.push(root);
    writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
    return root;
};

it("downloads the current file bytes, including binary data and encoded filenames", () => {
    const root = fixture();
    const file = "source & data.bin";
    const data = Buffer.from([0, 10, 13, 255]);
    writeFileSync(join(root, file), data);
    expect(readDownloadFile(root, file)).toEqual(data);
    writeFileSync(join(root, file), "Updated\r\n");
    expect(readDownloadFile(root, file)).toEqual(Buffer.from("Updated\r\n"));
});

it("refuses missing, ignored, hidden, directory, traversal and symlink downloads", () => {
    const root = fixture();
    const outside = fixture();
    writeFileSync(join(root, ".gitignore"), "private.txt\n");
    writeFileSync(join(root, "private.txt"), "Private");
    writeFileSync(join(root, ".env"), "Secret");
    writeFileSync(join(outside, "secret.txt"), "Outside");
    mkdirSync(join(root, "directory"));
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    for (const file of [
        undefined,
        null,
        "",
        "missing.txt",
        "private.txt",
        ".env",
        "directory",
        "../secret.txt",
        join(outside, "secret.txt"),
        "link.txt",
    ])
        expect(() => readDownloadFile(root, file)).toThrow("not available for download");
});
