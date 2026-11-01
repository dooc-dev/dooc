import { readFileSync } from "node:fs";

const fontName = "udev-gothic-regular.woff2";
const font = readFileSync(new URL(`./fonts/${fontName}`, import.meta.url));
const license = readFileSync(new URL("./fonts/LICENSE.txt", import.meta.url), "utf8").replaceAll(
    "*/",
    "* /",
);
const face = (url: string): string =>
    `@font-face { font-family:'UDEV Gothic'; font-style:normal; font-weight:400; font-display:swap; src:url(${url}) format('woff2'); }`;
let embedded: string | undefined;

export const readFont = (name: string): Buffer | undefined =>
    name === fontName ? font : undefined;

export function fontCss(inline: boolean): string {
    if (!inline) return face(`/assets/fonts/${fontName}`);
    embedded ??= `/* ${license} */\n${face(`data:font/woff2;base64,${font.toString("base64")}`)}`;
    return embedded;
}
