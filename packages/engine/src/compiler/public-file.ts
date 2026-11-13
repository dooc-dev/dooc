/** Self-contained: the synchronous compiler also runs this function in a bounded child process. */
export async function fetchPublicFile(
    source: string,
    contentType?: (type: string) => void,
    progress?: (received: number, total?: number) => void,
): Promise<Buffer> {
    const { request } = await import("node:https");
    const { lookup } = await import("node:dns/promises");
    const { BlockList, isIP } = await import("node:net");
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
        throw new Error("BLOCKED");
    const blocked = new BlockList();
    for (const [address, prefix] of [
        ["0.0.0.0", 8],
        ["10.0.0.0", 8],
        ["100.64.0.0", 10],
        ["127.0.0.0", 8],
        ["169.254.0.0", 16],
        ["172.16.0.0", 12],
        ["192.0.0.0", 24],
        ["192.0.2.0", 24],
        ["192.88.99.0", 24],
        ["192.168.0.0", 16],
        ["198.18.0.0", 15],
        ["198.51.100.0", 24],
        ["203.0.113.0", 24],
        ["224.0.0.0", 3],
    ] as const)
        blocked.addSubnet(address, prefix, "ipv4");
    const globalV6 = new BlockList();
    globalV6.addSubnet("2000::", 3, "ipv6");
    for (const [address, prefix] of [
        ["2001::", 23],
        ["2001:db8::", 32],
        ["2002::", 16],
        ["3fff::", 20],
    ] as const)
        blocked.addSubnet(address, prefix, "ipv6");
    const publicAddress = (address: string): boolean =>
        isIP(address) === 4
            ? !blocked.check(address, "ipv4")
            : isIP(address) === 6 &&
              globalV6.check(address, "ipv6") &&
              !blocked.check(address, "ipv6");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !publicAddress(host)) throw new Error("BLOCKED");
    return new Promise((resolve, reject) => {
        // No redirects, proxy, cookies or inherited authorization; TLS still validates the original host.
        const req = request(
            url,
            {
                agent: false,
                signal: AbortSignal.timeout(10000),
                lookup(hostname, options, callback) {
                    void lookup(hostname, { all: true, verbatim: true }).then(
                        (addresses) => {
                            const first = addresses[0];
                            if (
                                !first ||
                                !addresses.every(({ address }) => publicAddress(address))
                            ) {
                                callback(new Error("BLOCKED"), "", 0);
                                return;
                            }
                            if (options.all) callback(null, addresses);
                            else callback(null, first.address, first.family);
                        },
                        (error: Error) => callback(error, "", 0),
                    );
                },
            },
            (response) => {
                if (response.statusCode === 404 || response.statusCode === 410) {
                    response.destroy();
                    reject(new Error("NOT_FOUND"));
                    return;
                }
                if (response.statusCode !== 200) {
                    response.destroy();
                    reject(new Error("UNAVAILABLE"));
                    return;
                }
                contentType?.(response.headers["content-type"] ?? "");
                const length = response.headers["content-length"];
                const total =
                    typeof length === "string" &&
                    /^\d+$/.test(length) &&
                    Number.isSafeInteger(Number(length))
                        ? Number(length)
                        : undefined;
                progress?.(0, total);
                const chunks: Buffer[] = [];
                let size = 0;
                response.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    progress?.(size, total);
                    if (size > 2 * 1024 * 1024) {
                        response.destroy();
                        reject(new Error("UNAVAILABLE"));
                    } else chunks.push(chunk);
                });
                response.on("end", () => resolve(Buffer.concat(chunks)));
                response.on("error", reject);
                response.on("aborted", () => reject(new Error("UNAVAILABLE")));
            },
        );
        req.on("error", reject);
        req.end();
    });
}
