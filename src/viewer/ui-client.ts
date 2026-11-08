import { mountFileUpload } from "./file-upload.js";
import { mountFiles } from "./files-ui.js";
import { mountGit } from "./git-ui.js";
import type { HmrBridge } from "./hmr.js";
import { mountUiLanguage } from "./i18n.js";
import { mountPlugins } from "./plugins-ui.js";
import { createPreviewUpdater } from "./preview-update.js";
import { mountResourceLibrary } from "./resource-library-ui.js";

const bridge = window as unknown as { __docsHmr?: Partial<HmrBridge> };
bridge.__docsHmr = {
    ...bridge.__docsHmr,
    updatePreview: createPreviewUpdater(document.querySelector("main") ?? document),
};
mountUiLanguage();
mountPlugins();
mountResourceLibrary();

if (document.body.classList.contains("edit")) {
    mountFiles();
    mountGit();
    mountFileUpload();
}
