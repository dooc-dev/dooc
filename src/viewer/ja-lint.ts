// Japanese typo detection = the `ja` adapter's prose lint (language socket; attached in
// languages.ts, served via /api/lint for dooc edit). textlint is not bundled into the
// client (edit-client.ts) to avoid bloating the bundle; only offset-annotated findings are sent.
import {
    TextlintKernel,
    type TextlintKernelRule,
    type TextlintPluginCreator,
} from "@textlint/kernel";
import { moduleInterop } from "@textlint/module-interop";
import markdownPluginModule from "@textlint/textlint-plugin-markdown";
import presetJaTechnicalWriting from "textlint-rule-preset-ja-technical-writing";
import type { LintFinding } from "../core/language.js";

// moduleInterop unwraps CommonJS defaults at runtime but keeps the input type.
const markdownPlugin = moduleInterop(markdownPluginModule) as unknown as TextlintPluginCreator;

// Enable only the typo-oriented rules from textlint-rule-preset-ja-technical-writing.
// Style rules (sentence length, number of commas, consecutive kanji length, desu/masu
// consistency, etc.) are excluded (this tool is for typo highlighting, not style checking).
const TYPO_RULE_IDS = [
    "no-doubled-joshi", // duplicated particles
    "no-doubled-conjunctive-particle-ga", // repeated adversative particles
    "no-doubled-conjunction", // repeated identical conjunctions
    "no-dropping-the-ra", // ra-dropping in potential verb forms (ra-nuki kotoba)
    "no-double-negative-ja", // double negatives
    "no-nfd", // UTF8-MAC (NFD) dakuten
    "no-invalid-control-character", // stray invalid control characters
    "no-zero-width-spaces", // stray zero-width spaces (from copy-paste)
    "no-hankaku-kana", // stray half-width kana
    "ja-no-successive-word", // same word repeated (mistyping)
    "ja-no-abusage", // common Japanese misusages
    "ja-unnatural-alphabet", // unnatural alphabet letters caused by input mistakes
    "no-unmatched-pair", // unmatched brackets
] as const;

const rules: TextlintKernelRule[] = TYPO_RULE_IDS.map((ruleId) => {
    const rule = presetJaTechnicalWriting.rules[ruleId];
    if (!rule) {
        throw new Error(`textlint-rule-preset-ja-technical-writing has no rule "${ruleId}"`);
    }
    return { ruleId, rule, options: presetJaTechnicalWriting.rulesConfig[ruleId] };
});

const kernel = new TextlintKernel();

/** Lints body (md content without front matter) and returns typo findings with offsets. */
export const lintJa = async (body: string): Promise<LintFinding[]> => {
    const result = await kernel.lintText(body, {
        ext: ".md",
        plugins: [{ pluginId: "markdown", plugin: markdownPlugin }],
        rules,
    });
    return result.messages.map((m) => ({ ruleId: m.ruleId, message: m.message, range: m.range }));
};
