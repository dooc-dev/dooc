import { browserExtensionRequest, extensionBase64 } from "../src/viewer/extensions-store.ts";
import { mountExtensions } from "../src/viewer/extensions-ui.ts";

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};
const rejects = async (task) => {
    try {
        await task;
    } catch {
        return;
    }
    throw new Error("Expected stale or invalid extension data to be rejected");
};
window.testExtensionStorage = async (file) => {
    const scope = "dooc-extension-selfcheck";
    const request = (input) => browserExtensionRequest(scope, input);
    const data = extensionBase64(new Uint8Array(await file.arrayBuffer()));
    for (const item of (await request({ action: "list" })).items)
        await request({ action: "delete", file: item.file, hash: item.hash });
    const installed = (await request({ action: "install", file: file.name, data, base: null }))
        .items[0];
    assert(!installed.enabled, "Remote storage must not execute server plugins");
    await rejects(request({ action: "install", file: file.name, data, base: null }));
    await rejects(
        request({
            action: "edit",
            file: file.name,
            hash: installed.hash,
            path: "package.json",
            source: "{}",
        }),
    );
    const updated = (
        await request({
            action: "edit",
            file: file.name,
            hash: installed.hash,
            path: "assets/orbit.svg",
            source: "<svg>Edited</svg>",
        })
    ).items[0];
    assert(updated.hash !== installed.hash, "Edits must change the revision");
    const read = await request({ action: "read", file: file.name });
    assert(
        atob(read.files.find((entry) => entry.name === "assets/orbit.svg").data) ===
            "<svg>Edited</svg>",
        "Asset edit must persist",
    );
    await rejects(request({ action: "delete", file: file.name, hash: installed.hash }));
    const removed = await request({ action: "delete", file: file.name, hash: updated.hash });
    assert(removed.items.length === 0, "Deletion must persist");
    return "Browser ZIP, IndexedDB persistence, editing, stale revisions and deletion passed";
};
mountExtensions();
