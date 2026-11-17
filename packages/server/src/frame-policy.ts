import { fetchPublicFile } from "../../engine/src/compiler/public-file.js";

/** Report only definite denials; redirects and more complex policies remain browser decisions. */
export const frameBlocked = async (
    source: string,
    parent: string,
): Promise<boolean | undefined> => {
    let blocked: boolean | undefined;
    try {
        const sameOrigin = new URL(source).origin === new URL(parent).origin;
        await fetchPublicFile(source, undefined, undefined, undefined, (headers) => {
            const policies = String(headers["content-security-policy"] ?? "").split(",");
            const ancestors = policies.flatMap((policy) => {
                const match = /(?:^|;)\s*frame-ancestors\s+([^;]+)/i.exec(policy);
                return match ? [match[1]?.trim().toLowerCase() ?? ""] : [];
            });
            if (ancestors.length) {
                if (
                    ancestors.some(
                        (rule) => rule === "'none'" || (rule === "'self'" && !sameOrigin),
                    )
                )
                    blocked = true;
                return;
            }
            const frame = String(headers["x-frame-options"] ?? "")
                .trim()
                .toLowerCase();
            if (frame === "deny" || (frame === "sameorigin" && !sameOrigin)) blocked = true;
        });
    } catch {
        /* Unavailable headers cannot prove that embedding was refused. */
    }
    return blocked;
};
