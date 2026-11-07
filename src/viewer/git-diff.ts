import { execFileSync } from "node:child_process";
import { parseDoc } from "../compiler/dialect.js";
import { textfilePath } from "../compiler/textfile.js";

/** Compare against HEAD so saving or staging does not clear the editor's changes. */
export const gitBaseText = (root: string, file: string): string | null => {
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 2_000,
            maxBuffer: 5_000_000,
        });
    try {
        textfilePath(root, file);
        let head: string;
        try {
            head = git("rev-parse", "--verify", "--quiet", "HEAD").trim();
        } catch (error) {
            return (error as { status?: number }).status === 1 ? "" : null;
        }
        if (!git("ls-tree", "-z", head, "--", `:(literal)${file}`)) return "";
        return git("show", `${head}:./${file}`);
    } catch {
        // Missing Git or unreadable history must leave the editor usable.
        return null;
    }
};

export const gitBaseBody = (root: string, file: string): string | null => {
    const raw = gitBaseText(root, file);
    return raw === null ? null : parseDoc(raw).body;
};
