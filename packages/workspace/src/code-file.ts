import { existsSync } from "../../engine/src/compiler/host.js";
import { readManifest } from "../../engine/src/compiler/manifest.js";
import { validateSubformatFile } from "../../engine/src/compiler/subformats.js";
import { textfilePath, writeTextfile } from "../../engine/src/compiler/textfile.js";
import { codeFileName, codeFilePlan } from "../../engine/src/core/code-file.js";
import { isDocId } from "../../engine/src/core/content-metadata.js";
import { defaultFilePath } from "../../engine/src/core/files.js";
import type { PreviewSettings } from "../../engine/src/core/previewers.js";

export const codeFileResponse = (
    root: string,
    input: Record<string, unknown> | undefined,
    previews?: PreviewSettings,
) => {
    if (typeof input?.body !== "string" || typeof input.position !== "number")
        return { status: 400, body: { error: "Invalid code file request" } };
    try {
        const manifest = readManifest(root);
        if (manifest.errors.length) throw new Error(manifest.errors.join("\n"));
        const automatic = input.file === undefined && manifest.files?.defaultLayout !== false;
        if (automatic && (typeof input.documentId !== "string" || !isDocId(input.documentId)))
            throw new Error("Invalid document id");
        if (!automatic && typeof input.file !== "string") throw new Error("File path is required");
        const target = automatic
            ? defaultFilePath(codeFileName(input.body, input.position, input.documentId as string))
            : (input.file as string);
        let plan = codeFilePlan(input.body, input.position, target, previews);
        const create = () => {
            if (existsSync(textfilePath(root, plan.file))) return false;
            validateSubformatFile(root, plan.file, plan.content, previews?.domains);
            return writeTextfile(root, plan.file, plan.content, null);
        };
        if (automatic) {
            for (let index = 2; !create(); index++) {
                const dot = target.lastIndexOf(".");
                plan = codeFilePlan(
                    input.body,
                    input.position,
                    `${target.slice(0, dot)}-${index}${target.slice(dot)}`,
                    previews,
                );
            }
            return { status: 200, body: { file: plan.file, change: plan.change } };
        }
        if (!create()) return { status: 409, body: { error: "File already exists" } };
        return { status: 200, body: { file: plan.file, change: plan.change } };
    } catch (error) {
        return {
            status: 400,
            body: { error: error instanceof Error ? error.message : String(error) },
        };
    }
};
