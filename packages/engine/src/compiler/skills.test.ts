import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { parseManifest, serializeManifest } from "../core/content-metadata.js";
import { checkSite } from "./check.js";
import { exportEntries } from "./export.js";
import { filesSnapshot, updateFiles } from "./files.js";
import { projectRoot, readManifest } from "./manifest.js";
import { createDocOps } from "./ops.js";
import { readProjectSkills } from "./skills.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const source =
    "---\nname: review-docs\ndescription: Apply the project checklist.\nmetadata:\n  owner: project-team\n---\nRead references/checklist.md.\n";
const fixture = (directory = ".agents/skills/review-docs") => {
    const root = mkdtempSync(join(tmpdir(), "dooc-skills-"));
    roots.push(root);
    const write = (file: string, content: string | Buffer) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), content);
    };
    const file = `${directory}/SKILL.md`;
    write("dooc.yaml", stringify({ system: { skills: [file] }, document: {} }));
    write(file, source);
    write(`${directory}/references/checklist.md`, "Check the current project documents.\n");
    write(`${directory}/scripts/check.js`, 'throw new Error("Must never execute");\n');
    write(`${directory}/assets/sample.bin`, Buffer.from([0, 255, 128]));
    return { root, directory, file, write };
};

it("retains project skill paths through manifest serialization and document edits", () => {
    const { root, file } = fixture();
    const manifest = readManifest(root);
    expect(manifest.errors).toEqual([]);
    expect(parseManifest(parse(serializeManifest(manifest.tree, manifest)))).toEqual(manifest);
    expect(createDocOps(root).add("guide", "Guide")).not.toHaveProperty("error");
    expect(readManifest(root).skills).toEqual([file]);
    expect(readProjectSkills(root)[0]?.frontmatter.metadata).toEqual({ owner: "project-team" });
});

it.each([
    null,
    "skills/review-docs/SKILL.md",
    {},
    [42],
    ["SKILL.md"],
    [""],
    ["../review-docs/SKILL.md"],
    ["/skills/review-docs/SKILL.md"],
    ["https://example.com/review-docs/SKILL.md"],
    [".dooc/private/SKILL.md"],
    ["skills/../review-docs/SKILL.md"],
    ["skills\\review-docs\\SKILL.md"],
    ["skills/review-docs/SKILL.md", "skills/review-docs/SKILL.md"],
])("rejects invalid project skill paths: %j", (skills) => {
    expect(parseManifest({ system: { skills }, document: {} }).errors.join()).toContain(
        "system.skills",
    );
});

it("exposes only the selected project's explicit list, including named manifests", () => {
    const { root, write, file } = fixture();
    write("other.dooc.yaml", stringify({ document: { url: "dooc.yaml" } }));
    projectRoot(join(root, "other.dooc.yaml"));
    expect(readProjectSkills(root)).toEqual([]);
    expect(readProjectSkills(root, "dooc.yaml").map((skill) => skill.file)).toEqual([file]);
    write("other.dooc.yaml", stringify({ system: { skills: [] }, document: {} }));
    expect(readProjectSkills(root)).toEqual([]);
    const other = fixture();
    other.write(other.file, source.replace("project-team", "second-project"));
    expect(readProjectSkills(other.root)[0]?.frontmatter.metadata).toEqual({
        owner: "second-project",
    });
});

it("exports complete skill directories with skill-relative references and exact bytes", () => {
    const { root, directory, write } = fixture();
    write(".gitignore", `${directory}/private.txt\n`);
    write(`${directory}/private.txt`, "Private");
    write(`${directory}/.env`, "Private");
    write(".agents/skills/unlisted/SKILL.md", "Not published");
    write(
        "child/dooc.yaml",
        stringify({ system: { skills: ["skills/review-docs/SKILL.md"] }, document: {} }),
    );
    write("child/skills/review-docs/SKILL.md", source);
    write(
        "dooc.yaml",
        stringify({
            system: { skills: [`${directory}/SKILL.md`] },
            document: { url: "child/dooc.yaml" },
        }),
    );
    const entries = exportEntries(root);
    expect(entries.map((entry) => entry.name)).toEqual(
        expect.arrayContaining([
            `${directory}/SKILL.md`,
            `${directory}/references/checklist.md`,
            `${directory}/scripts/check.js`,
            `${directory}/assets/sample.bin`,
            "child/skills/review-docs/SKILL.md",
        ]),
    );
    expect(entries.some((entry) => /private|\.env|unlisted/.test(entry.name))).toBe(false);
    for (const entry of entries) expect(entry.data).toEqual(readFileSync(join(root, entry.name)));
    expect(readProjectSkills(root)).toHaveLength(1);
});

it("preserves skill directories during restructuring and rejects moves that split them", () => {
    const { root, file, write } = fixture("skills/review-docs");
    write("note.txt", "Project document");
    updateFiles(root, { action: "restructure", revision: filesSnapshot(root).revision });
    expect(readProjectSkills(root)[0]?.files.get("SKILL.md")?.toString()).toBe(source);
    expect(readManifest(root).skills).toEqual([file]);
    expect(readFileSync(join(root, "files/txt/note.txt"), "utf8")).toBe("Project document");
    expect(() =>
        updateFiles(root, {
            action: "rename",
            file,
            name: "other.md",
            revision: filesSnapshot(root).revision,
        }),
    ).toThrow("Keep configured skill directories intact");
    expect(() =>
        updateFiles(root, {
            action: "move",
            paths: ["files/txt/note.txt"],
            directory: "skills/review-docs",
            revision: filesSnapshot(root).revision,
        }),
    ).toThrow("Keep configured skill directories intact");
});

it("keeps included skill manifests and hidden skill folders together", () => {
    const { root, write } = fixture();
    write(
        "child/dooc.yaml",
        stringify({ system: { skills: [".agents/skills/review-docs/SKILL.md"] }, document: {} }),
    );
    write("child/.agents/skills/review-docs/SKILL.md", source);
    write("dooc.yaml", stringify({ document: { url: "child/dooc.yaml" } }));
    updateFiles(root, { action: "restructure", revision: filesSnapshot(root).revision });
    expect(readProjectSkills(root)).toEqual([]);
    expect(readProjectSkills(root, "child/dooc.yaml")[0]?.file).toBe(
        "child/.agents/skills/review-docs/SKILL.md",
    );
    expect(() =>
        updateFiles(root, {
            action: "move",
            paths: ["child"],
            directory: "moved",
            revision: filesSnapshot(root).revision,
        }),
    ).toThrow("Keep configured skill directories intact");
});

it.each([
    "No frontmatter",
    "---\nname: review-docs\n---\n",
    "---\n[]\n---\n",
    source.replace("review-docs", "other-name"),
    source.replace("review-docs", "Review-docs"),
    source.replace("Apply the project checklist.", ""),
    source.replace("project-team", "42"),
])("rejects malformed skill metadata: %s", (content) => {
    const { root, file, write } = fixture();
    write(file, content);
    expect(() => readProjectSkills(root)).toThrow();
    expect(checkSite(root, { only: ["render"] }).diagnostics).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ code: "MANIFEST_INVALID", severity: "error" }),
        ]),
    );
});

it("rejects duplicate names, missing files and ignored entry files", () => {
    const { root, file, write } = fixture();
    write("skills/review-docs/SKILL.md", source);
    write(
        "dooc.yaml",
        stringify({ system: { skills: [file, "skills/review-docs/SKILL.md"] }, document: {} }),
    );
    expect(() => readProjectSkills(root)).toThrow("Duplicate skill name");
    rmSync(join(root, "skills/review-docs/SKILL.md"));
    expect(() => readProjectSkills(root)).toThrow("Missing or ignored skill file");
    write(".gitignore", `${file}\n`);
    expect(() => readProjectSkills(root)).toThrow("ignored");
});

it("rejects symlinks inside skills and in configured paths", () => {
    const { root, directory, write } = fixture();
    const other = fixture();
    write("secret.txt", "Private project file");
    for (const target of [join(root, "secret.txt"), join(other.root, other.file)]) {
        const link = join(root, directory, "reference.md");
        symlinkSync(target, link);
        expect(() => readProjectSkills(root)).toThrow("symlink");
        expect(() => exportEntries(root)).toThrow("symlink");
        rmSync(link);
    }
    symlinkSync(join(root, ".agents"), join(root, "linked"), "dir");
    write(
        "dooc.yaml",
        stringify({ system: { skills: ["linked/skills/review-docs/SKILL.md"] }, document: {} }),
    );
    expect(() => readProjectSkills(root)).toThrow("symlink");
});

it("bounds the bytes and number of files in a published skill", () => {
    const { root, directory, write } = fixture();
    write(`${directory}/large.bin`, Buffer.alloc(16 * 1024 * 1024));
    expect(() => readProjectSkills(root)).toThrow("16 MiB");
    rmSync(join(root, directory, "large.bin"));
    for (let i = 0; i < 512; i++) write(`${directory}/references/${i}.txt`, "");
    expect(() => readProjectSkills(root)).toThrow("512 files");
});
