import { CHECK_KINDS } from "../../engine/src/compiler/check-types.js";
import type { Args, Tool } from "./mcp.js";

const str = { type: "string" } as const;
const num = { type: "integer", minimum: 0 } as const;
const bool = { type: "boolean" } as const;
const strings = { type: "array", items: str } as const;

const definitions: Record<string, Omit<Tool, "run">> = {
    export: {
        description:
            "Collect dooc.yaml and its source dependencies into dist/bundle.zip, without executing plugins or fetching remote data.",
        props: {},
        required: [],
    },
    build: {
        description:
            "Build dist/bundle.html or dist/bundle.zip. url_preview=embed snapshots embedded URL content; network preserves URL references. Defaults to embed. Returns the output path, byte count and document count.",
        props: {
            format: { ...str, enum: ["html", "zip"] },
            url_preview: { ...str, enum: ["embed", "network"] },
            mode: { ...str, enum: ["static", "live"] },
            auth: { ...str, enum: ["external"] },
            easy_download: {
                type: "boolean",
                description: "Enable individual resource downloads in HTML (default: false).",
            },
            source_url: {
                ...str,
                description:
                    "Public source directory URL for card copy links in HTML, relative to dooc.yaml.",
            },
        },
        required: ["format"],
    },
    list_files: {
        description:
            "List bundle files, sizes, layout and document mappings. Save revision for update_files.",
        props: {},
    },
    read_file: {
        description:
            "Read a local UTF-8 bundle file, including dooc.yaml, translations and theme variants. Save content as the base for write_file.",
        props: { file: str },
        required: ["file"],
    },
    write_file: {
        description:
            "Create or update a local UTF-8 bundle file. base must equal the content from read_file, or null to create a new file. Conflicting edits are never overwritten.",
        props: { file: str, content: str, base: { type: ["string", "null"] } },
        required: ["file", "content", "base"],
    },
    upload_file: {
        description:
            "Import a binary or text file from base64 data using the bundle file layout. Existing files are preserved with a unique name. Maximum 64 MiB.",
        props: { name: str, data: { ...str, description: "Canonical base64 file bytes" } },
        required: ["name", "data"],
    },
    update_files: {
        description:
            "Rename a file (file, name), move files/folders (paths, directory), change automatic layout (enabled), or restructure by extension. Updates document references and variants. Requires revision from list_files.",
        props: {
            action: { ...str, enum: ["rename", "move", "layout", "restructure"] },
            revision: str,
            file: str,
            name: str,
            paths: strings,
            directory: str,
            enabled: bool,
        },
        required: ["action", "revision"],
    },
    list_resources: {
        description:
            "List Library: codeblocks (including term definitions and local text-file embeds, with normalized format and reference locations), URLs from Markdown links, and URL previews from Markdown images, with source files and line numbers.",
        props: {},
    },
    list_fonts: {
        description:
            "List registered project fonts. Editor and viewer font selection remains a browser display preference.",
        props: {},
    },
    add_font: {
        description:
            "Copy a local TTF, OTF, WOFF or WOFF2 font into .dooc/fonts. Existing names are never overwritten.",
        props: { path: { ...str, description: "Local source font path" } },
        required: ["path"],
    },
    delete_font: {
        description: "Remove a registered project font by the name returned by list_fonts.",
        props: { name: str },
        required: ["name"],
    },
    git: {
        description:
            "Git workflow in the repository containing this bundle. Read first; every other action except branches requires that state's version. diff/stage/unstage use path; commit uses message; branch creates and switches to branch; switch accepts stash=true to save dirty work in the single stash slot. Origin operations require an externally injected provider. createPr needs title/body/base/draft; updatePr needs number/title/body/revision; mergePr needs number/method/revision. PR revision must be JSON.stringify of the PR returned by read. Read again after each action.",
        props: {
            action: {
                ...str,
                enum: [
                    "read",
                    "branches",
                    "diff",
                    "stage",
                    "unstage",
                    "commit",
                    "branch",
                    "switch",
                    "stash",
                    "restoreStash",
                    "fetch",
                    "pull",
                    "push",
                    "createPr",
                    "updatePr",
                    "mergePr",
                ],
            },
            version: str,
            path: str,
            message: str,
            branch: str,
            stash: bool,
            title: str,
            body: str,
            base: str,
            draft: bool,
            number: { ...num, minimum: 1 },
            revision: str,
            method: { ...str, enum: ["merge", "squash", "rebase"] },
        },
        required: ["action"],
    },
    history: {
        description:
            "Edit history as workspace snapshots. list (default) returns snapshots newest first from both stores: source=git (commits, co-authors from Co-authored-by trailers) and source=dooc (copies under .dooc/snapshots); user keeps only snapshots that person or agent authored or co-authored. snapshot records the current files with message, credited to user (e.g. the agent's name).",
        props: {
            action: { ...str, enum: ["list", "snapshot"] },
            source: { ...str, enum: ["git", "dooc"] },
            user: { ...str, description: "Author name, case-insensitive" },
            message: str,
        },
    },
    list_docs: {
        description:
            "The doc tree (in manifest display order) and figures. Each doc has id / file / title / parent / depth.",
        props: {},
    },
    search_docs: {
        description:
            "Find docs by case-insensitive substring match on id / title / body. Includes a snippet around each match.",
        props: { query: { ...str, description: "Search query" } },
        required: ["query"],
    },
    read_doc: {
        description:
            "A doc's raw md and its validation errors. Figure links use file paths; list_docs maps each file to its read_figure name.",
        props: { id: { ...str, description: "doc id" } },
        required: ["id"],
    },
    read_figure: {
        description:
            "A figure's markup (SVG / HTML / DXF geometry; images, video and PDF embedded as data URIs).",
        props: { name: { ...str, description: "Figure name (without extension)" } },
        required: ["name"],
    },
    check: {
        description:
            "Check rendering, translations and theme variants before building. Returns the CLI CheckReport plus the legacy errors list.",
        props: {
            only: { type: "array", items: { ...str, enum: CHECK_KINDS } },
            allow_shared_svg: bool,
            warnings_as_errors: bool,
        },
    },
    add_doc: {
        description:
            "Create a new doc using the file layout, appended as the last child of parent in the manifest.",
        props: {
            id: { ...str, description: "New id (lowercase alphanumerics and hyphens)" },
            title: { ...str, description: "Title" },
            parent: { ...str, description: "Parent doc id (omit = top level)" },
        },
        required: ["id", "title"],
    },
    write_doc: {
        description:
            "Overwrite the entire raw text of an existing doc. Titles live in dooc.yaml. Returns the validation errors after writing.",
        props: {
            id: { ...str, description: "doc id" },
            content: { ...str, description: "Full md text" },
        },
        required: ["id", "content"],
    },
    move_doc: {
        description: "Move a doc (with its children) to position index under parent.",
        props: {
            id: { ...str, description: "doc id" },
            parent: { ...str, description: "New parent (omit = top level)" },
            index: { ...num, description: "Position among siblings (omit = last)" },
        },
        required: ["id"],
    },
    rename_doc: {
        description: "Change a doc id (the file name / manifest / file links in all docs follow).",
        props: {
            id: { ...str, description: "Current id" },
            new_id: { ...str, description: "New id" },
        },
        required: ["id", "new_id"],
    },
    delete_doc: {
        description:
            "Delete a doc. Docs with children cannot be deleted. Requires force if other docs reference it via file links.",
        props: {
            id: { ...str, description: "doc id" },
            force: { ...bool, description: "Delete even if referenced" },
        },
        required: ["id"],
    },
    add_figure: {
        description:
            "Add a figure to figures/ (svg / drawio.svg / html / png / webp / jpg / gif / mp4 / webm / pdf / dxf). Give either path (a local file) or text (svg / html / dxf source). If the name is taken, -2 etc. is appended.",
        props: {
            file: {
                ...str,
                description:
                    "Figure file name (e.g. overview.svg; the extension determines the kind)",
            },
            path: { ...str, description: "Absolute path of the local file to copy from" },
            text: { ...str, description: "svg / html source" },
        },
        required: ["file"],
    },
    delete_figure: {
        description: "Delete a figure. Requires force if a doc references it.",
        props: {
            name: { ...str, description: "Figure name (without extension)" },
            force: { ...bool, description: "Delete even if referenced" },
        },
        required: ["name"],
    },
};
const readTools = new Set([
    "list_docs",
    "search_docs",
    "read_doc",
    "read_figure",
    "list_files",
    "read_file",
    "list_resources",
    "list_fonts",
    "check",
]);
const nodeTools = new Set(["build", "git", "history", "add_font"]);

export const createMcpTools = (
    execute: (name: string, args: Args) => unknown,
    readOnly = false,
    browser = false,
): Record<string, Tool> =>
    Object.fromEntries(
        Object.entries(definitions)
            .filter(
                ([name]) =>
                    (!readOnly || readTools.has(name)) && (!browser || !nodeTools.has(name)),
            )
            .map(([name, definition]) => {
                if (browser && name === "add_figure") {
                    const { path: _path, ...props } = definition.props;
                    definition = {
                        ...definition,
                        props,
                        required: ["file", "text"],
                        description:
                            "Add a figure from SVG, HTML or DXF source text. Existing files are preserved with a unique name.",
                    };
                }
                return [name, { ...definition, run: (args: Args) => execute(name, args) }];
            }),
    );
