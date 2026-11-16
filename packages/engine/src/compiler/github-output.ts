import { unzipSync } from "fflate";
import { type DefaultTreeAdapterTypes as Html, parseFragment, serialize } from "parse5";
import type { CheckDiagnostic } from "./check-types.js";
import { exportEntries } from "./export.js";
import {
    createHash,
    dirname,
    posix,
    readFileSync,
    realpathSync,
    relative,
    resolve,
} from "./host.js";
import { assertNotIgnored } from "./ignored-files.js";
import { textfilePath } from "./textfile.js";
import type { ZipEntry } from "./zip.js";

const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const encoded = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
const prefix = "bundle.github";

/** Combine already-rendered HTML pages; all page and section links become local anchors. */
export const githubHtml = (entries: readonly ZipEntry[]): { data: string; files: ZipEntry[] } => {
    const pages = new Map(
        entries
            .filter(({ name }) => name.endsWith(".md") && !name.startsWith("resources/"))
            .map((entry) => [entry.name, entry]),
    );
    const assets = new Set(entries.filter(({ name }) => !pages.has(name)).map(({ name }) => name));
    const pageId = (file: string) => `dooc-${hash(file).slice(0, 16)}`;
    const sections = [...pages.values()].map(({ name, data }) => {
        const tree = parseFragment(data.toString("utf8"));
        const walk = (node: Html.ParentNode): void => {
            for (const child of node.childNodes) {
                if (!("tagName" in child)) continue;
                for (const attr of child.attrs) {
                    if (attr.name === "id" || (attr.name === "name" && child.tagName === "a"))
                        attr.value = `${pageId(name)}--${attr.value}`;
                    if (
                        !["href", "src", "srcset"].includes(attr.name) ||
                        /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(attr.value)
                    )
                        continue;
                    const [path = "", fragment] = attr.value.split("#");
                    const target = path
                        ? posix.normalize(posix.join(posix.dirname(name), decodeURIComponent(path)))
                        : name;
                    attr.value = pages.has(target)
                        ? `#${pageId(target)}${fragment ? `--${fragment}` : ""}`
                        : encoded(assets.has(target) ? `${prefix}/${target}` : target) +
                          (fragment ? `#${fragment}` : "");
                }
                walk(child);
            }
        };
        walk(tree);
        return `<a name="${pageId(name)}"></a>\n${serialize(tree)}`;
    });
    return {
        data: `${sections.join("\n\n<hr>\n\n")}\n`,
        files: entries
            .filter(({ name }) => !pages.has(name))
            .map(({ name, data }) => ({ name: `${prefix}/${name}`, data })),
    };
};

interface GithubManifest {
    schemaVersion: 1;
    format: "html" | "zip";
    resources: "copy" | "reference";
    referenceBase: string;
    sources: { file: string; sha256: string }[];
    files: { file: string; sha256: string }[];
}

export const githubManifest = (
    sources: readonly ZipEntry[],
    files: readonly ZipEntry[],
    options: Pick<GithubManifest, "format" | "resources" | "referenceBase">,
): ZipEntry => {
    const snapshot = (entries: readonly ZipEntry[]) =>
        entries.map(({ name, data }) => ({ file: name, sha256: hash(data) }));
    const manifest: GithubManifest = {
        schemaVersion: 1,
        ...options,
        sources: snapshot(sources),
        files: snapshot(files),
    };
    return {
        name: `${options.format === "html" ? `${prefix}/` : ""}dooc-github.json`,
        data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    };
};

/** Check the captured inputs and every emitted file without executing plugins or downloading URLs. */
export const checkGithubOutput = (root: string, artifact: string): CheckDiagnostic[] => {
    const diagnostics: CheckDiagnostic[] = [];
    const reportFile = relative(root, resolve(root, artifact)).replaceAll("\\", "/");
    const add = (
        code: CheckDiagnostic["code"],
        file: string,
        message: string,
        sourceFile?: string,
    ) =>
        diagnostics.push({
            check: "github",
            code,
            severity: "error",
            file,
            message,
            ...(sourceFile ? { sourceFile } : {}),
        });
    try {
        const path = resolve(root, artifact);
        const format = path.endsWith(".zip") ? "zip" : path.endsWith(".html") ? "html" : undefined;
        if (!format) throw new Error("GitHub output must be a .zip or .html artifact");
        let archive: Record<string, Uint8Array> | undefined;
        if (format === "zip") {
            let total = 0;
            archive = unzipSync(readFileSync(path), {
                filter: (file) => {
                    total += file.originalSize;
                    if (total > 256 * 1024 * 1024)
                        throw new Error("GitHub check exceeds 256 MiB of unpacked data");
                    return true;
                },
            });
        }
        const safeFile = (file: string): boolean =>
            !!file &&
            !/[\\\0\r\n:]/.test(file) &&
            file.split("/").every((part) => part !== ".." && part !== "." && part !== "");
        const read = (file: string): Buffer => {
            if (!safeFile(file)) throw new Error(`Invalid artifact path: ${file}`);
            if (archive) {
                if (!Object.hasOwn(archive, file))
                    throw new Error(`Artifact file is missing: ${file}`);
                return Buffer.from(archive[file] as Uint8Array);
            }
            return readFileSync(textfilePath(dirname(path), file));
        };
        const metadata = `${format === "html" ? `${prefix}/` : ""}dooc-github.json`;
        const manifest = JSON.parse(read(metadata).toString("utf8")) as GithubManifest;
        if (
            !manifest ||
            manifest.schemaVersion !== 1 ||
            manifest.format !== format ||
            !["copy", "reference"].includes(manifest.resources) ||
            typeof manifest.referenceBase !== "string" ||
            ![manifest.sources, manifest.files].every(
                (items) =>
                    Array.isArray(items) &&
                    items.length <= 65535 &&
                    items.every(
                        (item) =>
                            item &&
                            typeof item.file === "string" &&
                            safeFile(item.file) &&
                            typeof item.sha256 === "string" &&
                            /^[a-f0-9]{64}$/.test(item.sha256),
                    ),
            )
        )
            throw new Error("Invalid dooc GitHub build manifest");
        if (manifest.resources === "reference") {
            try {
                if (
                    realpathSync(resolve(dirname(path), manifest.referenceBase)) !==
                    realpathSync(root)
                )
                    throw new Error(
                        "The reference base does not point to this project's manifest directory",
                    );
            } catch (error) {
                add(
                    "GITHUB_REFERENCE_INVALID",
                    reportFile,
                    `${error instanceof Error ? error.message : String(error)}. Rebuild for this output/extraction location.`,
                );
            }
        }
        for (const { file, sha256 } of manifest.files) {
            try {
                if (hash(read(file)) !== sha256)
                    add(
                        "GITHUB_OUTPUT_CHANGED",
                        reportFile,
                        `Generated file changed: ${file}. Rebuild the artifact.`,
                    );
            } catch (error) {
                add(
                    "GITHUB_FILE_MISSING",
                    reportFile,
                    `Cannot read generated file ${file}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        for (const { file, sha256 } of manifest.sources) {
            try {
                assertNotIgnored(root, file);
                if (hash(readFileSync(textfilePath(root, file))) !== sha256)
                    add(
                        "GITHUB_SOURCE_CHANGED",
                        file,
                        "Source changed since the GitHub build. Rebuild to refresh excerpts, diagrams and links.",
                        file,
                    );
            } catch (error) {
                add(
                    "GITHUB_FILE_MISSING",
                    file,
                    `Cannot read GitHub build source: ${error instanceof Error ? error.message : String(error)}`,
                    file,
                );
            }
        }
        if (!diagnostics.some((entry) => entry.code === "GITHUB_FILE_MISSING")) {
            const captured = new Set(manifest.sources.map(({ file }) => file));
            for (const entry of exportEntries(root))
                if (!captured.has(entry.name))
                    add(
                        "GITHUB_SOURCE_CHANGED",
                        entry.name,
                        "A new source dependency is absent from the GitHub build. Rebuild the artifact.",
                        entry.name,
                    );
        }
    } catch (error) {
        add(
            "GITHUB_OUTPUT_INVALID",
            reportFile,
            error instanceof Error ? error.message : String(error),
        );
    }
    return diagnostics;
};
