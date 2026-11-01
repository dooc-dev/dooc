/** Replaces schema DSL comments with whitespace, preserving line numbers and edit offsets. */
export const scanSchemaComments = (source: string) => {
    const comments: { from: number; to: number; kind: "line" | "block"; closed: boolean }[] = [];
    const errors: { line: number; message: string }[] = [];
    let quoted = false;
    let line = 0;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (char === "\n") {
            line++;
            quoted = false;
            continue;
        }
        if (quoted) {
            if (char === "\\" && source[i + 1] !== "\n") i++;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') {
            quoted = true;
            continue;
        }
        if (char !== "/") continue;
        if (source[i + 1] === "/") {
            const end = source.indexOf("\n", i + 2);
            const to = end < 0 ? source.length : end;
            comments.push({ from: i, to, kind: "line", closed: end >= 0 });
            i = to - 1;
        } else if (source[i + 1] === "*") {
            const end = source.indexOf("*/", i + 2);
            const to = end < 0 ? source.length : end + 2;
            comments.push({ from: i, to, kind: "block", closed: end >= 0 });
            if (end < 0)
                errors.push({ line, message: "/* comment is not closed — */ is required" });
            line += source.slice(i, to).split("\n").length - 1;
            i = to - 1;
        }
    }
    const chunks: string[] = [];
    let from = 0;
    for (const comment of comments) {
        chunks.push(source.slice(from, comment.from));
        chunks.push(source.slice(comment.from, comment.to).replace(/[^\r\n]/g, " "));
        from = comment.to;
    }
    chunks.push(source.slice(from));
    return { source: chunks.join(""), comments, errors };
};
