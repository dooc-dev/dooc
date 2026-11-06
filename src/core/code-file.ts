import { codeBlockAt } from "./markdown.js";
import { type PreviewSettings, resolvePreviewer } from "./previewers.js";
import { CODE_TEMPLATES } from "./taxonomy.js";
import { termFileUrl } from "./term-reference.js";

export const codeFileName = (body: string, position: number, documentId: string): string => {
    const block = codeBlockAt(body, position);
    const language = block.language.toLowerCase();
    const aliases: Record<string, string> = {
        javascript: "js",
        typescript: "ts",
        python: "py",
        rust: "rs",
        ruby: "rb",
        csharp: "cs",
        bash: "sh",
        powershell: "ps1",
        markdown: "md",
        "c++": "cpp",
    };
    const extension = Object.hasOwn(aliases, language)
        ? aliases[language]
        : /^[a-z0-9_-]+$/.test(language)
          ? language
          : "txt";
    const directory =
        language === "termth"
            ? "terms"
            : language === "grapth" || language === "schemath"
              ? "figures"
              : "examples";
    return `${directory}/${documentId}-${body.slice(0, block.start).split("\n").length}.${extension}`;
};

/** Preserve the body bytes and replace only a standalone, closed fence. */
export const codeFilePlan = (
    body: string,
    position: number,
    target: string,
    settings?: PreviewSettings,
) => {
    const block = codeBlockAt(body, position);
    if (!block.topLevel) throw new Error("Only standalone code blocks can become files");
    const semantic = Object.hasOwn(CODE_TEMPLATES, block.language);
    if (block.meta && (!semantic || block.language === "termth"))
        throw new Error("Remove code fence metadata before creating a file");
    const file = target.trim().replace(/^(\.\/)+/, "");
    if (
        !file ||
        /^[/\\]|^[a-z][a-z\d+.-]*:/i.test(file) ||
        /[\\\0\r\n]/.test(file) ||
        file.split("/").includes("..")
    )
        throw new Error("Use a relative file path inside the docs root");
    if (semantic && !file.endsWith(`.${block.language}`))
        throw new Error(`Use the .${block.language} extension`);
    const url = termFileUrl(file);
    const previewer = resolvePreviewer(url, settings);
    if (semantic && previewer && previewer !== "code")
        throw new Error("Register this extension with the Code previewer");
    const sourceOnly =
        !semantic &&
        ((previewer !== undefined && previewer !== "code") ||
            /\.(callouth|schemath|grapth|termth)$/i.test(file));
    const lastLine = block.code.split("\n").length;
    const range = sourceOnly ? `#L1${lastLine > 1 ? `-L${lastLine}` : ""}` : "";
    const caption = semantic ? block.meta.replace(/[\\[\]]/g, "\\$&") : "";
    const from = body.lastIndexOf("\n", block.start - 1) + 1;
    const before = body.slice(0, from);
    const after = body.slice(block.end);
    const prefix = before.trim() && !/\r?\n[ \t]*\r?\n$/.test(before) ? block.eol : "";
    const suffix = after.trim() && !/^\r?\n[ \t]*\r?\n/.test(after) ? block.eol : "";
    return {
        file,
        content:
            block.code.replaceAll("\n", block.eol) + (block.from === block.to ? "" : block.eol),
        change: { from, to: block.end, insert: `${prefix}![${caption}](${url}${range})${suffix}` },
    };
};
