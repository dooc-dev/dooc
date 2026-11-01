// Browser client for document-pkg edit (bundled by serve.ts with esbuild, served at
// /assets/edit.js). Right panel: compact front matter + CodeMirror. Insertion is done via in-editor
// autocomplete (the `/` palette and contextual completion). Toggles (autosave / correspondence
// view / fm visibility / theme) live in the header's gear hover menu. Width is adjustable by drag
// or keyboard. Input is debounced to /api/render and reflected live in the left pane (main
// content); saving (/api/save) is manual (save button / Mod-s) or via the autosave toggle.
// With "correspondence view" ON, hovering / clicking highlights main-content elements and the
// matching CM lines in both directions.
// Switching docs is client-side navigation (end of file): the sidebar keeps the initial server
// render and only the main content / panel / CM contents are swapped (so the nav scroll position
// and search query survive a switch).
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
import { history as cmHistory, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { TocEntry } from "../core/blocks.js";
import { CODE_LANGS, type CodeLang, DIRECTIVES, type Directive } from "../core/taxonomy.js";
import { schemaCompletion } from "./edit-schema-completion.js";
import type { HmrBridge } from "./hmr.js";
import { applyUiLanguage, mountUiLanguage, t } from "./i18n.js";

interface Boot {
    contentLanguage?: string;
    sourceLanguage?: string;
    file: string;
    /** Resolution key for URLs / doc: links (= file name stem; current value in the rename UI). */
    docId: string;
    body: string;
    figures: string[];
    docs: { ref: string; title: string }[];
    terms: string[];
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
    ok?: boolean;
    error?: string;
    id: string;
    updatedRefs: number;
}

/** Response of /api/delete. referencedBy is set only on 409 (without force). */
interface DeleteResponse {
    ok?: boolean;
    error?: string;
    referencedBy?: string[];
    /** Parent of the deleted doc (= navigation target; absent for a top-level doc). */
    parent?: string;
    danglingRefs?: number;
}

interface DraftFrontmatter {
    title?: string;
    tags?: string[];
    description?: string;
    lang?: string;
}

/**
 * Minimal data needed to redraw the main content and correspondence view (shared by the
 * render/save/doc responses).
 */
interface RenderSnapshot {
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
    html: string;
}

/**
 * Response of GET /api/page?route=<path> (only the parts swapped on doc switch; 404 for non-doc
 * routes).
 */
interface PageResponse extends Omit<RenderSnapshot, "blockLines"> {
    /** Browser tab title (final form assembled by the server). */
    title: string;
    file: string;
    /** Inner content of `<div class="fm">` (the front-matter fields vary with the doc's schema). */
    fm: string;
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
const updatePreview = (html: string): void => {
    const template = document.createElement("template");
    template.innerHTML = html;
    const next = template.content.querySelector("article");
    const current = mainEl.querySelector("article");
    if (!current || !next) {
        for (const block of next?.children ?? []) blockMarkup.set(block, block.outerHTML);
        mainEl.replaceChildren(template.content);
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

const updateLanguageControls = (): void => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(".language-option")) {
        button.setAttribute(
            "aria-checked",
            String(button.dataset.language === (boot.contentLanguage ?? boot.defaultLang)),
        );
    }
    const lang = $<HTMLInputElement>("fm-lang");
    lang.readOnly = boot.contentLanguage !== boot.sourceLanguage;
    applyUiLanguage();
};
updateLanguageControls();

const statusEl = $("status");
const autosaveEl = $<HTMLInputElement>("opt-autosave");

const AUTOSAVE_KEY = "docs-edit:autosave";
const CORR_KEY = "docs-edit:corr";
const FM_KEY = "docs-edit:fm";
const RESIZE_KEY = "docs-edit:panelw";

let dirty = false;
// Notification hook for HMR (the hmr.ts client script). Passes dirty so unsaved edits are not
// lost to a reload on external change, and marks our own writes (saves) with noteWrite() so they
// aren't mistaken for external changes. This bundle runs before the HMR script at the end of the
// page, so the reference is looked up each time.
const hmr = (): HmrBridge | undefined => (window as unknown as { __docsHmr?: HmrBridge }).__docsHmr;
const setDirty = (v: boolean): void => {
    dirty = v;
    hmr()?.setDirty(v || panes.some((pane) => pane !== activePane && pane.draft?.dirty));
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
// While a conflict awaits confirmation (confirm), autosave retries are paused (otherwise a
// confirm() dialog pops up on every keystroke and editing becomes impossible). Manual saves
// (button / Mod-s) are always attempted (an explicit request to confirm again).
let conflictPending = false;

const setStatus = (text: string, err = false): void => {
    statusEl.dataset.i18n = text;
    statusEl.textContent = t(text);
    statusEl.classList.toggle("err", err);
};

const readFm = (): DraftFrontmatter => ({
    title: $<HTMLInputElement>("fm-title").value,
    description: $<HTMLInputElement>("fm-description").value,
    tags: $<HTMLInputElement>("fm-tags")
        .value.split(",")
        .map((t) => t.trim())
        .filter((t) => t !== ""),
    lang: $<HTMLInputElement>("fm-lang").value,
});

// Reflect a conflict (disk frontmatter -> form). Inverse of readFm. Assigning value
// programmatically doesn't fire input events, so it doesn't trigger onChange (= marking dirty).
const applyFm = (fm: DraftFrontmatter | undefined): void => {
    $<HTMLInputElement>("fm-title").value = fm?.title ?? "";
    $<HTMLInputElement>("fm-tags").value = (fm?.tags ?? []).join(", ");
    $<HTMLInputElement>("fm-description").value = fm?.description ?? "";
    $<HTMLInputElement>("fm-lang").value = fm?.lang ?? "";
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

// ── Code fence background ────────────────────────────────────────────────
// Paint fenced/indented code blocks with line decorations in a background color matching the
// preview (`pre` in serve.ts). No mark decoration on tags.monospace: consecutive blank lines
// make lezer-markdown merge them into one CodeText node, and a mark decoration spanning it
// desyncs CM's view layer (see the tags.monospace comment below). Line decorations only add a
// class to the line's outer div without spanning content, so they avoid the same problem.
const CODE_BLOCK_NODE_NAMES = new Set(["FencedCode", "CodeBlock"]);
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

// ── Code block syntax highlighting in the preview (main content) ───────────
// Uses shiki core (fine-grained imports, JS regex engine, github-light/dark themes).
// html.ts emits only plain-text `<pre><code>` (baking shiki in on the server would make docHtml
// async and affect other consumers, so that was avoided), so coloring happens client-side by
// repainting `.codeblk` each time (initial display / innerHTML swap after render or save /
// theme switch).
let highlighterPromise: Promise<HighlighterCore> | null = null;
const getHighlighter = (): Promise<HighlighterCore> => {
    highlighterPromise ??= createHighlighterCore({
        themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
        langs: [
            import("@shikijs/langs/toml"),
            import("@shikijs/langs/typescript"),
            import("@shikijs/langs/bash"),
            import("@shikijs/langs/json"),
            import("@shikijs/langs/yaml"),
            import("@shikijs/langs/sql"),
        ],
        engine: createJavaScriptRegexEngine(),
    });
    return highlighterPromise;
};

const isDarkTheme = (): boolean => {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") {
        return true;
    }
    if (t === "light") {
        return false;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

const isCodeLang = (v: string): v is CodeLang => (CODE_LANGS as readonly string[]).includes(v);
const highlightedTheme = new WeakMap<Element, string>();

// Paint every `.codeblk` in the main <article>. A lang outside CODE_LANGS (= unspecified "text")
// stays plain, as in CodeBlock.tsx (not highlighted).
const highlightCodeBlocks = (): void => {
    const theme = isDarkTheme() ? "github-dark" : "github-light";
    for (const blk of mainEl.querySelectorAll(".codeblk")) {
        const codeEl = blk.querySelector("pre code");
        const lang = blk.querySelector(".codeblk-lang")?.textContent ?? "";
        if (!codeEl || !isCodeLang(lang)) {
            continue;
        }
        if (highlightedTheme.get(codeEl) === theme) continue;
        highlightedTheme.set(codeEl, theme);
        const code = codeEl.textContent ?? "";
        void getHighlighter().then((hl) => {
            if (!codeEl.isConnected || highlightedTheme.get(codeEl) !== theme) return;
            // Even for a lang listed in CODE_LANGS, shiki throws if the grammar isn't imported
            // (client bundle version skew); in that case leave it plain (degrade, don't break).
            let tokens: ThemedToken[][];
            try {
                tokens = hl.codeToTokens(code, { lang, theme }).tokens;
            } catch {
                return;
            }
            const nodes: Node[] = [];
            tokens.forEach((line, li) => {
                if (li > 0) {
                    nodes.push(document.createTextNode("\n"));
                }
                for (const t of line) {
                    const span = document.createElement("span");
                    if (t.color) {
                        span.style.color = t.color;
                    }
                    span.textContent = t.content;
                    nodes.push(span);
                }
            });
            codeEl.replaceChildren(...nodes);
        });
    }
};
// Repaint both when the explicit theme (data-theme, set on <html> outside the gear menu) changes
// and when the OS theme changes in "auto" mode (baked-in colors don't follow automatically, unlike
// CSS vars).
new MutationObserver(highlightCodeBlocks).observe(document.documentElement, {
    attributeFilter: ["data-theme"],
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", highlightCodeBlocks);

const runLint = async (): Promise<void> => {
    const doc = view.state.doc;
    const currentBoot = boot;
    try {
        const res = await localeFetch("/api/lint", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                body: view.state.doc.toString(),
                lang: $<HTMLInputElement>("fm-lang").value.trim() || boot.defaultLang,
            }),
        });
        if (!res.ok) {
            return;
        }
        const { findings } = (await res.json()) as { findings: LintFinding[] };
        if (view.state.doc !== doc || boot !== currentBoot) return;
        view.dispatch({ effects: setLintFindings.of(findings) });
    } catch {
        // best-effort: a lint failure doesn't block editing
    }
};

// ── Insertion autocomplete ────────────────────────────────────────────────
// `/` palette: `/` at line start / after whitespace lists templates, figures, docs and terms
// (arrows + Enter to insert).
// `:::` palette: `:` to `:::` at line start lists the custom syntax (directives); every directive
// starts with `:::`.
// Contextual completion: figure files inside `:::figure(` / `:::html(`, doc refs inside `(doc:`.
// All fully keyboard-driven.

// Map the `<...>` placeholders in samples from the vocabulary SoT (taxonomy.DIRECTIVES) to
// CodeMirror input fields (snippet fields).
const toSnippet = (sample: string): string => sample.replace(/<([^<>\n]+)>/g, "${$1}");

// Completion info panel: sample + whether a caption is allowed (so usage can be read in place).
const directiveInfo = (d: Directive): string =>
    `${d.sample}\n\n${d.caption ? "[caption] optional" : "no caption"}${d.exts ? ` / file: ${d.exts.join(", ")}` : ""}`;

const directiveLabel = (d: Directive): string => `:::${d.name}`;

// The `:::` and `/` palettes are built from the same catalog (no duplicate template declarations).
// They differ only in the inserted form: `:::` replaces the typed colons with the template (no
// surrounding newlines added); `/` can be typed mid-text, so it adds newlines around it to place
// it as a block.
const directiveOpt = (d: Directive): Completion =>
    snippetCompletion(toSnippet(d.sample), {
        label: directiveLabel(d),
        detail: d.summary,
        info: directiveInfo(d),
        type: "keyword",
        section: t("Custom syntax"),
    });
const DIRECTIVE_OPTS: Completion[] = DIRECTIVES.map(directiveOpt);

const buildSlash = (): Completion[] => {
    const o: Completion[] = [
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
    for (const d of DIRECTIVES) {
        o.push(
            snippetCompletion(`\n${toSnippet(d.sample)}\n`, {
                label: `/${d.name}`,
                detail: d.summary,
                info: directiveInfo(d),
                type: "keyword",
                section: t("Templates"),
            }),
        );
    }
    for (const l of CODE_LANGS) {
        o.push(
            snippetCompletion(`\n\`\`\`${l}\n\${code}\n\`\`\`\n`, {
                label: `/code-${l}`,
                detail: t("code fence"),
                type: "keyword",
                section: t("Templates"),
            }),
        );
    }
    for (const f of boot.figures) {
        const name = f.endsWith(".html") ? "html" : "figure";
        o.push(
            snippetCompletion(`\n:::${name}(${f})\n`, {
                label: `/${name}:${f}`,
                detail: t("figure reference"),
                type: "class",
                section: t("Figures"),
            }),
        );
    }
    for (const d of boot.docs) {
        o.push({
            label: `/doc:${d.ref}`,
            detail: d.title,
            type: "variable",
            section: t("Doc links"),
            apply: `[${d.title}](doc:${d.ref})`,
        });
    }
    for (const term of boot.terms) {
        o.push({ label: `/term:${term}`, type: "text", section: t("Terms"), apply: term });
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
    DOC_REF_OPTS = boot.docs.map((d) => ({ label: d.ref, detail: d.title, type: "variable" }));
};
rebuildCompletions();
document.addEventListener("docs:ui-language", rebuildCompletions);

// Inside code blocks (fenced/indented/inline), `/` occurs naturally (paths, JSX,
// comments, etc.), so insertion completion never fires there (otherwise Enter/Up/Down get
// captured by completion, and an accidental snippet completion makes the selection jump to a
// field position or inserts unwanted characters).
const CODE_NODE_NAMES = new Set(["FencedCode", "CodeBlock", "InlineCode"]);
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

// Directives can only be written at block positions (line start, preceded only by whitespace).
const atLineStart = (state: EditorState, from: number): boolean =>
    /^\s*$/.test(state.sliceDoc(state.doc.lineAt(from).from, from));

// Whether pos is inside an unclosed container directive (`:::name` ... `:::`). Directives can't
// be nested there, and if the palette opens when typing the closing `:::`, Enter misfires
// (inserting a template instead of a newline), so no candidates are offered in that case. The
// dialect has no nesting, so alternating open/close is enough.
const insideContainer = (state: EditorState, pos: number): boolean => {
    const current = state.doc.lineAt(pos).number;
    let open = false;
    for (let i = 1; i < current; i++) {
        const text = state.doc.line(i).text;
        // `:::figure(...)` / `:::html(...)` are single lines with no close, so don't count them.
        if (text.startsWith(":::") && !/^:::(figure|html)\(/.test(text)) {
            open = text.slice(3).trim() !== "";
        }
    }
    return open;
};

const docsComplete = (ctx: CompletionContext): CompletionResult | null => {
    const schema = schemaCompletion(ctx);
    if (schema !== undefined) return schema;
    if (inCodeContext(ctx)) {
        return null;
    }
    // `:::figure(` takes a figure file, `:::html(` an .html file.
    const figM = ctx.matchBefore(/:::(figure|html)\([\w.-]*/);
    if (figM && atLineStart(ctx.state, figM.from)) {
        const html = figM.text.startsWith(":::html(");
        const options = FIG_OPTS.filter((o) => o.label.endsWith(".html") === html);
        return { from: figM.from + figM.text.indexOf("(") + 1, options, validFor: /[\w.-]*/ };
    }
    const docM = ctx.matchBefore(/\(doc:[\w/-]*/);
    if (docM) {
        return { from: docM.from + 5, options: DOC_REF_OPTS, validFor: /[\w/-]*/ };
    }
    // `:` to `:::` = list of custom syntax (directives). The typed colons are replaced with the
    // template. No validFor (the candidate set itself depends on the colon count, so re-query on
    // every keystroke).
    const dirM = ctx.matchBefore(/:{1,3}[\w-]*/);
    if (dirM && atLineStart(ctx.state, dirM.from)) {
        // Offer nothing at a `:::` that closes a container (and don't fall through to the
        // explicit fallback below either, so Enter isn't captured by the palette to insert a
        // template).
        if (insideContainer(ctx.state, dirM.from)) {
            return null;
        }
        return { from: dirM.from, options: DIRECTIVE_OPTS };
    }
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
const MONO_FONT = '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';
const theme = EditorView.theme({
    "&": {
        backgroundColor: "transparent",
        color: "var(--doc-fg-2)",
        fontSize: "12.5px",
        height: "100%",
    },
    ".cm-content": {
        fontFamily: MONO_FONT,
        caretColor: "var(--doc-fg)",
        // The last line sticks to the bottom edge and is hard to read, so reserve 20 blank
        // lines of bottom padding to let it scroll up to a comfortable position.
        paddingBottom: "20lh",
    },
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
        indentWithTab,
    ]),
    basicSetup,
    // Merged with basicSetup's history (minDepth 100) and the deeper one wins: undo as far back
    // as possible.
    cmHistory({ minDepth: 10_000 }),
    markdown({ base: markdownLanguage }),
    autocompletion({ override: [docsComplete] }),
    EditorView.lineWrapping,
    theme,
    syntaxHighlighting(mdHighlight),
    corrField,
    lintField,
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
            const lineBefore = u.state.sliceDoc(u.state.doc.lineAt(head).from, head);
            // For `:`, open only on `:` to `:::` at line start (= where a directive can go). A
            // palette popping up on mid-text colons (e.g. "Example:") would get in the way of typing.
            if (
                typed === "/" ||
                (typed === ":" && /^\s*:{1,3}$/.test(lineBefore)) ||
                (/^[:(| ]$/.test(typed) &&
                    schemaCompletion(new CompletionContext(u.state, head, false)) != null)
            ) {
                setTimeout(() => startCompletion(view), 0);
            }
        } else if (u.selectionSet) {
            highlightPreviewForCursor();
        }
    }),
];

const view = new EditorView({
    state: EditorState.create({ doc: boot.body, extensions: editorExtensions }),
    parent: $("cm"),
});

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
        }),
    });
    if (!res.ok) {
        throw new Error(`${res.status} ${await res.text()}`);
    }
    return (await res.json()) as DraftResponse;
};

// Keep the active page, its live title and the ancestor breadcrumb in sync.
const updateNavLocation = (): void => {
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
    // Reflect the right panel's title input live in the nav label too (empty -> id, like the
    // server's docDisplayName).
    const label = cur?.querySelector(".nav-label");
    if (cur && label) {
        label.textContent = $<HTMLInputElement>("fm-title").value.trim() || boot.docId;
        cur.setAttribute("title", label.textContent);
    }
    // Keep the breadcrumb ("ancestors › doc", same as page()'s server render) in sync too.
    const names: string[] = [];
    for (
        let it = item.parentElement?.closest(".nav-item");
        it;
        it = it.parentElement?.closest(".nav-item")
    ) {
        it.classList.add("open");
        names.unshift(it.querySelector(":scope > .nav-row > a")?.textContent ?? "");
    }
    const crumbAud = document.getElementById("crumb-aud");
    const crumbDoc = document.getElementById("crumb-doc");
    if (crumbAud) crumbAud.textContent = names.join(" › ");
    if (crumbDoc) crumbDoc.textContent = cur?.textContent ?? "";
};

const apply = (r: RenderSnapshot): void => {
    updatePreview(r.html);
    tagCorrespondence(r.blockLines ?? []);
    highlightPreviewForCursor();
    highlightCodeBlocks();
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
    setStatus(message, true);
};

// Branch for when disk differed right before saving (= rewritten externally first). Neither
// reflect nor discard silently; let the user choose via confirm(): reflect (= disk wins, our
// unsaved edits are discarded) or keep (= skip this save and keep our edits as-is; baseRaw is not
// updated, so later save attempts keep detecting the same conflict and never overwrite
// unknowingly).
const handleConflict = (r: DraftResponse): void => {
    const applyExternal = window.confirm(t("External conflict"));
    if (applyExternal) {
        reflectExternal(r, "Applied external changes (your unsaved changes were discarded)");
        conflictPending = false;
        return;
    }
    conflictPending = true;
    setStatus("Changed externally — keeping your changes (you'll be asked again on save)", true);
};

const render = async (): Promise<void> => {
    const doc = view.state.doc;
    const currentBoot = boot;
    const fm = JSON.stringify(readFm());
    try {
        const result = await post("/api/render");
        if (view.state.doc !== doc || boot !== currentBoot || JSON.stringify(readFm()) !== fm)
            return;
        apply(result);
    } catch (e) {
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

// Replace the nav (`#nav-groups`) with the current list on disk and re-apply any search query
// (`window.__docsNavFilter` is exposed by serve.ts's nav search script).
const refreshNav = async (): Promise<void> => {
    const requestedBoot = boot;
    try {
        const res = await localeFetch(`/api/nav?current=${encodeURIComponent(boot.docId)}`);
        if (!res.ok) {
            return;
        }
        const { html } = (await res.json()) as NavResponse;
        if (boot !== requestedBoot) return;
        const navGroups = document.getElementById("nav-groups");
        if (navGroups) {
            navGroups.innerHTML = html;
        }
        (window as unknown as { __docsNavFilter?: () => void }).__docsNavFilter?.();
        applyUiLanguage();
    } catch {
        // best-effort: picked up again on the next change
    }
};

// Hook for reordering (serve.ts's nav DnD script) to re-fetch when a save failed (= the list
// diverged from disk). Shares this implementation instead of duplicating the nav refresh there.
(window as unknown as { __docsRefreshNav?: () => Promise<void> }).__docsRefreshNav = refreshNav;

// Files pushed by the watcher are repo-root relative (hmr.ts WATCH_DIRS = content/figures/src),
// while boot.file is `<id>.md` like the save API, so prefix content/ to compare
// (recomputed each time since boot is replaced on doc switch).
const ownWatchPath = (): string => `content/${boot.file}`;

const handleContentChange = async (files: string[]): Promise<void> => {
    if (files.includes(ownWatchPath()) || files.includes(`locales/${boot.contentLanguage}.json`)) {
        // Don't overwrite with disk while there are unsaved changes (left to conflict detection
        // on save).
        if (dirty) {
            if (!conflictPending) {
                setStatus("Updated externally (keeping unsaved changes)", true);
            }
            return;
        }
        try {
            const res = await localeFetch(`/api/doc?file=${encodeURIComponent(boot.file)}`);
            if (!res.ok) {
                setStatus(
                    t("Failed to apply external changes: {error}", { error: res.status }),
                    true,
                );
                return;
            }
            reflectExternal((await res.json()) as DocResponse, "Applied external changes");
        } catch (e) {
            setStatus(t("Failed to apply external changes: {error}", { error: String(e) }), true);
        }
        return;
    }
    // Other docs / figures / manifest.yaml: reflect changes to figures, doc: links and the
    // dictionary in the main content using the current edits, and swap the nav (list, order).
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
// adds noteWrite/setDirty, so create the object here if missing and let that script merge into
// it later (hmr.ts also adds via Object.assign instead of overwriting, so order doesn't matter).
(window as unknown as { __docsHmr?: HmrBridge }).__docsHmr = {
    ...(hmr() ?? ({} as HmrBridge)),
    onContent: (files: string[]) => {
        pendingContentFiles.push(...files);
        flushContent();
    },
};

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
    try {
        // Mark both before and after the write (the watcher's notification can arrive before
        // the response).
        hmr()?.noteWrite();
        const r = await post("/api/save");
        hmr()?.noteWrite();
        if (boot !== savingBoot) return;
        if (r.conflict) {
            handleConflict(r);
            return;
        }
        baseRaw = r.raw;
        if (view.state.doc !== savingDoc || JSON.stringify(readFm()) !== savingFm) return;
        apply(r);
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
        setStatus(t("Failed to save: {error}", { error: String(e) }), true);
    }
};

const refresh = debounce(150, () => void render());
const autosave = debounce(1000, () => {
    if (dirty && autosaveEl.checked && !conflictPending) {
        void save();
    }
});
const lintSoon = debounce(600, () => void runLint());
const onChange = (): void => {
    setDirty(true);
    setStatus(autosaveEl.checked ? "Modified (waiting for auto-save)" : "Unsaved changes");
    refresh();
    autosave();
    lintSoon();
};

// ── Correspondence view tagging / highlighting ───────────────────────────
// Zip the direct children of the main <article> with blockLines in block order (excluding the
// leading front-matter elements = errors / h1 / fullname / lead). Full-listing blocks for figures
// or the dictionary occasionally expand 1:N and shift everything after, but highlighting is
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
        (el) => !el.matches(".errors, h1, .fullname, .lead"),
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

// ── fm inputs / save button ───────────────────────────────────────────────
// The input fields are replaced wholesale on doc switch, so bind once on the container (.fm)
// instead of on each field (input events bubble up to the container).
const fmBox = document.querySelector(".fm") as HTMLElement;
fmBox.addEventListener("input", onChange);
$("save").addEventListener("click", () => void save());

// ── Changing the doc id (edit the file name in the header in place) ───────
// The id is the resolution key for the file name (content/<id>.md) / URL / doc: links. Changing
// it makes the server rewrite doc: links from other docs to follow. No dialog: the header's file
// name turns into an input. Enter = confirm / Esc or blur = cancel; an invalid id turns the
// field red and is reported in the status.
const DOC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const FLASH_KEY = "docs:flash";
const startRename = (): void => {
    const pfile = $("pfile");
    if ($("phead").classList.contains("renaming")) {
        return;
    }
    const name = pfile.querySelector("span");
    const input = document.createElement("input");
    input.id = "pfile-input";
    input.value = boot.docId;
    input.spellcheck = false;
    input.setAttribute("aria-label", "doc id (file name)");
    const ext = document.createElement("em");
    ext.textContent = ".md";
    name?.replaceWith(input, ext);
    $("phead").classList.add("renaming");
    setStatus("Enter to rename / Esc to cancel (doc: links follow)");
    input.select();
    let busy = false;
    const end = (): void => {
        const span = document.createElement("span");
        span.textContent = boot.file;
        input.replaceWith(span);
        ext.remove();
        $("phead").classList.remove("renaming");
        setStatus("");
    };
    input.addEventListener("input", () => {
        const ok = DOC_ID_RE.test(input.value.trim());
        input.classList.toggle("invalid", !ok);
        setStatus(
            ok ? "Enter to rename / Esc to cancel (doc: links follow)" : "only a-z, 0-9 and -",
            !ok,
        );
    });
    input.addEventListener("blur", () => {
        if (!busy) end();
    });
    input.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
            ev.preventDefault();
            input.blur();
            return;
        }
        if (ev.key !== "Enter") {
            return;
        }
        ev.preventDefault();
        const next = input.value.trim();
        if (next === boot.docId) {
            input.blur();
            return;
        }
        if (!DOC_ID_RE.test(next)) {
            return;
        }
        busy = true;
        void (async () => {
            try {
                // Save unsaved changes first (so they aren't lost on the reload after renaming).
                if (dirty) {
                    await save();
                }
                hmr()?.noteWrite();
                const res = await localeFetch("/api/rename", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ file: boot.file, newId: next }),
                });
                const data = (await res.json()) as RenameResponse;
                if (!res.ok || !data.ok) {
                    throw new Error(data.error ?? String(res.status));
                }
                sessionStorage.setItem(
                    FLASH_KEY,
                    data.updatedRefs > 0
                        ? t("Renamed to {id}.md ({count} links updated)", {
                              id: data.id,
                              count: data.updatedRefs,
                          })
                        : t("Renamed to {id}.md", { id: data.id }),
                );
                window.location.href = localeUrl(`/${data.id}`);
            } catch (e) {
                busy = false;
                input.classList.add("invalid");
                setStatus(
                    t("Can't rename: {error}", {
                        error: e instanceof Error ? e.message : String(e),
                    }),
                    true,
                );
                input.focus();
            }
        })();
    });
};
$("rename").addEventListener("click", startRename);
$("pfile").addEventListener("dblclick", startRename);
// Show the result stored before the rename (= reload) exactly once.
{
    const flash = sessionStorage.getItem(FLASH_KEY);
    if (flash) {
        sessionStorage.removeItem(FLASH_KEY);
        setStatus(flash);
    }
}

// ── Adding figures (file picker / drop onto the editor) ──────────────────────
// Write to figures/ (POST /api/figure) and insert :::figure(<file>). Figures are site-wide, so
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
    const data = (await res.json()) as { file?: string; error?: string };
    if (!res.ok || !data.file) {
        throw new Error(data.error ?? String(res.status));
    }
    if (!boot.figures.includes(data.file)) {
        boot.figures.push(data.file);
        rebuildCompletions();
    }
    return data.file;
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
        const block = names.map((n) => `:::figure(${n})`).join("\n\n");
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
// ── Doc icon (left of the file name in the header, 1:1 dotted frame) ─────────
// svg only. The server pads it to 1:1 and writes icons/<id>.svg. It shows in the sidebar row,
// so the nav is re-fetched.
const iconSlot = $("docicon");
const iconInput = $<HTMLInputElement>("iconfile");
const showIcon = (uri: string | null): void => {
    iconSlot.classList.toggle("has", uri != null);
    iconSlot.querySelector("img")?.remove();
    if (uri != null) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = uri;
        iconSlot.prepend(img);
    }
};
const setIcon = async (file: File | null): Promise<void> => {
    if (file && !/\.svg$/i.test(file.name) && file.type !== "image/svg+xml") {
        setStatus("Icon must be svg", true);
        return;
    }
    try {
        hmr()?.noteWrite();
        const res = await localeFetch("/api/icon", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file: boot.file, data: file ? await readBase64(file) : null }),
        });
        const data = (await res.json()) as { icon?: string | null; error?: string };
        if (!res.ok) {
            throw new Error(data.error ?? String(res.status));
        }
        boot.icon = data.icon ?? null;
        showIcon(boot.icon);
        setStatus(boot.icon ? "Icon set (auto-padded to 1:1)" : "Icon removed");
        await refreshNav();
    } catch (e) {
        setStatus(
            t("Failed to set icon: {error}", { error: e instanceof Error ? e.message : String(e) }),
            true,
        );
    }
};
iconInput.addEventListener("change", () => {
    const f = iconInput.files?.[0];
    iconInput.value = "";
    if (f) void setIcon(f);
});
$("docicon-clear").addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void setIcon(null);
});
iconSlot.addEventListener("dragover", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    iconSlot.classList.add("over");
});
iconSlot.addEventListener("dragleave", () => iconSlot.classList.remove("over"));
iconSlot.addEventListener("drop", (ev) => {
    iconSlot.classList.remove("over");
    const f = ev.dataTransfer?.files[0];
    if (!f) return;
    ev.preventDefault();
    void setIcon(f);
});
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
// /api/delete after confirm(). If other docs reference it via doc: links, 409 + referencedBy is
// returned; show the list, re-confirm deletion anyway, then resend with force.
const deleteDoc = async (): Promise<void> => {
    if (!window.confirm(t('Delete "{file}"? (this cannot be undone)', { file: boot.file }))) {
        return;
    }
    const attempt = async (force: boolean): Promise<void> => {
        hmr()?.noteWrite();
        const res = await localeFetch("/api/delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file: boot.file, force }),
        });
        const data = (await res.json()) as DeleteResponse;
        if (res.status === 409 && data.referencedBy && !force) {
            const list = data.referencedBy.join("\n");
            if (window.confirm(t("Referenced documents: {list}", { list }))) {
                await attempt(true);
            }
            return;
        }
        if (!res.ok || !data.ok) {
            window.alert(t("Failed to delete: {error}", { error: data.error ?? res.status }));
            return;
        }
        window.location.href = localeUrl(`/${data.parent ?? ""}`);
    };
    try {
        await attempt(false);
    } catch (e) {
        window.alert(t("Failed to delete: {error}", { error: String(e) }));
    }
};
$("delete").addEventListener("click", () => void deleteDoc());

// ── Gear hover menu toggles (persisted in localStorage) ────────────────────
autosaveEl.checked = localStorage.getItem(AUTOSAVE_KEY) === "1";
autosaveEl.addEventListener("change", () => {
    localStorage.setItem(AUTOSAVE_KEY, autosaveEl.checked ? "1" : "0");
    if (autosaveEl.checked && dirty) {
        void save();
    }
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
bindToggle("opt-fm", FM_KEY, true, (v) => {
    $("panel").classList.toggle("hide-fm", !v);
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

// ── Panel width resize (drag / double-click for default / Ctrl+Alt+←→) ─────
const panel = $("panel");
const handle = $("resize");
const clampW = (w: number): number => Math.min(Math.max(w, 320), window.innerWidth - 360);
const setPanelW = (w: number, persist: boolean): void => {
    const c = clampW(w);
    panel.style.width = `${c}px`;
    if (persist) {
        localStorage.setItem(RESIZE_KEY, String(c));
    }
};
const savedW = localStorage.getItem(RESIZE_KEY);
if (savedW != null) {
    setPanelW(Number(savedW), false);
}
let dragging = false;
handle.addEventListener("mousedown", (ev) => {
    dragging = true;
    handle.classList.add("drag");
    ev.preventDefault();
});
window.addEventListener("mousemove", (ev) => {
    if (dragging) {
        setPanelW(window.innerWidth - ev.clientX, false);
    }
});
window.addEventListener("mouseup", () => {
    if (!dragging) {
        return;
    }
    dragging = false;
    handle.classList.remove("drag");
    localStorage.setItem(RESIZE_KEY, String(Math.round(panel.getBoundingClientRect().width)));
});
handle.addEventListener("dblclick", () => {
    panel.style.width = "";
    localStorage.removeItem(RESIZE_KEY);
});
window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || !ev.altKey) {
        return;
    }
    if (ev.key === "ArrowLeft") {
        setPanelW(panel.getBoundingClientRect().width + 40, true);
        ev.preventDefault();
    } else if (ev.key === "ArrowRight") {
        setPanelW(panel.getBoundingClientRect().width - 40, true);
        ev.preventDefault();
    }
});

window.addEventListener("beforeunload", (ev) => {
    if (dirty || panes.some((pane) => pane !== activePane && pane.draft?.dirty)) {
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
const confirmLeave = async (): Promise<boolean> => {
    if (!dirty) {
        return true;
    }
    if (autosaveEl.checked && !conflictPending) {
        await save();
        if (!dirty) {
            return true;
        }
    }
    return window.confirm(t("You have unsaved changes. Discard them and leave?"));
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
    fmHtml: string;
    baseRaw: string;
    dirty: boolean;
    conflictPending: boolean;
    blockLines: number[];
    title: string;
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
        fmHtml: fmBox.innerHTML,
        baseRaw,
        dirty,
        conflictPending,
        blockLines: lastBlockLines,
        title: document.title,
    };
};
const syncPane = (): void => {
    activePane.element.dataset.language = boot.contentLanguage ?? boot.defaultLang;
    currentPath = `/${boot.docId}`;
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
    boot = draft.boot;
    baseRaw = draft.baseRaw;
    conflictPending = draft.conflictPending;
    suppressChange = false;
    view.setState(draft.state);
    fmBox.innerHTML = draft.fmHtml;
    applyFm(draft.fm);
    document.title = draft.title;
    const fileLabel = $("pfile").querySelector("span");
    if (fileLabel) fileLabel.textContent = boot.file;
    $("pfile").title = boot.file;
    showIcon(boot.icon);
    applySpellcheckLang();
    rebuildCompletions();
    setDirty(draft.dirty);
    setStatus(dirty ? "Unsaved changes" : "");
    tagCorrespondence(draft.blockLines);
    syncPane();
    highlightCodeBlocks();
    void runLint();
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
            const response = await fetch(
                `/api/page?route=${encodeURIComponent(`/${draft.boot.docId}`)}`,
                {
                    headers: {
                        "x-docs-language": draft.boot.contentLanguage ?? draft.boot.defaultLang,
                    },
                },
            );
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
                    !window.confirm(t("Close pane and discard its unsaved changes?"))
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
    fmBox.innerHTML = data.fm;
    updateLanguageControls();
    applyUiLanguage();
    const pfile = $("pfile");
    const pname = pfile.querySelector("span");
    if (pname) pname.textContent = data.file;
    pfile.title = data.file;
    showIcon(data.boot.icon ?? null);
    document.title = data.title;
    setDirty(false);
    conflictPending = false;
    setStatus("");
    apply({ html: data.html, errors: data.errors, toc: data.toc, blockLines: boot.blockLines });
    activePane.element.scrollTop = 0;
    syncPane();
    void runLint();
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
        currentPath = path;
        return true;
    } catch {
        return false;
    }
};

const navigateTo = async (path: string): Promise<void> => {
    if (paneBusy) return;
    await saveTask;
    if (!(await confirmLeave())) {
        return;
    }
    if (await openDoc(path)) {
        history.pushState(null, "", localeUrl(path));
        return;
    }
    window.location.href = localeUrl(path);
};

// Only intercept links to doc routes (`/<docId>`). External links / modified clicks are left
// alone.
const isDocPath = (path: string): boolean => /^\/[a-z0-9][a-z0-9-]*\/?$/.test(path);

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
    if (url.origin !== location.origin) {
        return;
    }
    if (url.pathname === currentPath) {
        // The currently open doc: let heading TOC links (hash) work as usual, and don't reload
        // for hash-less links (the nav's current-location link).
        ev.preventDefault();
        if (url.hash) {
            const target = mainEl.querySelector(
                `#${CSS.escape(decodeURIComponent(url.hash.slice(1)))}`,
            );
            target?.scrollIntoView({ block: "start" });
        }
        return;
    }
    if (!isDocPath(url.pathname)) {
        return;
    }
    ev.preventDefault();
    void navigateTo(url.pathname);
});

// Back / forward. Going back to a non-doc page or a fetch failure falls back to normal
// navigation. When leaving is cancelled, restore the URL to the current location (so history
// never moves without the display following).
window.addEventListener("popstate", () => {
    const target = location.pathname;
    const language =
        new URL(location.href).searchParams.get("lang") ?? boot.sourceLanguage ?? boot.defaultLang;
    if (target === currentPath && language === boot.contentLanguage) {
        return;
    }
    void (async () => {
        if (!(await confirmLeave())) {
            history.pushState(null, "", localeUrl(currentPath));
            return;
        }
        if (!(await openDoc(target, language))) {
            window.location.reload();
        }
    })();
});

syncPane();

// Initial tagging (set data-ln even when corr is off, so turning it ON later works immediately).
tagCorrespondence(boot.blockLines ?? []);
void runLint();
// Initial display (server-rendered and not via apply(), so paint once explicitly).
highlightCodeBlocks();
