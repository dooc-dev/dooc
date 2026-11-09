import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { termFileUrl } from "../core/term-reference.js";

export const filePathCompletion = (
    ctx: CompletionContext,
    references: Completion[],
): Promise<CompletionResult | null> | undefined => {
    const match = ctx.matchBefore(/!?\[[^\]\n]*\]\([^()\n]*/);
    if (!match) return undefined;
    const from = match.from + match.text.lastIndexOf("(") + 1;
    const typed = ctx.state.sliceDoc(from, ctx.pos);
    if (/[:?#]/.test(typed)) return Promise.resolve(null);
    let prefix: string;
    try {
        prefix = decodeURIComponent(typed);
    } catch {
        return Promise.resolve(null);
    }
    const controller = new AbortController();
    ctx.addEventListener("abort", () => controller.abort(), { onDocChange: true });
    return (async () => {
        const options = new Map(references.map((option) => [option.label, option]));
        try {
            const response = await fetch("/api/files", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "complete", prefix }),
                signal: controller.signal,
            });
            if (response.ok) {
                const paths: string[] = await response.json();
                for (const path of paths) {
                    const label = termFileUrl(path);
                    if (!options.has(label))
                        options.set(label, {
                            label,
                            displayLabel: path,
                            type: path.endsWith("/") ? "namespace" : "text",
                        });
                }
            }
        } catch {
            // Existing document and term candidates remain available while offline.
        }
        if (ctx.aborted) return null;
        return { from, options: [...options.values()] };
    })();
};
