import { type DefaultTreeAdapterTypes as Html, parseFragment } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";

type Replace = (url: string, embedded: boolean) => string;

const cssReferences = (source: string, replace: Replace): string => {
    const tree = postcss.parse(source);
    const value = (source: string, imports = false) => {
        const parsed = valueParser(source);
        parsed.walk((node) => {
            if (node.type === "function" && node.value.toLowerCase() === "url") {
                const before = valueParser.stringify(node.nodes).replace(/^(['"])(.*)\1$/, "$2");
                const next = replace(before, true);
                if (next !== before) node.nodes = valueParser(JSON.stringify(next)).nodes;
                return false;
            }
            if (node.type === "function" && /^(?:-webkit-)?image-set$/i.test(node.value))
                for (const child of node.nodes)
                    if (child.type === "string") child.value = replace(child.value, true);
        });
        const first = parsed.nodes.find((node) => node.type !== "space" && node.type !== "comment");
        if (imports && first?.type === "string") first.value = replace(first.value, true);
        return parsed.toString();
    };
    tree.walkDecls((node) => {
        node.value = value(node.value);
    });
    tree.walkAtRules((node) => {
        node.params = value(node.params, node.name.toLowerCase() === "import");
    });
    return tree.toString();
};

/** Visit real asset URLs and preserve surrounding markup, examples and scripts. */
export const assetReferences = (source: string, extension: string, replace: Replace): string => {
    if (extension === "css") return cssReferences(source, replace);
    const changes: { from: number; to: number; text: string }[] = [];
    const walk = (parent: Html.ParentNode): void => {
        for (const node of parent.childNodes) {
            if (!("tagName" in node)) continue;
            for (const attr of node.attrs) {
                let next = attr.value;
                if (
                    ["src", "poster", "background"].includes(attr.name) ||
                    (attr.name === "data" && node.tagName === "object") ||
                    ["href", "xlink:href"].includes(attr.name)
                )
                    next = replace(attr.value, !["a", "area", "base"].includes(node.tagName));
                else if (attr.name === "srcdoc")
                    next = assetReferences(attr.value, "html", replace);
                else if (attr.name === "style") next = cssReferences(attr.value, replace);
                else if (["srcset", "imagesrcset"].includes(attr.name)) {
                    let rest = attr.value;
                    next = "";
                    while (rest) {
                        const space = /^[\s,]*/.exec(rest)?.[0] ?? "";
                        next += space;
                        rest = rest.slice(space.length);
                        const token = /^\S+/.exec(rest)?.[0];
                        if (!token) break;
                        const url = token.replace(/,+$/, "");
                        next += replace(url, true) + token.slice(url.length);
                        rest = rest.slice(token.length);
                        if (!token.endsWith(",")) {
                            const descriptor = /^[^,]*,?/.exec(rest)?.[0] ?? "";
                            next += descriptor;
                            rest = rest.slice(descriptor.length);
                        }
                    }
                }
                if (next === attr.value) continue;
                const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
                const location = node.sourceCodeLocation?.attrs?.[name];
                if (!location) throw new Error(`Cannot update attribute: ${name}`);
                const raw = source.slice(location.startOffset, location.endOffset);
                const head = /^[^=]+\s*=\s*/.exec(raw)?.[0];
                if (!head) throw new Error(`Cannot update attribute: ${name}`);
                const quote = raw[head.length] === "'" ? "'" : '"';
                const escaped = next
                    .replaceAll("&", "&amp;")
                    .replaceAll("<", "&lt;")
                    .replaceAll(quote, quote === '"' ? "&quot;" : "&#39;");
                changes.push({
                    from: location.startOffset,
                    to: location.endOffset,
                    text: head + quote + escaped + quote,
                });
            }
            if (node.tagName === "style")
                for (const child of node.childNodes) {
                    if (!("value" in child)) continue;
                    const next = cssReferences(child.value, replace);
                    if (next === child.value) continue;
                    const location = child.sourceCodeLocation;
                    if (!location) throw new Error("Cannot update style content");
                    changes.push({
                        from: location.startOffset,
                        to: location.endOffset,
                        text: next,
                    });
                }
            walk("content" in node ? (node as Html.Template).content : node);
        }
    };
    walk(parseFragment(source, { sourceCodeLocationInfo: true }));
    for (const change of changes.sort((a, b) => b.from - a.from))
        source = source.slice(0, change.from) + change.text + source.slice(change.to);
    return source;
};
