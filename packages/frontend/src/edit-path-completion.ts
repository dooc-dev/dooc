import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { termFileUrl } from "../../engine/src/core/term-reference.js";
import { pageWorkspace } from "../../workspace/src/client.js";

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
    return (async () => {
        const options = new Map(references.map((option) => [option.label, option]));
        try {
            // A superseded lookup is dropped below (ctx.aborted); the request itself is cheap.
            const paths = await pageWorkspace().request<string[]>("files", {
                action: "complete",
                prefix,
            });
            for (const path of paths) {
                const label = termFileUrl(path);
                if (!options.has(label))
                    options.set(label, {
                        label,
                        displayLabel: path,
                        type: path.endsWith("/") ? "namespace" : "text",
                    });
            }
        } catch {
            // Existing document and term candidates remain available while offline.
        }
        if (ctx.aborted) return null;
        return { from, options: [...options.values()] };
    })();
};
