import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { languageAliasNames, languageNames } from "@shikijs/langs";
import type { LanguageRegistration } from "shiki/core";
import { bundledLanguages } from "shiki/langs";
import { CODE_LANGS, CODE_TEMPLATES } from "../core/taxonomy.js";
import { ignoredFiles } from "./ignored-files.js";

export const CODE_LANGUAGES_DIR = ".dooc/code-languages";
const supported = new Set<string>([
    ...languageNames,
    ...languageAliasNames,
    ...Object.keys(CODE_TEMPLATES),
]);
const safeName = /^[a-z0-9][a-z0-9_-]*$/;

const parseGrammars = (value: unknown, source: string): LanguageRegistration[] => {
    const entries = Array.isArray(value) ? value : [value];
    if (!entries.length) throw new Error(`${source}: at least one TextMate grammar is required`);
    return entries.map((entry) => {
        if (
            typeof entry !== "object" ||
            entry === null ||
            typeof entry.name !== "string" ||
            !safeName.test(entry.name) ||
            typeof entry.scopeName !== "string" ||
            !entry.scopeName ||
            !Array.isArray(entry.patterns) ||
            (entry.aliases !== undefined &&
                (!Array.isArray(entry.aliases) ||
                    entry.aliases.some((alias: unknown) => typeof alias !== "string" || !alias)))
        ) {
            throw new Error(
                `${source}: each grammar needs a safe name, scopeName, patterns array and optional string aliases`,
            );
        }
        return entry as LanguageRegistration;
    });
};

const readGrammars = (file: string): LanguageRegistration[] => {
    try {
        return parseGrammars(JSON.parse(readFileSync(file, "utf8")), file);
    } catch (error) {
        throw new Error(`${file}: ${error instanceof Error ? error.message : error}`);
    }
};

export const loadCodeGrammars = async (
    names: readonly string[],
): Promise<LanguageRegistration[]> => {
    const grammars = await Promise.all(
        names.map(async (name) => {
            if (name === "graphth")
                return [
                    {
                        name,
                        scopeName: "source.graphth",
                        patterns: [
                            { match: "^\\s*#.*$", name: "comment.line.graphth" },
                            { match: "\\[[^\\[\\]\\n]*\\]", name: "variable.other.graphth" },
                            { match: "-->|->|--", name: "keyword.operator.graphth" },
                            { match: "(?<=\\s)@\\S+", name: "entity.name.tag.graphth" },
                        ],
                    },
                ] as LanguageRegistration[];
            if (name === "termth" || name === "schemath" || name === "callouth") {
                const language = name === "callouth" ? "markdown" : "yaml";
                return [
                    ...(await bundledLanguages[language]()).default,
                    {
                        name,
                        scopeName: `source.${name}`,
                        patterns: [
                            {
                                include:
                                    language === "markdown"
                                        ? "text.html.markdown"
                                        : `source.${language}`,
                            },
                        ],
                    },
                ] as LanguageRegistration[];
            }
            if (!supported.has(name)) throw new Error(`Unsupported Shiki language: ${name}`);
            return (await bundledLanguages[name as keyof typeof bundledLanguages]()).default;
        }),
    );
    return [...new Map(grammars.flat().map((grammar) => [grammar.name, grammar])).values()];
};

/** Renderer-owned registrations; Markdown content is never changed. */
export const loadCodeLanguages = async (
    root: string,
): Promise<{
    codeLanguages: string[];
    codeGrammars: LanguageRegistration[];
}> => {
    const directory = join(root, CODE_LANGUAGES_DIR);
    const files = existsSync(directory)
        ? readdirSync(directory).filter((file) => file.endsWith(".json"))
        : [];
    const ignored = ignoredFiles(
        root,
        files.map((file) => `${CODE_LANGUAGES_DIR}/${file}`),
    );
    const extra = existsSync(directory)
        ? files
              .filter((file) => !ignored.has(`${CODE_LANGUAGES_DIR}/${file}`))
              .sort()
              .flatMap((file) => readGrammars(join(directory, file)))
        : [];
    const defaults = await loadCodeGrammars(CODE_LANGS);
    return {
        codeLanguages: [...new Set([...CODE_LANGS, ...extra.map((grammar) => grammar.name)])],
        codeGrammars: [
            ...new Map([...defaults, ...extra].map((grammar) => [grammar.name, grammar])).values(),
        ],
    };
};

/** Persist a Shiki language or imported TextMate JSON under the renderer's directory. */
export const addCodeLanguage = async (root: string, input: string): Promise<string> => {
    const grammars = supported.has(input)
        ? await loadCodeGrammars([input])
        : readGrammars(resolve(input));
    const primary =
        grammars.find((grammar) => grammar.name === input || grammar.aliases?.includes(input)) ??
        grammars.at(-1);
    if (!primary || !safeName.test(primary.name)) throw new Error("Invalid code language name");
    const target = join(root, CODE_LANGUAGES_DIR, `${primary.name}.json`);
    mkdirSync(join(root, CODE_LANGUAGES_DIR), { recursive: true });
    writeFileSync(target, `${JSON.stringify(grammars, null, 2)}\n`, { flag: "wx" });
    return relative(root, target);
};
