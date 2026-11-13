import type { HmrBridge } from "../../server/src/hmr.js";
import { mountExtensions } from "./extensions-ui.js";
import { mountFileUpload } from "./file-upload.js";
import { mountFiles } from "./files-ui.js";
import { mountGit } from "./git-ui.js";
import { mountHmr } from "./hmr-client.js";
import { mountUiLanguage } from "./i18n.js";
import { mountIdentity } from "./identity.js";
import { mountPlugins } from "./plugins-ui.js";
import { createPreviewUpdater } from "./preview-update.js";
import { mountResourceLibrary } from "./resource-library-ui.js";

const bridge = window as unknown as { __docsHmr?: Partial<HmrBridge> };
bridge.__docsHmr = {
    ...bridge.__docsHmr,
    updatePreview: createPreviewUpdater(document.querySelector("main") ?? document),
};
mountHmr(document.body.classList.contains("edit") ? "edit" : "preview");
if (document.body.classList.contains("edit")) mountIdentity();
mountUiLanguage();
mountPlugins();
mountResourceLibrary();

if (document.body.classList.contains("edit")) {
    mountFiles();
    mountGit();
    mountFileUpload();
    mountExtensions();
}
