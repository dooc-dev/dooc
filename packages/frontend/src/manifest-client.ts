import "./ui-client.js";
import type { HmrBridge } from "../../server/src/hmr.js";
import { hasManifestDraft, mountManifest } from "./manifest-ui.js";

mountManifest(document.getElementById("manifest-manager"));
document.addEventListener("docs:manifest-draft", () => {
    (window as unknown as { __docsHmr?: HmrBridge }).__docsHmr?.setDirty(hasManifestDraft());
});
window.addEventListener("beforeunload", (event) => {
    if (!hasManifestDraft()) return;
    event.preventDefault();
    event.returnValue = "";
});
