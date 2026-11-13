import { readViewerAsset } from "./assets.js";

const fontName = "udev-gothic-regular.woff2";
const font = readViewerAsset(`fonts/${fontName}`);
const license = readViewerAsset("fonts/LICENSE.txt").toString("utf8").replaceAll("*/", "* /");
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
