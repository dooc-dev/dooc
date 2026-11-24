import { readdirSync, readFileSync } from "node:fs";

export const prebuilt = import.meta.url.endsWith(".js");
export const standalone = false;
export const packageVersion: string = JSON.parse(
    readFileSync(
        new URL(prebuilt ? "../../package.json" : "../../../package.json", import.meta.url),
        "utf8",
    ),
).version;

export const readInstaller = (): Buffer =>
    readFileSync(
        new URL(
            prebuilt ? "../install.sh" : "../../../scripts/release/install.sh",
            import.meta.url,
        ),
    );

export const readReaderAsset = (name: string): Buffer =>
    readFileSync(
        new URL(
            name.startsWith("fonts/")
                ? `./${name}`
                : `${prebuilt ? ".." : "../../../dist"}/${name}`,
            import.meta.url,
        ),
    );

export const readGraphAssets = (): Map<string, Buffer> =>
    new Map(
        readdirSync(new URL(`${prebuilt ? ".." : "../../../dist"}/graph/`, import.meta.url))
            .filter((name) => name.endsWith(".js"))
            .map((name) => [name, readReaderAsset(`graph/${name}`)]),
    );
