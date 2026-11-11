import { createHighlighterCore, type LanguageRegistration, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { selectCodeGrammars } from "../core/code-grammars.js";

let grammars: LanguageRegistration[] | undefined;
const loading = new Map<string, Promise<void>>();
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
export interface CodeTokenRequest {
    id: number;
    source: string;
    language: string;
    theme: string;
    grammars: LanguageRegistration[];
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
const codeGrammars = (): LanguageRegistration[] =>
    (grammars ??= JSON.parse(document.getElementById("code-grammars")?.textContent ?? "[]"));

export const codeGrammar = (language: string): LanguageRegistration | undefined =>
    codeGrammars().find((entry) => entry.name === language || entry.aliases?.includes(language));

const loadGrammars = async (language: string): Promise<void> => {
    const source = document.getElementById("code-grammars")?.dataset.src;
    if (!source || codeGrammar(language)) return;
    if (!loading.has(language)) {
        const url = new URL(source, location.href);
        url.searchParams.set("language", language);
        loading.set(
            language,
            fetch(url)
                .then(async (response) => {
                    if (!response.ok) throw new Error("Could not load code languages");
                    const loaded: LanguageRegistration[] = await response.json();
                    grammars = [
                        ...new Map(
                            [...codeGrammars(), ...loaded].map((grammar) => [
                                grammar.name,
                                grammar,
                            ]),
                        ).values(),
                    ];
                })
                .catch((error) => {
                    loading.delete(language);
                    throw error;
                }),
        );
    }
    await loading.get(language);
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
export const codeTokens = async (source: string, language: string, theme?: string) => {
    // Large sources remain plain text so tokenization cannot stall either editor or the preview.
    if (source.length > 100_000 || source.split("\n").some((line) => line.length > 10_000))
        return [];
    await loadGrammars(language);
    const grammar = codeGrammar(language);
    if (!grammar) return [];
    const input = {
        source,
        language: grammar.name,
        theme: theme ?? codeTheme(),
        grammars: selectCodeGrammars(codeGrammars(), [grammar.name]),
    };
    // Keep local viewing and editing responsive while expensive grammars are initialized.
    return typeof Worker !== "undefined" && document.getElementById("code-grammars")?.dataset.src
        ? workerTokens(input)
        : tokenizeCode(input);
};

export const tokenizeCode = async (
    input: Omit<CodeTokenRequest, "id">,
): Promise<ThemedToken[][]> => {
    highlighter ??= createHighlighterCore({
        langs: [],
        themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
        engine: createJavaScriptRegexEngine(),
    });
    const engine = await highlighter;
    if (!engine.getLoadedLanguages().includes(input.language))
        await engine.loadLanguage(...input.grammars);
    return engine.codeToTokens(input.source, {
        lang: input.language,
        theme: input.theme,
    }).tokens;
};
