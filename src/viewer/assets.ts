import { readFileSync } from "node:fs";

export const prebuilt = import.meta.url.endsWith(".js");

export const readViewerAsset = (name: string): Buffer =>
    readFileSync(
        new URL(name.startsWith("fonts/") ? `./${name}` : `../../dist/${name}`, import.meta.url),
    );
