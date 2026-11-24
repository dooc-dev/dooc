import { parse } from "yaml";
import { localFile } from "../core/files.js";
import { join, lstatSync, posix, readdirSync, readFileSync, statSync } from "./host.js";
import { assertNotIgnored, ignoredFiles, withIgnoredFilesCache } from "./ignored-files.js";
import { manifestFile, parseManifestText } from "./manifest.js";
import { readTextfile, textfilePath } from "./textfile.js";

export interface ProjectSkill {
    file: string;
    frontmatter: Record<string, unknown> & { name: string; description: string };
    files: Map<string, Buffer>;
}

/** Read only skills explicitly declared by the selected project's manifest. */
export const readProjectSkills = (
    root: string,
    manifestPath = manifestFile(root),
): ProjectSkill[] =>
    withIgnoredFilesCache(() => {
        const manifest = parseManifestText(readTextfile(root, manifestPath), manifestPath);
        if (manifest.errors.length) throw new Error(manifest.errors.join("\n"));
        const names = new Set<string>();
        return (manifest.skills ?? []).map((configured) => {
            const file = posix.join(posix.dirname(manifestPath), configured);
            const directory = posix.dirname(file);
            const path = textfilePath(root, directory);
            let ancestor = root;
            for (const part of directory.split("/")) {
                ancestor = join(ancestor, part);
                if (lstatSync(ancestor).isSymbolicLink())
                    throw new Error(`Skill paths must not contain symlinks: ${directory}`);
            }
            assertNotIgnored(root, file);
            const files = new Map<string, Buffer>();
            let bytes = 0;
            const walk = (relative: string, depth = 0): void => {
                if (depth > 32)
                    throw new Error(`Skill directory nesting exceeds 32 levels: ${file}`);
                const entries = readdirSync(join(path, relative), { withFileTypes: true });
                entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
                const ignored = ignoredFiles(
                    root,
                    entries.map(
                        (entry) =>
                            posix.join(directory, relative, entry.name) +
                            (entry.isDirectory() ? "/" : ""),
                    ),
                );
                for (const entry of entries) {
                    const name = posix.join(relative, entry.name);
                    const source = posix.join(directory, name);
                    if (
                        entry.name.startsWith(".") ||
                        ignored.has(source + (entry.isDirectory() ? "/" : ""))
                    )
                        continue;
                    if (!localFile(name.replace(/[?#]/g, "_")) || entry.isSymbolicLink())
                        throw new Error(`Invalid skill file or symlink: ${source}`);
                    if (entry.isDirectory()) {
                        walk(name, depth + 1);
                        continue;
                    }
                    if (!entry.isFile())
                        throw new Error(`Expected a regular skill file: ${source}`);
                    const sourcePath = textfilePath(path, name);
                    if (files.size >= 512 || bytes + statSync(sourcePath).size > 16 * 1024 * 1024)
                        throw new Error(`Skill exceeds 512 files or 16 MiB: ${file}`);
                    const data = readFileSync(sourcePath);
                    bytes += data.length;
                    if (bytes > 16 * 1024 * 1024) throw new Error(`Skill exceeds 16 MiB: ${file}`);
                    files.set(name, data);
                }
            };
            walk("");
            const data = files.get("SKILL.md");
            if (!data) throw new Error(`Missing or ignored skill file: ${file}`);
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
            const yaml = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
            if (yaml === undefined || text.includes("\0"))
                throw new Error(`Skill must start with YAML frontmatter: ${file}`);
            const frontmatter = parse(yaml) as ProjectSkill["frontmatter"];
            if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter))
                throw new Error(`Invalid skill frontmatter: ${file}`);
            const { name, description, license, compatibility, metadata } = frontmatter;
            if (
                typeof name !== "string" ||
                name.length > 64 ||
                !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
                name !== posix.basename(directory)
            )
                throw new Error(
                    `Skill name must match its directory and use 1-64 lowercase letters, digits or single hyphens: ${file}`,
                );
            if (typeof description !== "string" || !description.trim() || description.length > 1024)
                throw new Error(`Skill description must contain 1-1024 characters: ${file}`);
            if (
                (license !== undefined && typeof license !== "string") ||
                (compatibility !== undefined &&
                    (typeof compatibility !== "string" ||
                        !compatibility.trim() ||
                        compatibility.length > 500)) ||
                (frontmatter["allowed-tools"] !== undefined &&
                    typeof frontmatter["allowed-tools"] !== "string") ||
                (metadata !== undefined &&
                    (!metadata ||
                        typeof metadata !== "object" ||
                        Array.isArray(metadata) ||
                        Object.values(metadata).some((value) => typeof value !== "string")))
            )
                throw new Error(`Invalid optional skill frontmatter: ${file}`);
            JSON.stringify(frontmatter);
            if (names.has(name)) throw new Error(`Duplicate skill name: ${name}`);
            names.add(name);
            return { file, frontmatter, files };
        });
    });
