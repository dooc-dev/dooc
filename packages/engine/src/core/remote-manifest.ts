import { localFile } from "./files.js";

export interface RemoteManifest {
    repository: string;
    ref: string;
    path: string;
}

/** GitHub file links and explicit Git references identify the same document source. */
export const remoteManifestSource = (source: string): RemoteManifest => {
    const url = new URL(source);
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !url.hostname.includes(".") ||
        /^(?:[\d.]+|\[.*\])$/.test(url.hostname) ||
        /(?:^|\.)(?:local|localhost)$/.test(url.hostname)
    )
        throw new Error("Remote manifests require an HTTPS Git URL without credentials");
    let repository: string;
    let ref: string;
    let path: string;
    if (url.pathname.endsWith(".git")) {
        const match = /^#([^:]+):(.+)$/.exec(url.hash);
        ref = decodeURIComponent(match?.[1] ?? "");
        path = decodeURIComponent(match?.[2] ?? "");
        url.hash = "";
        if (url.search) throw new Error("Git repository URLs cannot contain query parameters");
        repository = url.href;
    } else {
        const parts = url.pathname.split("/").filter(Boolean);
        if (url.hostname === "github.com" && parts[2] === "blob") parts.splice(2, 1);
        else if (url.hostname !== "raw.githubusercontent.com")
            throw new Error("Use a GitHub file URL or https://host/repo.git#ref:path/dooc.yaml");
        const [owner, repo] = parts;
        if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
            throw new Error("Invalid GitHub repository");
        repository = `https://github.com/${owner}/${repo}.git`;
        const qualified = parts[2] === "refs" && ["heads", "tags"].includes(parts[3] ?? "");
        ref = qualified ? parts.slice(2, 5).join("/") : (parts[2] ?? "");
        ref = decodeURIComponent(ref);
        path = parts
            .slice(qualified ? 5 : 3)
            .map(decodeURIComponent)
            .join("/");
    }
    if (
        !ref ||
        ref.startsWith("-") ||
        /[\s\0~^:?*[\\]/.test(ref) ||
        ref.includes("..") ||
        ref.includes("@{") ||
        !localFile(path) ||
        !/^(?:[^/]+\.)?dooc\.yaml$/.test(path.split("/").at(-1) ?? "")
    )
        throw new Error("Use a Git reference and a relative dooc.yaml path");
    return { repository, ref, path };
};

export const isRemoteManifest = (source: string): boolean => {
    if (!/^https?:\/\//i.test(source)) return false;
    const url = new URL(source);
    const path = url.pathname.endsWith(".git")
        ? url.hash.split(":").slice(1).join(":")
        : url.pathname;
    return /^(?:[^/]+\.)?dooc\.yaml$/.test(decodeURIComponent(path.split("/").at(-1) ?? ""));
};
