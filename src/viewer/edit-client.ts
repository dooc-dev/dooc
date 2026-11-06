// Browser client for dooc edit (bundled by serve.ts with esbuild, served at
// /assets/edit.js). Sidebar: document properties. Right panel: language + CodeMirror. Insertion is done via in-editor
// autocomplete (the `/` palette and contextual completion). Toggles (autosave / correspondence
// view / fm visibility / theme) live in the header's gear hover menu. Width is adjustable by drag
// or keyboard. Input is debounced to /api/render and reflected live in the left pane (main
// content); saving (/api/save) is manual (save button / Mod-s) or via the autosave toggle.
// With "correspondence view" ON, hovering / clicking highlights main-content elements and the
// matching CM lines in both directions.
// Switching docs is client-side navigation (end of file): the sidebar keeps the initial server
// render and only the main content / panel / CM contents are swapped (so the nav scroll position
// survives a switch).
// This file is outside the publish surface (dev tool only).
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${...}` is a CodeMirror snippet field
import {
    autocompletion,
    type Completion,
    CompletionContext,
    type CompletionResult,
    snippetCompletion,
    startCompletion,
} from "@codemirror/autocomplete";
import { indentWithTab, isolateHistory } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tags } from "@lezer/highlight";
import type { TocEntry } from "../core/blocks.js";
import type { TermEntry } from "../core/content-types.js";
import { isDocumentFileName } from "../core/files.js";
import type { PreviewSettings } from "../core/previewers.js";
import { CODE_LANGS, CODE_TEMPLATES } from "../core/taxonomy.js";
import { isTermFile, termFileUrl } from "../core/term-reference.js";
import { codeFileButtons } from "./edit-code-file.js";
import { editorCodeHighlight } from "./edit-code-highlight.js";
import { chooseConflict } from "./edit-conflict.js";
import { confirmDialog, showNotice } from "./edit-dialog.js";
import {
    filePreviewState,
    previewSettingsState,
    setFilePreviews,
    setPreviewSettings,
} from "./edit-file-preview.js";
import { inlineFoldButtons } from "./edit-fold.js";
import { schemaCompletion } from "./edit-schema-completion.js";
import { editorSetup } from "./edit-setup.js";
import { createTextfileEditors } from "./edit-textfile.js";
import { CODE_BLOCK_NODE_NAMES, isEditingCodeBlock } from "./edit-validation.js";
import { type FilePreview, type FilePreviewResults, fileReferences } from "./file-references.js";
import { mountFileUpload } from "./file-upload.js";
import type { HmrBridge } from "./hmr.js";
import { applyUiLanguage, mountUiLanguage, t } from "./i18n.js";
import { focusNavTree } from "./nav-focus.js";
import { mountPreviewSettings } from "./preview-settings-ui.js";

interface Boot {
    previews?: PreviewSettings;
    filePreviews: FilePreviewResults;
    siteTitle?: string;
    siteIcon?: string;
    contentLanguage?: string;
    sourceLanguage?: string;
    docLanguage?: string;
    translatedLanguages?: string[];
    file: string;
    sourceFile?: string;
    /** Stable resolution key for URLs / file links. */
    docId: string;
    title: string;
    path: string;
    body: string;
    figures: string[];
    codeLanguages?: string[];
    docs: { ref: string; title: string }[];
    terms: TermEntry[];
    /**
     * Start line of each block relative to the body (for the correspondence view; same index as
     * the main-content elements).
     */
    blockLines: number[];
    /** Full source on disk (including front matter). Base for detecting external changes. */
    baseRaw: string;
    /** Data URI of the sidebar icon (null if none). */
    icon: string | null;
    /** Site default language (lint uses it when the `lang` field is empty). */
    defaultLang: string;
    /** Language of the CM content's browser spellcheck (the doc language's adapter). */
    spellcheckLang: string;
}

/** Response of /api/rename. */
interface RenameResponse {
    path: string;
    ok?: boolean;
    error?: string;
    sourceFile: string;
}

/** Response of /api/delete. referencedBy is set only on 409 (without force). */
interface DeleteResponse {
    path: string;
    ok?: boolean;
    error?: string;
    referencedBy?: string[];
    /** Parent of the deleted doc (= navigation target; absent for a top-level doc). */
    parent?: string;
    danglingRefs?: number;
}

interface DraftFrontmatter {
    title?: string;
    lang?: string;
}

/**
 * Minimal data needed to redraw the main content and correspondence view (shared by the
 * render/save/doc responses).
 */
interface RenderSnapshot {
    sourceFile?: string;
    previews?: PreviewSettings;
    filePreviews: FilePreviewResults;
    html: string;
    errors: string[];
    blockLines: number[];
    /** Heading TOC (reflected live right under the current doc-link in the nav). */
    toc: TocEntry[];
}

interface DraftResponse extends RenderSnapshot {
    saved: boolean;
    /**
     * Right before saving, disk differed from the client's base (baseRaw) (= it was rewritten
     * externally first).
     */
    conflict: boolean;
    /** New base (after a normal save = what was written; on conflict = current disk content). */
    raw: string;
    /** Only on conflict: current frontmatter/body on disk (to reflect into the editor). */
    frontmatter?: DraftFrontmatter;
    body?: string;
}

/** Response of GET /api/doc?file=<id>.md (current content on disk. Used to reflect external
 * updates to our own file via HMR (when not dirty)). */
interface DocResponse extends RenderSnapshot {
    raw: string;
    frontmatter: DraftFrontmatter;
    body: string;
}

/** Response of GET /api/nav?current=<docId> (inner html of `#nav-groups`). */
interface NavResponse {
    translatedLanguages?: string[];
    html: string;
    siteTitle?: string;
    siteIcon?: string;
}

/**
 * Response of GET /api/page?route=<path> (only the parts swapped on doc switch; 404 for non-doc
 * routes).
 */
interface PageResponse extends Omit<RenderSnapshot, "blockLines"> {
    /** Browser tab title (final form assembled by the server). */
    title: string;
    file: string;
    boot: Boot;
}

/** Shape apply() / reflectExternal() actually use (both DraftResponse and DocResponse fit). */
type ExternalSnapshot = RenderSnapshot & {
    raw: string;
    frontmatter?: DraftFrontmatter;
    body?: string;
};

/**
 * One /api/lint finding. range is 0-indexed [start, end) relative to the body string (= the
 * same coordinate system as the CM doc).
 */
interface LintFinding {
    ruleId: string;
    message: string;
    range: readonly [number, number];
}

/**
 * One main-content element <-> source line mapping (el = preview element, [ln, end] = matching
 * body line range).
 */
interface Corr {
    ln: number;
    end: number;
    el: HTMLElement;
}

// Relies on the editor page's static DOM (serve.ts editorAside), so elements are assumed to exist.
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// Boot data of the open doc. A doc switch (client-side navigation, end of this file) does not
// rebuild the sidebar / panel DOM; it only replaces this, the CM contents and the main html.
let boot = JSON.parse($("boot").textContent ?? "{}") as Boot;
let siteTitle = boot.siteTitle;
let siteIcon = boot.siteIcon;
const localeUrl = (path: string): string => {
    const url = new URL(path, location.origin);
    url.searchParams.set("lang", boot.contentLanguage ?? boot.defaultLang);
    return url.pathname + url.search + url.hash;
};
const localeFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
    fetch(url, {
        ...init,
        headers: { ...init.headers, "x-docs-language": boot.contentLanguage ?? boot.defaultLang },
    });
const workspace = document.querySelector("main") as HTMLElement;
let mainEl = workspace.querySelector(".preview-content") as HTMLElement;
// Remember the server markup before interactive diagrams / syntax highlighting mutate the DOM.
// Unchanged blocks keep their DOM, avoiding a React Flow remount on every keystroke.
const blockMarkup = new WeakMap<Element, string>();
for (const block of mainEl.querySelector("article")?.children ?? []) {
    blockMarkup.set(block, block.outerHTML);
}
const updatePreview = (fragment: DocumentFragment): void => {
    const next = fragment.querySelector("article");
    const current = mainEl.querySelector("article");
    if (!current || !next) {
        for (const block of next?.children ?? []) blockMarkup.set(block, block.outerHTML);
        mainEl.replaceChildren(fragment);
        return;
    }
    const available = new Map<string, Element[]>();
    for (const block of current.children) {
        const markup = blockMarkup.get(block);
        if (markup === undefined) continue;
        const matches = available.get(markup) ?? [];
        matches.push(block);
        available.set(markup, matches);
    }
    let cursor = current.firstElementChild;
    for (const block of [...next.children]) {
        const markup = block.outerHTML;
        const reused = available.get(markup)?.shift() ?? block;
        blockMarkup.set(reused, markup);
        if (reused !== cursor) current.insertBefore(reused, cursor);
        cursor = reused.nextElementSibling;
    }
    while (cursor) {
        const nextSibling = cursor.nextElementSibling;
        cursor.remove();
        cursor = nextSibling;
    }
};
mountUiLanguage();
mountPreviewSettings();

const updateLanguageControls = (): void => {
    const lang = $<HTMLSelectElement>("fm-lang");
    const language = boot.contentLanguage ?? boot.defaultLang;
    const existing = new Set(boot.translatedLanguages ?? [boot.sourceLanguage ?? boot.defaultLang]);
    const options = [...lang.options].sort(
        (a, b) =>
            Number(existing.has(b.value)) - Number(existing.has(a.value)) ||
            (a.dataset.name ?? "").localeCompare(b.dataset.name ?? ""),
    );
    const menu = document.createDocumentFragment();
    for (const option of options) {
        option.dataset.added = String(existing.has(option.value));
        if (!existing.has(option.value)) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "language-option";
        button.dataset.language = option.value;
        button.textContent = option.dataset.name ?? option.text;
        button.setAttribute("role", "menuitemradio");
        button.setAttribute("aria-checked", String(option.value === language));
        menu.append(button);
    }
    lang.replaceChildren(...options);
    lang.value = language;
    $("preview-language-menu").replaceChildren(menu);
    applyUiLanguage();
};
updateLanguageControls();

const statusEl = $("status");
let renderRevision = 0;
const setPreviewState = (
    state: FilePreview["state"],
    message = "",
    files?: readonly string[],
): void => {
    const currentBoot = boot;
    const doc = view.state.doc;
    // Changes can originate inside CodeMirror's update listener.
    queueMicrotask(() => {
        if (boot !== currentBoot || view.state.doc !== doc) return;
        const previews = new Map(Object.entries(view.state.field(filePreviewState).previews));
        for (const { file } of fileReferences(
            doc.toString(),
            view.state.field(previewSettingsState, false),
        )) {
            if (!files || files.includes(file)) previews.set(file, { state, message });
        }
        view.dispatch({ effects: setFilePreviews.of(Object.fromEntries(previews)) });
    });
};
const applyFilePreviews = (results: FilePreviewResults, blocked: readonly string[] = []): void => {
    const previous = view.state.field(filePreviewState).previews;
    view.dispatch({
        effects: setFilePreviews.of(
            Object.fromEntries(
                Object.entries(results).map(([file, errors]) => [
                    file,
                    {
                        state: errors.length
                            ? "error"
                            : blocked.length && previous[file]?.state !== "valid"
                              ? "pending"
                              : "valid",
                        message: errors.length
                            ? errors.join("\n")
                            : previous[file]?.state !== "valid"
                              ? blocked.join("\n")
                              : "",
                    },
                ]),
            ),
        ),
    });
    boot.filePreviews = results;
};
document.addEventListener("docs:ui-language", () => {
    view.dispatch({ effects: setFilePreviews.of(view.state.field(filePreviewState).previews) });
});
const autosaveEl = $<HTMLInputElement>("opt-autosave");

const autovalidateEl = $<HTMLInputElement>("opt-autovalidate");
autovalidateEl.checked = localStorage.getItem("docs-edit:autovalidate") === "1";

const AUTOSAVE_KEY = "docs-edit:autosave";
const CORR_KEY = "docs-edit:corr";

let dirty = false;
// Notification hook for HMR (the hmr.ts client script). Passes dirty so unsaved edits are not
// lost to a reload on external change. This bundle runs before the HMR script at the end of the
// page, so the reference is looked up each time.
const hmr = (): HmrBridge | undefined => (window as unknown as { __docsHmr?: HmrBridge }).__docsHmr;
const setSaveState = (state: "pending" | "saving" | "saved" | "error"): void => {
    const button = $("save");
    button.dataset.state = state;
    const label = {
        pending: "Unsaved changes",
        saving: "Saving",
        saved: "Saved",
        error: "Save failed",
    }[state];
    button.dataset.i18nTitle = label;
    button.dataset.i18nAriaLabel = label;
    button.title = t(label);
    button.setAttribute("aria-label", t(label));
};
const setDirty = (v: boolean): void => {
    dirty = v;
    setSaveState(v ? (autosaveEl.checked ? "saving" : "pending") : "saved");
    hmr()?.setDirty(
        v ||
            textfiles.hasUnsavedChanges() ||
            panes.some((pane) => pane !== activePane && pane.draft?.dirty),
    );
};
let corrOn = false;
let ranges: Corr[] = [];
let lastBlockLines: number[] = boot.blockLines ?? [];
// Base compared against disk right before saving. Updated to "current disk content" both on a
// successful save (our write) and when reflecting a conflict (external write), so autosave
// doesn't miss the next external change.
let baseRaw = boot.baseRaw;
// True only while reflectExternal() rewrites the CM doc, suppressing the updateListener's
// docChanged handler (= onChange -> dirty/autosave/render). Otherwise a wasteful loop of
// "autosave the content just reflected" would run right after reflecting.
let suppressChange = false;
// While a conflict awaits a choice, autosave retries are paused. Manual saves
// (button / Mod-s) are always attempted (an explicit request to confirm again).
let conflictPending = false;

const setStatus = (text: string, err = false): void => {
    statusEl.dataset.i18n = text;
    statusEl.textContent = t(text);
    statusEl.classList.toggle("err", err);
};

const readFm = (): DraftFrontmatter => ({
    title: boot.title,
    lang: boot.docLanguage ?? "",
});

// Reflect a conflict (disk frontmatter -> form). Inverse of readFm. Assigning value
// programmatically doesn't fire input events, so it doesn't trigger onChange (= marking dirty).
const applyFm = (fm: DraftFrontmatter | undefined): void => {
    boot.title = fm?.title ?? "";
    boot.docLanguage = fm?.lang;
};

const debounce = (ms: number, fn: () => void): (() => void) => {
    let timer: number | undefined;
    return () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(fn, ms);
    };
};

// ── Correspondence view (main-content elements <-> source lines) ───────────
// On the CM side, matching lines get a line decoration; in the preview, elements get corr-hi.
const setCorr = StateEffect.define<{ from: number; to: number } | null>();
const corrLine = Decoration.line({ class: "cm-corrline" });
const corrField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        let next = deco.map(tr.changes);
        for (const e of tr.effects) {
            if (!e.is(setCorr)) {
                continue;
            }
            if (e.value == null) {
                next = Decoration.none;
                continue;
            }
            const { doc } = tr.state;
            const from = Math.max(1, Math.min(e.value.from, doc.lines));
            const to = Math.max(from, Math.min(e.value.to, doc.lines));
            const marks: ReturnType<typeof corrLine.range>[] = [];
            for (let ln = from; ln <= to; ln++) {
                marks.push(corrLine.range(doc.line(ln).from));
            }
            next = Decoration.set(marks);
        }
        return next;
    },
    provide: (f) => EditorView.decorations.from(f),
});

// ── Lint highlighting ─────────────────────────────────────────────────────
// Spelling: left to the browser's built-in spellcheck (the CM content's lang = the doc
// language's spellcheckLang).
// Prose lint: call the server's /api/lint (the doc language's adapter, e.g. textlint for `ja`)
// debounced and turn the offsets directly into mark decorations (body string = CM doc, so no
// coordinate conversion).
const setLintFindings = StateEffect.define<LintFinding[]>();
const lintField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        let next = deco.map(tr.changes);
        for (const e of tr.effects) {
            if (!e.is(setLintFindings)) {
                continue;
            }
            const { doc } = tr.state;
            const marks = e.value
                .filter((t) => t.range[0] < t.range[1] && t.range[1] <= doc.length)
                .map((t) =>
                    Decoration.mark({
                        class: "cm-lint",
                        attributes: { title: `${t.message} (${t.ruleId})` },
                    }).range(t.range[0], t.range[1]),
                )
                .sort((a, b) => a.from - b.from);
            next = Decoration.set(marks);
        }
        return next;
    },
    provide: (f) => EditorView.decorations.from(f),
});

const setCodeFindings = StateEffect.define<LintFinding[]>();
const codeLintField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        let next = tr.docChanged ? Decoration.none : deco;
        for (const e of tr.effects) {
            if (!e.is(setCodeFindings)) {
                continue;
            }
            const { doc } = tr.state;
            const marks = e.value
                .filter((t) => t.range[0] < t.range[1] && t.range[1] <= doc.length)
                .map((t) =>
                    Decoration.mark({
                        class: "cm-code-diagnostic",
                        attributes: { title: `${t.message} (${t.ruleId})` },
                    }).range(t.range[0], t.range[1]),
                )
                .sort((a, b) => a.from - b.from);
            next = Decoration.set(marks);
        }
        return next;
    },
    provide: (f) => EditorView.decorations.from(f),
});

// ── Code fence background ────────────────────────────────────────────────
// Paint fenced/indented code blocks with line decorations in a background color matching the
// preview (`pre` in serve.ts). No mark decoration on tags.monospace: consecutive blank lines
// make lezer-markdown merge them into one CodeText node, and a mark decoration spanning it
// desyncs CM's view layer (see the tags.monospace comment below). Line decorations only add a
// class to the line's outer div without spanning content, so they avoid the same problem.
const codeLine = Decoration.line({ class: "cm-codeline" });
const computeCodeLines = (state: EditorState): DecorationSet => {
    const marks: ReturnType<typeof codeLine.range>[] = [];
    syntaxTree(state).iterate({
        enter: (node) => {
            if (!CODE_BLOCK_NODE_NAMES.has(node.name)) {
                return;
            }
            const fromLine = state.doc.lineAt(node.from).number;
            const toLine = state.doc.lineAt(node.to).number;
            for (let ln = fromLine; ln <= toLine; ln++) {
                marks.push(codeLine.range(state.doc.line(ln).from));
            }
        },
    });
    return Decoration.set(marks);
};
const codeBlockField = StateField.define<DecorationSet>({
    create: (state) => computeCodeLines(state),
    update(deco, tr) {
        return tr.docChanged ? computeCodeLines(tr.state) : deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
});

const runLint = async (automatic = false): Promise<LintFinding[] | undefined> => {
    if (automatic && !autoValidationReady()) return;
    const doc = view.state.doc;
    const currentBoot = boot;
    const res = await localeFetch("/api/lint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            body: doc.toString(),
            lang: boot.docLanguage || boot.defaultLang,
        }),
    });
    if (!res.ok) throw new Error(`Validation failed: ${res.status}`);
    const { findings } = (await res.json()) as { findings: LintFinding[] };
    if (view.state.doc !== doc || boot !== currentBoot || (automatic && !autoValidationReady()))
        return;
    view.dispatch({ effects: setLintFindings.of(findings) });
    return findings;
};

// ── Insertion autocomplete ────────────────────────────────────────────────
// The slash palette inserts code fences and file links from the shared vocabulary.
const toSnippet = (sample: string): string => sample.replace(/<([^<>\n]+)>/g, "${$1}");

const buildSlash = (): Completion[] => {
    const o: Completion[] = [
        snippetCompletion("\n![${label}](${path})\n", {
            label: "/file",
            detail: t("File preview"),
            type: "keyword",
            section: t("Templates"),
        }),
        snippetCompletion("\n## ${h}\n", {
            label: "/h2",
            detail: t("heading"),
            type: "keyword",
            section: t("Templates"),
        }),
        snippetCompletion("\n### ${h}\n", {
            label: "/h3",
            detail: t("subheading"),
            type: "keyword",
            section: t("Templates"),
        }),
    ];
    for (const l of boot.codeLanguages ?? CODE_LANGS) {
        o.push(
            snippetCompletion(
                `\n${toSnippet(CODE_TEMPLATES[l] ?? `\`\`\`${l}\n<code>\n\`\`\``)}\n`,
                {
                    label: CODE_TEMPLATES[l] ? `/${l}` : `/code-${l}`,
                    detail: t("code fence"),
                    type: "keyword",
                    section: t("Templates"),
                },
            ),
        );
    }
    for (const f of boot.figures) {
        o.push(
            snippetCompletion(`\n![](${f})\n`, {
                label: `/file:${f}`,
                detail: t("figure reference"),
                type: "class",
                section: t("Figures"),
            }),
        );
    }
    for (const d of boot.docs) {
        o.push({
            label: `/link:${d.ref}`,
            detail: d.title,
            type: "variable",
            section: t("Doc links"),
            apply: `[${d.title}](${termFileUrl(d.ref)})`,
        });
    }
    for (const term of boot.terms) {
        if (!isTermFile(term.id)) continue;
        o.push({
            label: `/term:${term.id}`,
            detail: term.name,
            info: term.definition,
            type: "text",
            section: t("Terms"),
            apply: `[](${termFileUrl(term.id)})`,
        });
    }
    return o;
};
// Candidate data (figures / docs / terms) comes from boot, so rebuild it on every doc switch
// (so docs added or renamed elsewhere show up in the next doc's completions).
let SLASH: Completion[] = [];
let FIG_OPTS: Completion[] = [];
let DOC_REF_OPTS: Completion[] = [];
const rebuildCompletions = (): void => {
    SLASH = buildSlash();
    FIG_OPTS = boot.figures.map((f) => ({ label: f, type: "class" }));
    DOC_REF_OPTS = boot.docs.map((d) => ({
        label: termFileUrl(d.ref),
        detail: d.title,
        type: "variable",
    }));
};
rebuildCompletions();
document.addEventListener("docs:ui-language", rebuildCompletions);

// Inside code blocks (fenced/indented/inline), `/` occurs naturally (paths, JSX,
// comments, etc.), so insertion completion never fires there (otherwise Enter/Up/Down get
// captured by completion, and an accidental snippet completion makes the selection jump to a
// field position or inserts unwanted characters).
const CODE_NODE_NAMES = new Set([...CODE_BLOCK_NODE_NAMES, "InlineCode"]);
const inCodeContext = (ctx: CompletionContext): boolean => {
    for (
        let node: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
        node;
        node = node.parent
    ) {
        if (CODE_NODE_NAMES.has(node.name)) {
            return true;
        }
    }
    return false;
};

// File embeds occupy standalone paragraphs.
const atLineStart = (state: EditorState, from: number): boolean =>
    /^\s*$/.test(state.sliceDoc(state.doc.lineAt(from).from, from));

const docsComplete = (ctx: CompletionContext): CompletionResult | null => {
    const schema = schemaCompletion(ctx);
    if (schema !== undefined) return schema;
    if (inCodeContext(ctx)) {
        return null;
    }
    const termM = ctx.matchBefore(/\[[^\]\n]*\]\([^()\n]*/);
    if (termM && ctx.state.sliceDoc(Math.max(0, termM.from - 1), termM.from) !== "!")
        return {
            from: termM.from + termM.text.lastIndexOf("(") + 1,
            options: [
                ...DOC_REF_OPTS,
                ...boot.terms
                    .filter((term) => isTermFile(term.id))
                    .map((term) => ({
                        label: termFileUrl(term.id),
                        detail: term.name,
                        info: term.definition,
                        type: "text",
                    })),
            ],
            validFor: /[^()\s]*/,
        };
    const figM = ctx.matchBefore(/!\[[^\]\n]*\]\([\w./-]*/);
    if (figM && atLineStart(ctx.state, figM.from))
        return {
            from: figM.from + figM.text.lastIndexOf("(") + 1,
            options: FIG_OPTS,
            validFor: /[\w./-]*/,
        };
    const slashM = ctx.matchBefore(/\/[^\s/]*/);
    if (
        slashM &&
        (slashM.from === 0 || /\s/.test(ctx.state.sliceDoc(slashM.from - 1, slashM.from)))
    ) {
        return { from: slashM.from, options: SLASH, validFor: /^\/[^\s]*$/ };
    }
    if (ctx.explicit) {
        return { from: ctx.pos, options: SLASH };
    }
    return null;
};

// ── CodeMirror ────────────────────────────────────────────────────────────
// CM colors follow the --doc-* palette (so the 3-state theme switch applies as-is). Headings keep
// weight 400 and are distinguished by color.
// Same value as --doc-mono in the main content (preview).
const MONO_FONT = "var(--doc-mono)";
const theme = EditorView.theme({
    "&": {
        backgroundColor: "transparent",
        color: "var(--doc-fg-2)",
        fontSize: "12.5px",
        height: "100%",
    },
    ".cm-content": {
        fontFamily: MONO_FONT,
        fontVariantLigatures: "none",
        fontKerning: "none",
        caretColor: "var(--doc-fg)",
        // The last line sticks to the bottom edge and is hard to read, so reserve 20 blank
        // lines of bottom padding to let it scroll up to a comfortable position.
        paddingBottom: "20lh",
    },
    ".cm-scroller": { fontFamily: MONO_FONT, lineHeight: "20px" },
    ".cm-line": { minHeight: "20px" },
    ".cm-gutterElement": { lineHeight: "20px", fontVariantNumeric: "tabular-nums" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--doc-fg-4)", border: "none" },
    ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--doc-accent) 7%, transparent)" },
    ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--doc-accent) 7%, transparent)",
    },
    ".cm-corrline": {
        backgroundColor: "color-mix(in srgb, var(--doc-accent) 16%, transparent)",
    },
    // Background of fenced/indented code blocks (same mix as `pre` in the preview).
    ".cm-codeline": {
        backgroundColor: "color-mix(in srgb, currentColor 8%, transparent)",
    },
    // Prose lint findings (/api/lint). Spelling is left to the browser's built-in spellcheck
    // (its native squiggles show as-is, so CM adds no separate style).
    ".cm-lint": {
        textDecoration: "underline wavy",
        textDecorationColor: "var(--doc-warn, #b97600)",
        textUnderlineOffset: "3px",
        cursor: "help",
    },
    // Completion info panel (custom syntax sample + attributes): show the sample's newlines /
    // indentation as-is. The selector is `.cm-tooltip.cm-completionInfo` to beat the default
    // white-space (autocomplete's baseTheme uses the same two classes with `pre-line`, which
    // collapses indentation).
    ".cm-tooltip": {
        backgroundColor: "var(--doc-panel)",
        color: "var(--doc-fg)",
        border: "1px solid var(--doc-border)",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--doc-accent)",
        color: "var(--doc-accent-fg)",
    },
    ".cm-completionDetail, .cm-completionSection": { color: "var(--doc-fg-3)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail": { color: "inherit" },
    ".cm-tooltip.cm-completionInfo": {
        whiteSpace: "pre-wrap",
        fontFamily: MONO_FONT,
        fontSize: "11.5px",
        lineHeight: "1.7",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--doc-fg)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--doc-accent) 25%, transparent)",
    },
});
// tags.monospace (InlineCode/CodeText) is intentionally left uncolored: with several consecutive
// blank lines in fenced code (lezer-markdown merges them, blank lines included, into one CodeText
// node), its mark decoration spans the blank lines, CM's view layer desyncs, and the blank lines
// visually disappear (the actual doc is fine; only the display breaks). Still reproducible with
// @lezer/markdown 1.7.2, so not fixed upstream; omitting this rule is the minimal workaround.
const mdHighlight = HighlightStyle.define([
    { tag: tags.heading, color: "var(--doc-accent-2)", fontWeight: "400" },
    { tag: tags.link, color: "#e65100" },
    { tag: tags.url, color: "var(--doc-fg-3)" },
    { tag: tags.meta, color: "var(--doc-fg-3)" },
    { tag: tags.processingInstruction, color: "var(--doc-fg-3)" },
]);

// A doc switch reuses the same view and swaps the state per doc (view.setState, docStates), so
// extensions are built once and shared. The state is swapped to keep undo history per doc (shared
// history would let undo go back to the previous doc's content, and saving that would clobber
// another doc).
const textfiles = createTextfileEditors(
    theme,
    (file) => schedulePreview([file]),
    () => setDirty(dirty),
);
const editorExtensions: Extension[] = [
    keymap.of([
        {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
                void save();
                return true;
            },
        },
        {
            key: "Shift-Alt-f",
            preventDefault: true,
            run: () => {
                void validatePage();
                return true;
            },
        },
        indentWithTab,
    ]),
    editorSetup,
    inlineFoldButtons,
    codeFileButtons(() => boot.docId),
    previewSettingsState.init(() => boot.previews),
    filePreviewState,
    textfiles.extension,
    markdown({ base: markdownLanguage }),
    autocompletion({ override: [docsComplete] }),
    EditorView.lineWrapping,
    theme,
    syntaxHighlighting(mdHighlight),
    editorCodeHighlight(),
    corrField,
    lintField,
    codeLintField,
    codeBlockField,
    // Spellchecking is left to the browser; the content's lang (= its dictionary) is set per doc
    // from boot.spellcheckLang (applySpellcheckLang), not here.
    EditorView.contentAttributes.of({
        spellcheck: "true",
        autocorrect: "off",
        autocapitalize: "off",
    }),
    EditorView.updateListener.of((u) => {
        if (u.docChanged) {
            if (suppressChange) {
                suppressChange = false;
                return;
            }
            onChange();
            // Open the palette right after typing `/` or `:` (not word chars, so it won't
            // auto-trigger).
            let typed = "";
            for (const tr of u.transactions) {
                if (!tr.isUserEvent("input")) {
                    continue;
                }
                tr.changes.iterChanges((_fa, _ta, _fb, _tb, ins) => {
                    if (ins.length > 0) {
                        typed = ins.sliceString(ins.length - 1);
                    }
                });
            }
            const head = u.state.selection.main.head;
            if (
                typed === "/" ||
                (/^[:(| ]$/.test(typed) &&
                    schemaCompletion(new CompletionContext(u.state, head, false)) != null)
            ) {
                setTimeout(() => startCompletion(view), 0);
            }
        } else if (u.selectionSet) {
            highlightPreviewForCursor();
        }
        if (
            (u.selectionSet ||
                u.focusChanged ||
                syntaxTree(u.startState) !== syntaxTree(u.state)) &&
            $("validate").dataset.state === "pending" &&
            autoValidationReady()
        ) {
            markValidationPending();
            validateSoon();
        }
    }),
];

const view = new EditorView({
    state: EditorState.create({ doc: boot.body, extensions: editorExtensions }),
    parent: $("cm"),
});
applyFilePreviews(boot.filePreviews);

const setValidationState = (state: "pending" | "checking" | "valid" | "error"): void => {
    const button = $("validate");
    button.dataset.state = state;
    const label = {
        pending: "Validation pending",
        checking: "Validating",
        valid: "Validation passed",
        error: "Validation errors",
    }[state];
    button.dataset.i18nTitle = label;
    button.dataset.i18nAriaLabel = label;
    button.title = t(label);
    button.setAttribute("aria-label", t(label));
};
const autoValidationReady = (): boolean =>
    autovalidateEl.checked &&
    !document.activeElement?.closest(".cm-textfile, .cm-textfile-controls") &&
    !isEditingCodeBlock(view);
const markValidationPending = (): void =>
    setValidationState(autoValidationReady() ? "checking" : "pending");

let codeToolBusy = false;
let applyingValidation = false;
const validatePage = async (automatic = false): Promise<void> => {
    if (automatic && !autoValidationReady()) {
        markValidationPending();
        return;
    }
    if (codeToolBusy) return;
    codeToolBusy = true;
    setValidationState("checking");
    const button = $<HTMLButtonElement>("validate");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const doc = view.state.doc;
    const currentBoot = boot;
    let validatedDoc = doc;
    const fm = JSON.stringify(readFm());
    try {
        const response = await localeFetch("/api/code-tool", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                file: boot.file,
                body: doc.toString(),
                action: "validate",
            }),
        });
        const result = (await response.json()) as {
            error?: string;
            changes?: { from: number; to: number; insert: string }[];
            findings?: LintFinding[];
        };
        if (
            view.state.doc !== doc ||
            boot !== currentBoot ||
            JSON.stringify(readFm()) !== fm ||
            (automatic && !autoValidationReady())
        ) {
            markValidationPending();
            return;
        }
        if (!response.ok) throw new Error(result.error ?? response.statusText);
        const changes = result.changes ?? [];
        applyingValidation = true;
        try {
            view.dispatch({
                changes,
                effects: setCodeFindings.of(result.findings ?? []),
                userEvent: "input.format",
                annotations: isolateHistory.of("full"),
            });
        } finally {
            applyingValidation = false;
        }
        validatedDoc = view.state.doc;
        const proseFindings = await runLint(automatic);
        const snapshot = await render();
        if (
            boot !== currentBoot ||
            view.state.doc !== validatedDoc ||
            JSON.stringify(readFm()) !== fm ||
            (automatic && !autoValidationReady())
        ) {
            markValidationPending();
            return;
        }
        setValidationState(
            !snapshot ||
                !proseFindings ||
                snapshot.errors.length > 0 ||
                proseFindings.length > 0 ||
                (result.findings?.length ?? 0) > 0
                ? "error"
                : "valid",
        );
    } catch (error) {
        if (automatic && !autoValidationReady()) {
            markValidationPending();
        } else if (
            boot === currentBoot &&
            view.state.doc === validatedDoc &&
            JSON.stringify(readFm()) === fm
        ) {
            setValidationState("error");
            setStatus(String(error), true);
        }
    } finally {
        codeToolBusy = false;
        button.disabled = false;
        button.removeAttribute("aria-busy");
        if (
            autoValidationReady() &&
            (boot !== currentBoot ||
                view.state.doc !== validatedDoc ||
                JSON.stringify(readFm()) !== fm ||
                button.dataset.state === "pending")
        ) {
            markValidationPending();
            validateSoon();
        }
    }
};
$("validate").addEventListener("click", () => void validatePage());

// The doc language's spellcheck dictionary (boot.spellcheckLang), re-applied on doc switch.
const applySpellcheckLang = (): void => {
    view.contentDOM.lang = boot.spellcheckLang;
};
applySpellcheckLang();

// ── Render / save ─────────────────────────────────────────────────────────
const post = async (url: string): Promise<DraftResponse> => {
    const res = await localeFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            file: boot.file,
            frontmatter: readFm(),
            body: view.state.doc.toString(),
            baseRaw,
            textfiles: textfiles.previewFiles(),
        }),
    });
    if (!res.ok) {
        throw new Error(`${res.status} ${await res.text()}`);
    }
    return (await res.json()) as DraftResponse;
};

// Keep the active page, its live title and the ancestor breadcrumb in sync.
const updateNavLocation = (): void => {
    const header = $("site-title");
    header.textContent = header.title = siteTitle ?? "dooc";
    const logo = $<HTMLImageElement>("site-icon");
    logo.hidden = !siteIcon;
    if (siteIcon) logo.src = siteIcon;
    else logo.removeAttribute("src");
    const docTitle = boot.title.trim() || boot.docId;
    document.title =
        docTitle === siteTitle ? docTitle : `${docTitle} — ${siteTitle ?? "dooc edit"}`;
    const item = document.querySelector<HTMLElement>(
        `#nav-groups .nav-item[data-doc-id="${CSS.escape(boot.docId)}"]`,
    );
    if (!item) {
        // Doc not in the list (e.g. right after a rename): leave it to the nav refresh
        // (refreshNav).
        return;
    }
    for (const a of document.querySelectorAll("#nav-groups .nav-row a.cur")) {
        a.classList.remove("cur");
    }
    const cur = item.querySelector(":scope > .nav-row > a");
    cur?.classList.add("cur");
    // Reflect the current title (empty -> id, like the server's docDisplayName).
    const label = cur?.querySelector(".nav-label");
    if (cur && label) {
        label.textContent = boot.title.trim() || boot.docId;
        cur.setAttribute("title", label.textContent);
    }
    for (
        let it = item.parentElement?.closest(".nav-item");
        it;
        it = it.parentElement?.closest(".nav-item")
    ) {
        it.classList.add("open");
    }
    focusNavTree($("nav-groups"));
};

const apply = (r: RenderSnapshot, keepLastValid = true): void => {
    if (r.sourceFile) boot.sourceFile = r.sourceFile;
    if (JSON.stringify(view.state.field(previewSettingsState)) !== JSON.stringify(r.previews)) {
        boot.previews = r.previews;
        view.dispatch({ effects: setPreviewSettings.of(r.previews) });
    }
    renderRevision++;
    const template = document.createElement("template");
    template.innerHTML = r.html;
    const errors = [
        ...new Set([
            ...r.errors,
            ...Object.entries(r.filePreviews).flatMap(([file, messages]) =>
                messages.map((message) =>
                    message.startsWith(`${file}:`) ? message : `${file}: ${t(message)}`,
                ),
            ),
        ]),
    ];
    applyFilePreviews(r.filePreviews, keepLastValid ? errors : []);
    if (errors.length && keepLastValid) return;
    updatePreview(template.content);
    tagCorrespondence(r.blockLines ?? []);
    highlightPreviewForCursor();
    updateNavLocation();
    applyUiLanguage();
};

// Reflect a disk-side change made first (direct edit / git, etc.): replace the CM doc /
// front-matter form with the disk content and update the base. Two callers:
//   handleConflict when "reflect" is chosen = discard local unsaved edits in favor of disk.
//   HMR's onContent (handleContentChange) on an external change to our own file = called only
//   when not dirty (= no unsaved edits to discard).
const reflectExternal = (r: ExternalSnapshot, message: string): void => {
    suppressChange = true;
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: r.body ?? "" },
    });
    applyFm(r.frontmatter);
    baseRaw = r.raw;
    apply(r);
    setDirty(false);
    setStatus(message);
};

// Choosing local adopts this disk version as the base; a later external write still conflicts.
const handleConflict = async (r: ExternalSnapshot): Promise<"local" | "external" | undefined> => {
    const currentBoot = boot;
    conflictPending = true;
    const choice = await chooseConflict(
        boot.sourceFile ?? boot.file,
        `${JSON.stringify(readFm(), null, 2)}\n\n${view.state.doc}`,
        r.raw,
    );
    if (boot !== currentBoot) return;
    if (choice === "external") {
        reflectExternal(r, "Applied external changes");
        conflictPending = false;
    } else if (choice === "local") {
        baseRaw = r.raw;
        conflictPending = false;
    } else {
        setStatus(
            "Changed externally — keeping your changes (you'll be asked again on save)",
            true,
        );
    }
    return choice;
};

const render = async (): Promise<RenderSnapshot | undefined> => {
    const revision = ++renderRevision;
    const doc = view.state.doc;
    const currentBoot = boot;
    const fm = JSON.stringify(readFm());
    const files = JSON.stringify(textfiles.previewFiles());
    const isCurrent = () =>
        revision === renderRevision &&
        view.state.doc === doc &&
        boot === currentBoot &&
        JSON.stringify(readFm()) === fm &&
        JSON.stringify(textfiles.previewFiles()) === files;
    try {
        const result = await post("/api/render");
        if (!isCurrent()) return;
        apply(result);
        return result;
    } catch (e) {
        if (!isCurrent()) return;
        setPreviewState(
            "error",
            String(e),
            Object.entries(view.state.field(filePreviewState).previews)
                .filter(([, value]) => value.state === "loading")
                .map(([file]) => file),
        );
        setStatus(t("Failed to update preview: {error}", { error: String(e) }), true);
    }
};

// ── HMR: partial reflection of content (md/metadata/figures) ───────────────
// When the hmr.ts client script picks up a content change (excluding our own writes), it calls
// `window.__docsHmr.onContent(files)` (no reload). Here, given those files: for our own file,
// reflect the current disk content into the editor (do nothing if dirty); for other files,
// re-render the main content from the current edits and swap the nav too. CodeMirror's
// cursor/scroll/undo history and unsaved content are left untouched (for other files) / left
// untouched if dirty (for our own file).

// Refresh the tree and restore its expanded branches.
const refreshNav = async (): Promise<void> => {
    const requestedBoot = boot;
    try {
        const res = await localeFetch(`/api/nav?current=${encodeURIComponent(boot.docId)}`);
        if (!res.ok) {
            return;
        }
        const data = (await res.json()) as NavResponse;
        if (boot !== requestedBoot || document.querySelector(".nav-rename-form")) return;
        siteTitle = data.siteTitle;
        siteIcon = data.siteIcon;
        boot.translatedLanguages = data.translatedLanguages;
        updateLanguageControls();
        const navGroups = document.getElementById("nav-groups");
        if (navGroups) {
            navGroups.innerHTML = data.html;
            for (const pane of panes) {
                const state = pane === activePane ? boot : pane.draft?.boot;
                if (!state) continue;
                const link = navGroups.querySelector<HTMLAnchorElement>(
                    `[data-doc-id="${CSS.escape(state.docId)}"] > .nav-row > a`,
                );
                if (link) state.path = new URL(link.href).pathname;
            }
            if (currentPath !== boot.path) {
                currentPath = boot.path;
                history.replaceState(null, "", localeUrl(currentPath + location.hash));
            }
        }
        (window as unknown as { __docsNavRestore?: () => void }).__docsNavRestore?.();
        updateNavLocation();
        applyUiLanguage();
    } catch {
        // best-effort: picked up again on the next change
    }
};

// Hook for reordering (serve.ts's nav DnD script) to re-fetch when a save failed (= the list
// diverged from disk). Shares this implementation instead of duplicating the nav refresh there.
(window as unknown as { __docsRefreshNav?: () => Promise<void> }).__docsRefreshNav = refreshNav;

// Watch events use physical paths; the save API keeps the document's stable ID.
const ownWatchPath = (): string => boot.sourceFile ?? `content/${boot.file}`;

const handleContentChange = async (files: string[]): Promise<void> => {
    if (document.querySelector(".nav-rename-form")) {
        pendingContentFiles.push(...files);
        return;
    }
    if (saveTask) await saveTask;
    await textfiles.reloadChanged(files);
    const currentBoot = boot;
    if (files.includes("dooc.yaml") || files.some((file) => file.endsWith(".md"))) {
        try {
            const res = await localeFetch(`/api/doc?file=${encodeURIComponent(boot.file)}`);
            if (!res.ok) {
                setPreviewState("error", String(res.status));
                setStatus(
                    t("Failed to apply external changes: {error}", { error: res.status }),
                    true,
                );
                return;
            }
            const result = (await res.json()) as DocResponse;
            if (boot !== currentBoot) return;
            if (result.raw !== baseRaw) {
                if (dirty) {
                    if (!conflictPending && (await handleConflict(result)) === "local")
                        await save();
                } else reflectExternal(result, "Applied external changes");
            }
        } catch (e) {
            if (boot !== currentBoot) return;
            setPreviewState("error", String(e));
            setStatus(t("Failed to apply external changes: {error}", { error: String(e) }), true);
            return;
        }
    }
    // Other docs / figures / dooc.yaml: reflect changes to figures, file links and the
    // terms in the main content using the current edits, and swap the nav (list, order).
    await render();
    await refreshNav();
};

// Files from the server are already debounced (60ms, hmr.ts), but several change frames can still
// arrive in quick succession, so the client also batches them over 120ms into one call.
let pendingContentFiles: string[] = [];
const flushContent = debounce(120, () => {
    const files = pendingContentFiles;
    pendingContentFiles = [];
    void handleContentChange(files);
});

// This script runs before the hmr.ts client script (which appears in body after this bundle)
// adds setDirty, so create the object here if missing and let that script merge into
// it later (hmr.ts also adds via Object.assign instead of overwriting, so order doesn't matter).
(window as unknown as { __docsHmr?: HmrBridge }).__docsHmr = {
    ...(hmr() ?? ({} as HmrBridge)),
    onContent: (files: string[]) => {
        renderRevision++;
        setPreviewState(
            "loading",
            "",
            files.includes(ownWatchPath()) ||
                files.includes(`locales/${boot.contentLanguage}/${ownWatchPath()}`)
                ? undefined
                : files,
        );
        pendingContentFiles.push(...files);
        flushContent();
    },
};
mountFileUpload();

let saveTask: Promise<void> | undefined;
const save = (): Promise<void> => {
    saveTask ??= saveCurrent().finally(() => {
        saveTask = undefined;
    });
    return saveTask;
};
const saveCurrent = async (): Promise<void> => {
    const savingBoot = boot;
    const savingDoc = view.state.doc;
    const savingFm = JSON.stringify(readFm());
    const savingFiles = JSON.stringify(textfiles.previewFiles());
    setSaveState("saving");
    $("save").setAttribute("aria-busy", "true");
    try {
        const r = await post("/api/save");
        if (boot !== savingBoot) return;
        if (r.conflict) {
            if ((await handleConflict(r)) === "local") await saveCurrent();
            if (dirty) setSaveState("error");
            return;
        }
        baseRaw = r.raw;
        const language = boot.contentLanguage ?? boot.defaultLang;
        boot.translatedLanguages = [...new Set([...(boot.translatedLanguages ?? []), language])];
        if (view.state.doc !== savingDoc || JSON.stringify(readFm()) !== savingFm) {
            setSaveState(autosaveEl.checked ? "saving" : "pending");
            if (autosaveEl.checked) autosave();
            return;
        }
        if (JSON.stringify(textfiles.previewFiles()) === savingFiles) apply(r);
        else await render();
        updateLanguageControls();
        setDirty(false);
        conflictPending = false;
        setStatus(
            r.errors.length > 0
                ? t("Saved (validation errors: {count})", { count: r.errors.length })
                : t("Saved {time}", { time: new Date().toLocaleTimeString() }),
            r.errors.length > 0,
        );
    } catch (e) {
        if (boot === savingBoot) {
            setSaveState("error");
            setStatus(t("Failed to save: {error}", { error: String(e) }), true);
        }
    } finally {
        $("save").removeAttribute("aria-busy");
    }
};

const refresh = debounce(150, () => void render());
const schedulePreview = (files?: readonly string[]): void => {
    renderRevision++;
    setPreviewState("loading", "", files);
    refresh();
};
const autosave = debounce(1000, () => {
    if (dirty && autosaveEl.checked && !conflictPending) {
        void save();
    }
});
const validateSoon = debounce(600, () => {
    if (autovalidateEl.checked) void validatePage(true);
});
const onChange = (): void => {
    markValidationPending();
    setDirty(true);
    setStatus(autosaveEl.checked ? "Modified (waiting for auto-save)" : "Unsaved changes");
    schedulePreview();
    autosave();
    if (!applyingValidation) validateSoon();
};

// ── Correspondence view tagging / highlighting ───────────────────────────
// Zip the direct children of the main <article> with blockLines in block order (excluding the
// leading front-matter elements = errors / h1 / fullname / lead). Full-listing blocks for figures
// or term definitions occasionally expand 1:N and shift everything after, but highlighting is
// correct up to the min index (a "good enough" display for a dev tool).
const clearPreviewHi = (): void => {
    for (const r of ranges) {
        r.el.classList.remove("corr-hi");
    }
};
const tagCorrespondence = (blockLines: number[]): void => {
    lastBlockLines = blockLines;
    ranges = [];
    const article = mainEl.querySelector("article");
    if (!article) {
        return;
    }
    const kids = ([...article.children] as HTMLElement[]).filter(
        (el) => !el.matches(".errors, h1, .fullname"),
    );
    const n = Math.min(kids.length, blockLines.length);
    for (let i = 0; i < n; i++) {
        const el = kids[i];
        const ln = blockLines[i];
        if (!el || ln == null) {
            continue;
        }
        const nextLn = blockLines[i + 1];
        el.dataset.ln = String(ln);
        ranges.push({ ln, end: nextLn == null ? 1e9 : nextLn - 1, el });
    }
};
const rangeForEl = (el: HTMLElement): Corr | undefined => ranges.find((x) => x.el === el);
const highlightPreviewForCursor = (): void => {
    if (!corrOn) {
        return;
    }
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    clearPreviewHi();
    const r = ranges.find((x) => line >= x.ln && line <= x.end);
    if (r) {
        r.el.classList.add("corr-hi");
        r.el.scrollIntoView({ block: "nearest" });
    }
};

// preview -> CM: hover highlights the matching lines and scrolls CM to them; click moves the
// cursor there and focuses.
workspace.addEventListener("mouseover", (ev) => {
    if (!mainEl.contains(ev.target as Node)) return;
    if (!corrOn) {
        return;
    }
    const el = (ev.target as HTMLElement).closest("[data-ln]") as HTMLElement | null;
    if (!el || !mainEl.contains(el)) {
        return;
    }
    const r = rangeForEl(el);
    if (!r) {
        return;
    }
    clearPreviewHi();
    el.classList.add("corr-hi");
    const { doc } = view.state;
    const at = doc.line(Math.max(1, Math.min(r.ln, doc.lines))).from;
    view.dispatch({
        effects: [
            setCorr.of({ from: r.ln, to: r.end }),
            EditorView.scrollIntoView(at, { y: "center" }),
        ],
    });
});
workspace.addEventListener("mouseleave", () => {
    if (!corrOn) {
        return;
    }
    view.dispatch({ effects: setCorr.of(null) });
    highlightPreviewForCursor();
});
workspace.addEventListener("click", (ev) => {
    if (!mainEl.contains(ev.target as Node)) return;
    if (!corrOn) {
        return;
    }
    const target = ev.target as HTMLElement;
    if (target.closest("a")) {
        return; // don't block navigation via doc / figure links
    }
    const el = target.closest("[data-ln]") as HTMLElement | null;
    if (!el) {
        return;
    }
    const r = rangeForEl(el);
    if (!r) {
        return;
    }
    const { doc } = view.state;
    const at = doc.line(Math.max(1, Math.min(r.ln, doc.lines))).from;
    view.dispatch({
        selection: { anchor: at },
        effects: [
            setCorr.of({ from: r.ln, to: r.end }),
            EditorView.scrollIntoView(at, { y: "center" }),
        ],
    });
    view.focus();
});

// ── Language / save controls ────────────────────────────────────────────
$("fm-lang").addEventListener("change", () => {
    const language = $<HTMLSelectElement>("fm-lang").value;
    updateLanguageControls();
    void changeLanguage(language);
});
$("fm-lang").addEventListener("docs:toggle-language", (event) => {
    void toggleTranslation((event as CustomEvent<string>).detail);
});
$("save").addEventListener("click", () => void save());

// ── Edit title and file name over the existing tree label ───────────────────────
const FLASH_KEY = "docs:flash";
const startRename = (): void => {
    const existing = document.querySelector<HTMLFormElement>(".nav-rename-form");
    if (existing) {
        existing.requestSubmit();
        return;
    }
    const row = document.querySelector<HTMLElement>(
        `#nav-groups [data-doc-id="${CSS.escape(boot.docId)}"] > .nav-row`,
    );
    const link = row?.querySelector<HTMLAnchorElement>(":scope > a");
    if (!row || !link) return;
    const editingBoot = boot;
    const originalSource = ownWatchPath();
    const originalName = originalSource.split("/").pop() ?? boot.file;
    const form = document.createElement("form");
    form.className = "nav-rename-form";
    form.title = t("Enter to save / Esc to cancel");
    const bounds = link.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    form.style.left = `${bounds.left - rowBounds.left}px`;
    form.style.width = `${bounds.width}px`;
    const title = document.createElement("input");
    title.id = "fm-title";
    title.name = "title";
    title.value = boot.title;
    title.setAttribute("aria-label", t("title"));
    const input = document.createElement("input");
    input.id = "pfile-input";
    input.name = "name";
    input.value = originalName;
    input.required = true;
    input.spellcheck = false;
    input.setAttribute("aria-label", t("File name"));
    input.addEventListener("input", () => input.setCustomValidity(""));
    form.append(title, input);
    row.append(form);
    row.classList.add("renaming");
    title.select();
    let busy = false;
    let closed = false;
    const end = (): void => {
        if (closed) return;
        closed = true;
        form.remove();
        row.classList.remove("renaming");
        setStatus("");
        if (pendingContentFiles.length) flushContent();
        void refreshNav();
    };
    form.addEventListener("focusout", (ev) => {
        if (busy || closed || form.contains(ev.relatedTarget as Node)) return;
        end();
        setStatus("");
    });
    form.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape" && !busy) {
            ev.preventDefault();
            end();
            setStatus("");
            link.focus();
        } else if (ev.key === "Enter") {
            ev.preventDefault();
            form.requestSubmit();
        }
    });
    form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        if (busy || boot !== editingBoot) return;
        const next = input.value.trim();
        if (!isDocumentFileName(next)) {
            input.setCustomValidity(t("Enter a file name ending in .md"));
            input.reportValidity();
            return;
        }
        busy = true;
        paneBusy = true;
        title.readOnly = input.readOnly = true;
        void (async () => {
            try {
                await saveTask;
                if (boot !== editingBoot) return;
                if (boot.title !== title.value) {
                    boot.title = title.value;
                    setDirty(true);
                }
                if (dirty) await save();
                // A failed or unresolved save must never be followed by a rename/reload.
                if (dirty) throw new Error(t("Unsaved changes"));
                if (next === originalName) {
                    end();
                    return;
                }
                if (!(await confirmLeave(true, true))) return;
                const res = await localeFetch("/api/rename", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        file: boot.file,
                        name: next,
                        sourceFile: originalSource,
                    }),
                });
                const data = (await res.json()) as RenameResponse;
                if (!res.ok || !data.ok) throw new Error(data.error ?? String(res.status));
                sessionStorage.setItem(FLASH_KEY, t("Renamed to {filename}", { filename: next }));
                goToPage(localeUrl(data.path));
            } catch (e) {
                setStatus(
                    t("Can't rename: {error}", {
                        error: e instanceof Error ? e.message : String(e),
                    }),
                    true,
                );
                input.focus();
            } finally {
                busy = false;
                paneBusy = false;
                title.readOnly = input.readOnly = false;
            }
        })();
    });
};
// Show the result stored before the rename (= reload) exactly once.
{
    const flash = sessionStorage.getItem(FLASH_KEY);
    if (flash) {
        sessionStorage.removeItem(FLASH_KEY);
        setStatus(flash);
    }
}

// ── Adding figures (file picker / drop onto the editor) ──────────────────────
// Write to figures/ (POST /api/figure) and insert a Markdown embed. Figures are site-wide, so
// they work the same from a doc at any depth. Insertion point: the line itself if blank,
// otherwise after the end of the line.
const FIG_ACCEPT = /\.(svg|png|webp|jpe?g)$/i;
const hasFiles = (ev: DragEvent): boolean => ev.dataTransfer?.types.includes("Files") ?? false;
const readBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
    });
const uploadFigure = async (file: File): Promise<string> => {
    const res = await localeFetch("/api/figure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: file.name, data: await readBase64(file) }),
    });
    const data = (await res.json()) as { file?: string; path?: string; error?: string };
    if (!res.ok || !data.file) {
        throw new Error(data.error ?? String(res.status));
    }
    const path = data.path ?? `figures/${data.file}`;
    if (!boot.figures.includes(path)) {
        boot.figures.push(path);
        rebuildCompletions();
    }
    return path;
};
const insertFigures = async (files: File[], pos?: number): Promise<void> => {
    const ok = files.filter((f) => FIG_ACCEPT.test(f.name));
    if (ok.length === 0) {
        setStatus("Only svg / png / webp / jpeg can be added", true);
        return;
    }
    setStatus(t("Adding figures… ({count})", { count: ok.length }));
    try {
        const names: string[] = [];
        for (const f of ok) {
            names.push(await uploadFigure(f));
        }
        const line = view.state.doc.lineAt(pos ?? view.state.selection.main.head);
        const block = names.map((n) => `![](${n})`).join("\n\n");
        const blank = line.text.trim() === "";
        const insert = blank ? block : `\n\n${block}`;
        const from = blank ? line.from : line.to;
        view.dispatch({
            changes: { from, to: blank ? line.to : line.to, insert },
            selection: { anchor: from + insert.length },
            scrollIntoView: true,
        });
        view.focus();
        setStatus(t("Added figures: {names}", { names: names.join(", ") }));
    } catch (e) {
        setStatus(
            t("Failed to add figures: {error}", {
                error: e instanceof Error ? e.message : String(e),
            }),
            true,
        );
    }
};
const cmBox = $("cm");
cmBox.addEventListener("dragover", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    cmBox.classList.add("dropping");
});
cmBox.addEventListener("dragleave", (ev) => {
    if (!cmBox.contains(ev.relatedTarget as Node)) cmBox.classList.remove("dropping");
});
// Use capture to take the drop before CM's own drop handling (which inserts the file name as
// text).
cmBox.addEventListener(
    "drop",
    (ev) => {
        cmBox.classList.remove("dropping");
        if (!hasFiles(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY }) ?? undefined;
        void insertFigures([...(ev.dataTransfer?.files ?? [])], pos);
    },
    true,
);
// A drop onto the main content (preview) inserts at the cursor position.
workspace.addEventListener("dragover", (ev) => {
    if (!mainEl.contains(ev.target as Node)) return;
    if (hasFiles(ev)) ev.preventDefault();
});
workspace.addEventListener("drop", (ev) => {
    if (!mainEl.contains(ev.target as Node)) return;
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    void insertFigures([...(ev.dataTransfer?.files ?? [])]);
});

// ── Deleting a doc ─────────────────────────────────────────────────────
// If other docs reference it via file links, 409 + referencedBy is
// returned; show the list, re-confirm deletion anyway, then resend with force.
const deleteDoc = async (): Promise<void> => {
    const file = boot.file;
    if (
        !(await confirmDialog(
            t('Delete "{file}"? (this cannot be undone)', { file: boot.sourceFile ?? file }),
            t("Delete doc"),
            true,
        ))
    ) {
        return;
    }
    if (!(await confirmLeave(true, true))) return;
    const attempt = async (force: boolean): Promise<void> => {
        const res = await localeFetch("/api/delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file, force }),
        });
        const data = (await res.json()) as DeleteResponse;
        if (res.status === 409 && data.referencedBy && !force) {
            const list = data.referencedBy.join("\n");
            if (
                await confirmDialog(
                    t("Referenced documents: {list}", { list }),
                    t("Delete doc"),
                    true,
                )
            ) {
                await attempt(true);
            }
            return;
        }
        if (!res.ok || !data.ok) {
            await showNotice(t("Failed to delete: {error}", { error: data.error ?? res.status }));
            return;
        }
        goToPage(localeUrl(data.path));
    };
    try {
        await attempt(false);
    } catch (e) {
        await showNotice(t("Failed to delete: {error}", { error: String(e) }));
    }
};

// ── Gear hover menu toggles (persisted in localStorage) ────────────────────
autosaveEl.checked = localStorage.getItem(AUTOSAVE_KEY) !== "0";
setSaveState(dirty ? (autosaveEl.checked ? "saving" : "pending") : "saved");
autosaveEl.addEventListener("change", () => {
    setSaveState(dirty ? (autosaveEl.checked ? "saving" : "pending") : "saved");
    localStorage.setItem(AUTOSAVE_KEY, autosaveEl.checked ? "1" : "0");
    if (autosaveEl.checked && dirty) {
        void save();
    }
});
autovalidateEl.addEventListener("change", () => {
    localStorage.setItem("docs-edit:autovalidate", autovalidateEl.checked ? "1" : "0");
    if (autovalidateEl.checked) {
        markValidationPending();
        validateSoon();
    } else if ($("validate").dataset.state === "checking") setValidationState("pending");
});
const bindToggle = (id: string, key: string, dflt: boolean, on: (v: boolean) => void): void => {
    const el = $<HTMLInputElement>(id);
    const stored = localStorage.getItem(key);
    el.checked = stored == null ? dflt : stored === "1";
    el.addEventListener("change", () => {
        localStorage.setItem(key, el.checked ? "1" : "0");
        on(el.checked);
    });
    on(el.checked);
};
bindToggle("opt-corr", CORR_KEY, false, (v) => {
    corrOn = v;
    document.body.classList.toggle("corr", v);
    if (v) {
        tagCorrespondence(lastBlockLines);
        highlightPreviewForCursor();
    } else {
        clearPreviewHi();
        view.dispatch({ effects: setCorr.of(null) });
    }
});

// The gear opens on hover / focus-within (CSS). Click / Enter also pins it open or closed (for
// keyboard use).
const gear = $("gear");
gear.addEventListener("click", (ev) => {
    if (!$("gearmenu").contains(ev.target as Node)) {
        gear.classList.toggle("open");
    }
});
// Enter / Space toggle via the inner button's click. Esc closes.
gear.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
        gear.classList.remove("open");
    }
});
document.addEventListener("click", (ev) => {
    if (!gear.contains(ev.target as Node)) {
        gear.classList.remove("open");
    }
});

let leavingPage = false;
const otherUnsaved = (): boolean =>
    textfiles.hasUnsavedChanges() || panes.some((pane) => pane !== activePane && pane.draft?.dirty);
window.addEventListener("beforeunload", (ev) => {
    if (!leavingPage && (dirty || otherUnsaved())) {
        ev.preventDefault();
        // Chrome compatibility (some versions show no prompt with preventDefault alone).
        ev.returnValue = "";
    }
});

// ── Doc switching (client-side navigation) ────────────────────────────────
// The sidebar (nav) keeps the same DOM for the whole editing session, since reloading the page
// on a doc link would lose the scroll position / search query / collapsed state every time.
// Instead, `/api/page` supplies only the parts to swap (main html + panel file name /
// front-matter fields + CM contents + boot), and the nav only updates the current-location
// display (cur + TOC). Non-doc routes and fetch failures fall back to normal navigation.
let currentPath = location.pathname;

// Handling of leaving a doc with unsaved changes: same decision as beforeunload (real
// navigation). With autosave ON, silently save and then move (= treated as a continuation of
// typing).
const confirmLeave = async (all = false, activeApproved = false): Promise<boolean> => {
    if (!activeApproved && dirty && autosaveEl.checked && !conflictPending) {
        await save();
    }
    if ((activeApproved || !dirty) && (!all || !otherUnsaved())) return true;
    return confirmDialog(
        t("You have unsaved changes. Discard them and leave?"),
        t("Discard changes"),
        true,
    );
};
const goToPage = (url: string): void => {
    leavingPage = true;
    window.location.href = url;
};
const leavePage = async (url: string, activeApproved = false): Promise<void> => {
    await saveTask;
    if (await confirmLeave(true, activeApproved)) goToPage(url);
};

let languageButton: HTMLButtonElement | undefined;
const languageMenu = $("preview-language-menu");
const paneActions = workspace.querySelector(".pane-actions") as HTMLElement;
const closeLanguageMenu = (): void => {
    languageMenu.hidden = true;
    languageButton?.setAttribute("aria-expanded", "false");
};
workspace.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(".pane-language");
    if (!button) return;
    const pane = panes.find((item) => item.element.contains(button));
    if (!pane) return;
    if (button === languageButton && !languageMenu.hidden) {
        closeLanguageMenu();
        return;
    }
    void (async () => {
        await activatePane(pane);
        if (activePane !== pane) return;
        closeLanguageMenu();
        languageButton = button;
        languageMenu.hidden = false;
        button.setAttribute("aria-expanded", "true");
        const rect = button.getBoundingClientRect();
        languageMenu.style.top = `${rect.bottom + 6}px`;
        languageMenu.style.left = `${Math.max(8, Math.min(rect.right - languageMenu.offsetWidth, innerWidth - languageMenu.offsetWidth - 8))}px`;
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
            languageMenu.animate(
                [
                    { opacity: 0, transform: "translateY(-6px) scale(.98)" },
                    { opacity: 1, transform: "none" },
                ],
                { duration: 140, easing: "cubic-bezier(.2, .8, .2, 1)" },
            );
        }
        languageMenu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    })();
});
document.addEventListener("pointerdown", (event) => {
    if (
        !languageMenu.contains(event.target as Node) &&
        !(event.target as Element).closest(".pane-language")
    )
        closeLanguageMenu();
});
languageMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        event.preventDefault();
        closeLanguageMenu();
        languageButton?.focus();
    } else if (event.key === "Tab") closeLanguageMenu();
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = [
            ...languageMenu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        ];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const index =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[index]?.focus();
    }
});
languageMenu.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(".language-option");
    if (!button?.dataset.language) return;
    closeLanguageMenu();
    void changeLanguage(button.dataset.language);
});

interface PaneDraft {
    boot: Boot;
    state: EditorState;
    fm: DraftFrontmatter;
    baseRaw: string;
    dirty: boolean;
    conflictPending: boolean;
    blockLines: number[];
}
interface PreviewPane {
    id: number;
    element: HTMLElement;
    draft?: PaneDraft;
}
const paneHost = $("preview-panes");
const panes: PreviewPane[] = [{ id: 0, element: mainEl.parentElement as HTMLElement }];
let activePane = panes[0] as PreviewPane;
let paneSequence = 1;
let paneBusy = false;
const stateKey = (value: Boot): string => `${activePane.id}:${value.contentLanguage}:${value.file}`;
const capturePane = (): void => {
    activePane.draft = {
        boot,
        state: view.state,
        fm: readFm(),
        baseRaw,
        dirty,
        conflictPending,
        blockLines: lastBlockLines,
    };
};
const syncPane = (): void => {
    activePane.element.dataset.language = boot.contentLanguage ?? boot.defaultLang;
    currentPath = boot.path;
    closeLanguageMenu();
    $("boot").textContent = JSON.stringify(boot);
    for (const pane of panes) {
        pane.element.classList.toggle("active", pane === activePane);
        pane.element.dataset.i18nAriaLabel = pane === activePane ? "Active pane" : "Activate pane";
    }
    updateLanguageControls();
};
const restorePane = (pane: PreviewPane): void => {
    const draft = pane.draft;
    if (!draft) return;
    clearPreviewHi();
    activePane = pane;
    mainEl = pane.element.querySelector(".preview-content") as HTMLElement;
    renderRevision++;
    boot = draft.boot;
    baseRaw = draft.baseRaw;
    conflictPending = draft.conflictPending;
    suppressChange = false;
    view.setState(draft.state);
    applyFm(draft.fm);
    updateNavLocation();
    applySpellcheckLang();
    rebuildCompletions();
    setDirty(draft.dirty);
    setStatus(dirty ? "Unsaved changes" : "");
    tagCorrespondence(draft.blockLines);
    syncPane();
    markValidationPending();
    validateSoon();
};
const activatePane = async (pane: PreviewPane): Promise<void> => {
    if (pane === activePane || paneBusy) return;
    paneBusy = true;
    try {
        await saveTask;
        const draft = pane.draft;
        if (!draft) return;
        let fresh: PageResponse | undefined;
        if (!draft.dirty) {
            const response = await fetch(`/api/page?route=${encodeURIComponent(draft.boot.path)}`, {
                headers: {
                    "x-docs-language": draft.boot.contentLanguage ?? draft.boot.defaultLang,
                },
            });
            if (response.ok) fresh = (await response.json()) as PageResponse;
        }
        await saveTask;
        capturePane();
        restorePane(pane);
        if (fresh) {
            const scrollTop = pane.element.scrollTop;
            swapDoc(fresh);
            pane.element.scrollTop = scrollTop;
        } else void render();
        history.replaceState(null, "", localeUrl(currentPath));
        void refreshNav();
    } catch {
        setStatus(t("Failed to load pane"), true);
    } finally {
        paneBusy = false;
    }
};
for (const event of ["pointerdown", "focusin"]) {
    paneHost.addEventListener(event, (ev) => {
        if ((ev.target as Element).closest(".pane-language")) return;
        const element = (ev.target as Element).closest(".preview-pane");
        const pane = panes.find((item) => item.element === element);
        if (pane) void activatePane(pane);
    });
}
// Focus entering a sandboxed figure iframe does not bubble into its parent pane.
window.addEventListener("blur", () => {
    setTimeout(() => {
        const element = document.activeElement?.closest(".preview-pane");
        const pane = panes.find((item) => item.element === element);
        if (pane) void activatePane(pane);
    }, 0);
});

const changeLanguage = async (language: string): Promise<void> => {
    if (paneBusy || language === boot.contentLanguage) return;
    paneBusy = true;
    $<HTMLSelectElement>("fm-lang").disabled = true;
    const buttons = languageMenu.querySelectorAll<HTMLButtonElement>("button");
    for (const button of buttons) button.disabled = true;
    try {
        await saveTask;
        if (!(await confirmLeave())) return;
        if (!(await openDoc(currentPath, language))) {
            setStatus(t("Failed to load pane"), true);
            return;
        }
        syncPane();
        history.replaceState(null, "", localeUrl(currentPath));
        closeLanguageMenu();
        await refreshNav();
    } finally {
        for (const button of buttons) button.disabled = false;
        $<HTMLSelectElement>("fm-lang").disabled = false;
        updateLanguageControls();
        paneBusy = false;
    }
};
const toggleTranslation = async (language: string): Promise<void> => {
    const source = boot.sourceLanguage ?? boot.defaultLang;
    if (paneBusy || language === source) return;
    const docId = boot.docId;
    const file = boot.file;
    const added = !boot.translatedLanguages?.includes(language);
    const originalPane = activePane;
    try {
        if (!added) {
            for (const pane of panes) {
                const state = pane === activePane ? boot : pane.draft?.boot;
                if (state?.docId !== docId || state.contentLanguage !== language) continue;
                await activatePane(pane);
                if (activePane !== pane) return;
                await changeLanguage(source);
                if (boot.contentLanguage !== source) return;
            }
            await activatePane(originalPane);
        }
        if (paneBusy || boot.docId !== docId) return;
        paneBusy = true;
        $<HTMLSelectElement>("fm-lang").disabled = true;
        await saveTask;
        const response = await localeFetch("/api/translation", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file, language, added }),
        });
        const result = (await response.json()) as {
            error?: string;
            translatedLanguages?: string[];
        };
        if (!response.ok) throw new Error(result.error ?? response.statusText);
        boot.translatedLanguages = result.translatedLanguages;
        for (const pane of panes) {
            if (pane.draft?.boot.docId === docId)
                pane.draft.boot.translatedLanguages = result.translatedLanguages;
        }
        updateLanguageControls();
        await refreshNav();
    } catch (error) {
        setStatus(String(error), true);
    } finally {
        $<HTMLSelectElement>("fm-lang").disabled = false;
        paneBusy = false;
    }
};
$("split-preview").addEventListener("click", () => {
    if (paneBusy) return;
    paneBusy = true;
    void (async () => {
        try {
            await saveTask;
            if (panes.length === 2) {
                const other = panes.find((pane) => pane !== activePane);
                if (
                    other?.draft?.dirty &&
                    !(await confirmDialog(
                        t("Close pane and discard its unsaved changes?"),
                        t("Discard changes"),
                        true,
                    ))
                )
                    return;
                other?.element.remove();
                panes.splice(0, panes.length, activePane);
                setDirty(dirty);
            } else {
                const response = await localeFetch(
                    `/api/page?route=${encodeURIComponent(currentPath)}`,
                );
                if (!response.ok) throw new Error(String(response.status));
                const data = (await response.json()) as PageResponse;
                capturePane();
                const element = document.createElement("section");
                element.className = "preview-pane";
                element.tabIndex = 0;
                element.append(paneActions.cloneNode(true));
                const content = document.createElement("div");
                content.className = "preview-content";
                element.append(content);
                const pane = { id: paneSequence++, element };
                panes.push(pane);
                paneHost.append(element);
                clearPreviewHi();
                activePane = pane;
                mainEl = element.querySelector(".preview-content") as HTMLElement;
                swapDoc(data, false);
                syncPane();
            }
            paneHost.classList.toggle("split", panes.length === 2);
            $("split-preview").setAttribute("aria-pressed", String(panes.length === 2));
        } catch {
            setStatus(t("Failed to load pane"), true);
        } finally {
            paneBusy = false;
        }
    })();
});

// Editor state per doc (file): history is neither discarded on switch nor shared across docs.
const docStates = new Map<string, EditorState>();

const swapDoc = (data: PageResponse, remember = true): void => {
    const prevKey = stateKey(boot);
    boot = data.boot;
    siteTitle = boot.siteTitle;
    siteIcon = boot.siteIcon;
    baseRaw = boot.baseRaw;
    applySpellcheckLang();
    rebuildCompletions();
    // Recreate the whole state (with dispatch, undo history would stay linked to the previous
    // doc, letting undo bring back another doc's content and save it). setState bypasses the
    // updateListener, so it doesn't trigger onChange (marking dirty / autosave) either.
    // A previously opened doc gets its last state (= undo history) back. If it differs from disk
    // (discarded unsaved edits / external change), replacing it with the disk content is recorded
    // as one step, so undo can go back to it too.
    if (remember) docStates.set(prevKey, view.state);
    const cached = docStates.get(stateKey(boot));
    view.setState(cached ?? EditorState.create({ doc: boot.body, extensions: editorExtensions }));
    if (cached && cached.doc.toString() !== boot.body) {
        suppressChange = true;
        view.dispatch({ changes: { from: 0, to: cached.doc.length, insert: boot.body } });
    }
    updateLanguageControls();
    applyUiLanguage();
    document.title = data.title;
    setDirty(false);
    conflictPending = false;
    setStatus("");
    renderRevision++;
    apply(
        {
            html: data.html,
            errors: data.errors,
            toc: data.toc,
            blockLines: boot.blockLines,
            filePreviews: boot.filePreviews,
            previews: boot.previews,
        },
        false,
    );
    activePane.element.scrollTop = 0;
    syncPane();
    const unsavedFiles = Object.keys(textfiles.previewFiles());
    if (unsavedFiles.length) schedulePreview(unsavedFiles);
    markValidationPending();
    validateSoon();
};

// Returns true if the swap succeeded (URL updates differ between push and pop, so they're left
// to the caller).
const openDoc = async (
    path: string,
    language = boot.contentLanguage ?? boot.defaultLang,
): Promise<boolean> => {
    const requestedBoot = boot;
    const requestedDoc = view.state.doc;
    const requestedFm = JSON.stringify(readFm());
    try {
        const res = await fetch(`/api/page?route=${encodeURIComponent(path)}`, {
            headers: { "x-docs-language": language },
        });
        if (!res.ok) {
            return false;
        }
        const data = (await res.json()) as PageResponse;
        if (
            boot !== requestedBoot ||
            view.state.doc !== requestedDoc ||
            JSON.stringify(readFm()) !== requestedFm
        )
            return false;
        swapDoc(data);
        return true;
    } catch {
        return false;
    }
};

const scrollToAnchor = (hash: string): void => {
    if (!hash) {
        activePane.element.scrollTop = 0;
        return;
    }
    let id: string;
    try {
        id = decodeURIComponent(hash.slice(1));
    } catch {
        return;
    }
    mainEl.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: "start" });
};

let navigationTask: Promise<void> | undefined;
const navigateTo = (path: string, hash = ""): Promise<void> => {
    navigationTask ??= (async () => {
        if (paneBusy) return;
        await saveTask;
        if (!(await confirmLeave())) return;
        if (await openDoc(path)) {
            history.pushState(null, "", localeUrl(currentPath + hash));
            scrollToAnchor(hash);
            return;
        }
        await leavePage(localeUrl(path + hash), true);
    })().finally(() => {
        navigationTask = undefined;
    });
    return navigationTask;
};
(window as unknown as { __docsNavigate: typeof navigateTo }).__docsNavigate = navigateTo;

const docAction = async (id: string, action: string): Promise<void> => {
    if (boot.docId !== id) {
        const link = document.querySelector<HTMLAnchorElement>(
            `#nav-groups [data-doc-id="${CSS.escape(id)}"] > .nav-row > a`,
        );
        if (!link) return;
        await navigateTo(new URL(link.href).pathname);
    }
    if (boot.docId !== id || paneBusy) return;
    if (action === "rename") startRename();
    else if (action === "delete") await deleteDoc();
};
(window as unknown as { __docsDocAction: typeof docAction }).__docsDocAction = docAction;
const initialAction = new URL(location.href).searchParams.get("doc-action");
if (initialAction) {
    history.replaceState(null, "", localeUrl(currentPath + location.hash));
    void docAction(boot.docId, initialAction);
}

// Document links stay in the editor; full navigation also checks drafts before leaving.
const isDocPath = (path: string): boolean =>
    /^\/(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\/?$/.test(path);

document.addEventListener("click", (ev) => {
    if (
        ev.defaultPrevented ||
        ev.button !== 0 ||
        ev.metaKey ||
        ev.ctrlKey ||
        ev.shiftKey ||
        ev.altKey
    ) {
        return;
    }
    const a = (ev.target as HTMLElement).closest("a");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) {
        return;
    }
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !isDocPath(url.pathname)) {
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        ev.preventDefault();
        void leavePage(url.href);
        return;
    }
    if (url.pathname === currentPath) {
        ev.preventDefault();
        const targetUrl = localeUrl(currentPath + url.hash);
        if (location.pathname + location.search + location.hash !== targetUrl) {
            history.pushState(null, "", targetUrl);
        }
        scrollToAnchor(url.hash);
        return;
    }
    ev.preventDefault();
    void navigateTo(url.pathname, url.hash);
});

// Back / forward. Going back to a non-doc page or a fetch failure falls back to normal
// navigation. When leaving is cancelled, restore the URL to the current location (so history
// never moves without the display following).
window.addEventListener("popstate", () => {
    const target = location.pathname;
    const language =
        new URL(location.href).searchParams.get("lang") ?? boot.sourceLanguage ?? boot.defaultLang;
    if (target === currentPath && language === (boot.contentLanguage ?? boot.defaultLang)) {
        scrollToAnchor(location.hash);
        return;
    }
    void (async () => {
        if (!(await confirmLeave())) {
            history.pushState(null, "", localeUrl(currentPath));
            return;
        }
        if (!(await openDoc(target, language))) {
            await leavePage(location.href, true);
        } else {
            scrollToAnchor(location.hash);
        }
    })();
});

syncPane();
if (location.hash) requestAnimationFrame(() => scrollToAnchor(location.hash));

// Initial tagging (set data-ln even when corr is off, so turning it ON later works immediately).
tagCorrespondence(boot.blockLines ?? []);
markValidationPending();
validateSoon();
