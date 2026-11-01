// The package ships no .d.ts (hand-written JS). Reuse the TextlintRuleModule /
// TextlintRuleOptions types re-exported by @textlint/kernel (defined in @textlint/types).
declare module "textlint-rule-preset-ja-technical-writing" {
    import type { TextlintRuleModule, TextlintRuleOptions } from "@textlint/kernel";

    const preset: {
        rules: Record<string, TextlintRuleModule>;
        rulesConfig: Record<string, TextlintRuleOptions | boolean>;
    };
    export default preset;
}
