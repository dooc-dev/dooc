import type { LanguageRegistration } from "shiki/core";
import type { Subformat } from "./subformats.js";

/** Include referenced scopes as well as declared embedded languages for custom grammars. */
export const selectCodeGrammars = (
    all: LanguageRegistration[],
    languages: Iterable<string>,
): LanguageRegistration[] => {
    const selected = new Set<LanguageRegistration>();
    const add = (entry: LanguageRegistration) => {
        if (selected.has(entry)) return;
        selected.add(entry);
        const names = new Set(entry.embeddedLangs ?? []);
        for (const match of JSON.stringify(entry).matchAll(/"include":"([^"#$][^"]*)"/g))
            names.add((match[1] ?? "").split("#")[0] ?? "");
        for (const dependency of all)
            if (names.has(dependency.name) || names.has(dependency.scopeName)) add(dependency);
    };
    for (const language of languages) {
        const grammar = all.find(
            (entry) => entry.name === language || entry.aliases?.includes(language),
        );
        if (grammar) add(grammar);
    }
    return [...selected];
};

export const subformatCodeGrammars = (
    grammars: LanguageRegistration[],
    subformats: readonly Subformat[] = [],
): LanguageRegistration[] => {
    const registered = new Set(
        grammars.flatMap((grammar) => [grammar.name, ...(grammar.aliases ?? [])]),
    );
    return grammars.map((grammar) => ({
        ...grammar,
        aliases: [
            ...(grammar.aliases ?? []),
            ...subformats
                .filter(({ format }) => format === grammar.name)
                .flatMap(({ ext }) => [`.${ext}`, ext])
                .filter((alias) => !registered.has(alias)),
        ],
    }));
};
