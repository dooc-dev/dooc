import { createHighlighterCore, type LanguageRegistration, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { selectCodeGrammars } from "../../engine/src/core/code-grammars.js";
import { workspaceFetch, workspaceId } from "../../workspace/src/connection.js";

const initialWorkspace = workspaceId();
const grammars = new Map<string, LanguageRegistration[]>();
const loading = new Map<string, Promise<void>>();
const highlighters = new Map<string, ReturnType<typeof createHighlighterCore>>();
export interface CodeTokenRequest {
    id: number;
    source: string;
    language: string;
    theme: string;
    grammars: LanguageRegistration[];
    workspace?: string;
}
export interface CodeTokenResponse {
    id: number;
    tokens?: ThemedToken[][];
    error?: string;
}
let worker: Worker | undefined;
let workerError: Error | undefined;
let nextRequest = 0;
const pending = new Map<
    number,
    { resolve: (tokens: ThemedToken[][]) => void; reject: (error: Error) => void }
>();

const workerTokens = (input: Omit<CodeTokenRequest, "id">): Promise<ThemedToken[][]> => {
    if (workerError) return Promise.reject(workerError);
    if (!worker) {
        worker = new Worker("/assets/code-worker.js");
        worker.onmessage = ({ data }: MessageEvent<CodeTokenResponse>) => {
            const request = pending.get(data.id);
            pending.delete(data.id);
            if (data.error) request?.reject(new Error(data.error));
            else request?.resolve(data.tokens ?? []);
        };
        worker.onerror = () => {
            workerError = new Error("Could not highlight code");
            for (const request of pending.values()) request.reject(workerError);
            pending.clear();
            worker?.terminate();
        };
    }
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
            worker?.postMessage({ ...input, id });
        } catch (error) {
            pending.delete(id);
            reject(error);
        }
    });
};
// shortcut: Aliases refresh on page reload; refresh in place if live subformat registration is needed.
const codeGrammars = (workspace: string): LanguageRegistration[] => {
    let value = grammars.get(workspace);
    if (!value) {
        value =
            workspace === initialWorkspace
                ? (JSON.parse(
                      document.getElementById("code-grammars")?.textContent ?? "[]",
                  ) as LanguageRegistration[])
                : [];
        grammars.set(workspace, value);
    }
    return value;
};

export const codeGrammar = (
    language: string,
    workspace = workspaceId(),
): LanguageRegistration | undefined =>
    codeGrammars(workspace).find(
        (entry) => entry.name === language || entry.aliases?.includes(language),
    );

const loadGrammars = async (language: string, workspace: string): Promise<void> => {
    const source = document.getElementById("code-grammars")?.dataset.src;
    if (!source || codeGrammar(language, workspace)) return;
    const key = JSON.stringify([workspace, language]);
    if (!loading.has(key)) {
        const url = new URL(source, location.href);
        url.searchParams.set("language", language);
        loading.set(
            key,
            workspaceFetch(url, undefined, workspace)
                .then(async (response) => {
                    if (!response.ok) throw new Error("Could not load code languages");
                    const loaded: LanguageRegistration[] = await response.json();
                    grammars.set(workspace, [
                        ...new Map(
                            [...codeGrammars(workspace), ...loaded].map((grammar) => [
                                grammar.name,
                                grammar,
                            ]),
                        ).values(),
                    ]);
                })
                .catch((error) => {
                    loading.delete(key);
                    throw error;
                }),
        );
    }
    await loading.get(key);
};

export const codeTheme = (element?: Element): string => {
    const choice = element?.closest("#panel")
        ? document.documentElement.dataset.editorTheme
        : (element?.closest<HTMLElement>("[data-theme]")?.dataset.theme ??
          document.documentElement.dataset.theme);
    return choice === "dark" ||
        ((!choice || choice === "auto") && matchMedia("(prefers-color-scheme: dark)").matches)
        ? "github-dark"
        : "github-light";
};

/** Preview and both editors use the same registered grammars and colors. */
export const codeTokens = async (
    source: string,
    language: string,
    theme?: string,
    workspace = workspaceId(),
) => {
    // Large sources remain plain text so tokenization cannot stall either editor or the preview.
    if (source.length > 100_000 || source.split("\n").some((line) => line.length > 10_000))
        return [];
    await loadGrammars(language, workspace);
    const grammar = codeGrammar(language, workspace);
    if (!grammar) return [];
    const input = {
        source,
        language: grammar.name,
        theme: theme ?? codeTheme(),
        grammars: selectCodeGrammars(codeGrammars(workspace), [grammar.name]),
        workspace,
    };
    // Keep local viewing and editing responsive while expensive grammars are initialized.
    return typeof Worker !== "undefined" && document.getElementById("code-grammars")?.dataset.src
        ? workerTokens(input)
        : tokenizeCode(input);
};

export const tokenizeCode = async (
    input: Omit<CodeTokenRequest, "id">,
): Promise<ThemedToken[][]> => {
    const key = input.workspace ?? "local";
    let highlighter = highlighters.get(key);
    if (!highlighter) {
        highlighter = createHighlighterCore({
            langs: [],
            themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
            engine: createJavaScriptRegexEngine(),
        });
        highlighters.set(key, highlighter);
    }
    const engine = await highlighter;
    if (!engine.getLoadedLanguages().includes(input.language))
        await engine.loadLanguage(...input.grammars);
    return engine.codeToTokens(input.source, {
        lang: input.language,
        theme: input.theme,
    }).tokens;
};
