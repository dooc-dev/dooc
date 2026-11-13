import { filesSnapshot } from "../../engine/src/compiler/files.js";
import { readFileSync } from "../../engine/src/compiler/host.js";
import { textfilePath } from "../../engine/src/compiler/textfile.js";

export const readDownloadFile = (root: string, file: unknown): Buffer => {
    if (typeof file !== "string" || !filesSnapshot(root).files.some((item) => item.path === file))
        throw new Error("File is not available for download");
    return readFileSync(textfilePath(root, file));
};
