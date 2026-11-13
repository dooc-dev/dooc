import { parseFileReference } from "./textfile.js";

export const isTermFile = (file: string): boolean => /\.termth$/i.test(file);

/** Term links are local files relative to the docs root, just like file embeds. */
export const parseTermReference = (url: string): string | undefined => {
    if (!/\.termth(?:[?#]|$)/i.test(url)) return undefined;
    const { file, range } = parseFileReference(url);
    if (
        range !== undefined ||
        /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(file) ||
        /[\\\0\r\n]/.test(file) ||
        file.split("/").includes("..")
    )
        throw new Error(
            "Term links require a relative .termth file inside the docs root, without a query or fragment",
        );
    return file
        .split("/")
        .filter((part) => part && part !== ".")
        .join("/");
};

export const termFileUrl = (file: string): string =>
    file.split("/").map(encodeURIComponent).join("/").replaceAll("(", "%28").replaceAll(")", "%29");
export const termAnchor = (id: string): string => `term-${encodeURIComponent(id)}`;
