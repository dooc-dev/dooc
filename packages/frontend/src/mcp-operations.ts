import { checkSite } from "../../engine/src/compiler/check.js";
import type { CheckKind } from "../../engine/src/compiler/check-types.js";
import { type CompileOptions, createCompiler } from "../../engine/src/compiler/compile.js";
import { exportBundle } from "../../engine/src/compiler/export.js";
import { filesSnapshot, updateFiles, uploadFile } from "../../engine/src/compiler/files.js";
import { listProjectFonts, removeProjectFont } from "../../engine/src/compiler/fonts.js";
import {
    dirname,
    join,
    mkdirSync,
    randomUUID,
    readFileSync,
    realpathSync,
    relative,
    renameSync,
    rmSync,
    writeFileSync,
} from "../../engine/src/compiler/host.js";
import { manifestFile } from "../../engine/src/compiler/manifest.js";
import { createDocOps, isOpError } from "../../engine/src/compiler/ops.js";
import { validateSubformatFile } from "../../engine/src/compiler/subformats.js";
import { readTextfile, textfilePath, writeTextfile } from "../../engine/src/compiler/textfile.js";
import { localFile } from "../../engine/src/core/files.js";
import { docDisplayName } from "../../engine/src/core/taxonomy.js";
import type { Args } from "../../workspace/src/mcp.js";
import { resourceIndex } from "./resource-library.js";

export const createMcpOperations = (
    root: string,
    options: CompileOptions = {},
): Record<string, (args: Args) => unknown> => {
    const compiler = createCompiler(root, options);
    const ops = createDocOps(root);
    const fileArg = (value: unknown): string => {
        if (!localFile(value)) throw new Error("Expected a local bundle file path");
        if (
            !localFile(
                relative(realpathSync(root), textfilePath(root, value)).split("\\").join("/"),
            )
        )
            throw new Error("Expected a local bundle file path");
        return value;
    };
    const optStr = (v: unknown): string | undefined =>
        typeof v === "string" && v !== "" ? v : undefined;
    const docErrors = (id: string): string[] => {
        const compiled = compiler.compile();
        const file = compiled.docs.find((doc) => doc.id === id)?.file;
        return file ? (compiled.sources.get(file)?.errors ?? []) : [];
    };

    return {
        export: () => {
            const file = "dist/bundle.zip";
            const data = exportBundle(root);
            const path = textfilePath(root, file);
            mkdirSync(dirname(path), { recursive: true });
            const temp = join(dirname(path), `.export-${randomUUID()}.tmp`);
            try {
                writeFileSync(temp, data, { flag: "wx" });
                renameSync(temp, path);
            } finally {
                rmSync(temp, { force: true });
            }
            return { file, path, bytes: data.length };
        },
        list_files: () => filesSnapshot(root),
        read_file: (a) => ({ file: fileArg(a.file), content: readTextfile(root, fileArg(a.file)) }),
        write_file: (a) => {
            validateSubformatFile(
                root,
                fileArg(a.file),
                a.content as string,
                options.previews?.domains,
            );
            return writeTextfile(
                root,
                fileArg(a.file),
                a.content as string,
                a.base as string | null,
            )
                ? { file: a.file, ok: true }
                : { error: "File changed. Read it again before writing.", status: 409 };
        },
        upload_file: (a) => uploadFile(root, a),
        update_files: (a) => updateFiles(root, a),
        list_resources: () =>
            resourceIndex(
                root,
                filesSnapshot(root).files.map((file) => file.path),
                options.previews?.domains,
            ),
        list_fonts: () => ({ fonts: listProjectFonts(root) }),
        delete_font: (a) => {
            removeProjectFont(root, a.name as string);
            return { ok: true };
        },
        list_docs: () => {
            const { docs, figures } = compiler.compile();
            const depth = new Map<string, number>();
            return {
                docs: docs.map((d) => {
                    const dep = d.parent == null ? 0 : (depth.get(d.parent) ?? 0) + 1;
                    depth.set(d.id, dep);
                    return {
                        id: d.id,
                        file: d.subformat || d.library ? manifestFile(root) : d.file,
                        ...(d.library ? { library: d.library } : {}),
                        ...(d.subformat ? { subformat: d.subformat.ext } : {}),
                        title: docDisplayName(d, d.id),
                        parent: d.parent,
                        depth: dep,
                    };
                }),
                figures: figures.map((f) => ({
                    name: f.name,
                    file: f.file,
                    title: f.title,
                })),
            };
        },
        search_docs: (a) => {
            const q = String(a.query ?? "").toLowerCase();
            return compiler.compile().docs.flatMap((d) => {
                const title = docDisplayName(d, d.id);
                const i = d.body.toLowerCase().indexOf(q);
                if (i === -1 && !`${d.id}\n${title}`.toLowerCase().includes(q)) {
                    return [];
                }
                const snippet =
                    i === -1 ? "" : d.body.slice(Math.max(0, i - 60), i + q.length + 60);
                return [{ id: d.id, title, snippet }];
            });
        },
        read_doc: (a) => {
            const id = String(a.id);
            const compiled = compiler.compile();
            const doc = compiled.docs.find((d) => d.id === id);
            if (doc?.library) return { file: manifestFile(root), library: doc.library, errors: [] };
            if (doc?.subformat)
                return {
                    file: manifestFile(root),
                    subformat: doc.subformat,
                    errors: compiled.sources.get(doc.file)?.errors ?? [],
                };
            return doc
                ? {
                      file: doc.file,
                      raw: readTextfile(root, doc.file),
                      errors: compiled.sources.get(doc.file)?.errors ?? [],
                  }
                : { error: `doc "${id}" not found`, status: 404 };
        },
        read_figure: (a) =>
            compiler.compile().figures.find((f) => f.name === a.name) ?? {
                error: `figure "${String(a.name)}" not found`,
                status: 404,
            },
        check: (a) => {
            const report = checkSite(root, {
                only: a.only as CheckKind[] | undefined,
                allowSharedSvg: a.allow_shared_svg === true,
                warningsAsErrors: a.warnings_as_errors === true,
            });
            return {
                ...report,
                errors: report.diagnostics
                    .filter((d) => d.severity === "error")
                    .map((d) => `${d.file}: ${d.message}`),
            };
        },
        add_doc: (a) => ops.add(String(a.id), String(a.title), optStr(a.parent)),
        write_doc: (a) => {
            const r = ops.write(String(a.id), String(a.content));
            return isOpError(r) ? r : { ...r, errors: docErrors(r.id) };
        },
        move_doc: (a) =>
            ops.move(
                String(a.id),
                optStr(a.parent),
                typeof a.index === "number" ? a.index : undefined,
            ),
        rename_doc: (a) => ops.rename(String(a.id), String(a.new_id)),
        delete_doc: (a) => ops.remove(String(a.id), a.force === true),
        add_figure: (a) => {
            const path = optStr(a.path);
            const text = optStr(a.text);
            if ((path == null) === (text == null)) {
                return { error: "specify exactly one of path or text", status: 400 };
            }
            return ops.addFigure(
                String(a.file),
                path == null ? Buffer.from(text ?? "", "utf8") : readFileSync(path),
            );
        },
        delete_figure: (a) => ops.removeFigure(String(a.name), a.force === true),
    };
};
