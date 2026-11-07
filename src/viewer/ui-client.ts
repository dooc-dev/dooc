import { mountFileUpload } from "./file-upload.js";
import { mountFiles } from "./files-ui.js";
import { mountGit } from "./git-ui.js";
import { mountUiLanguage } from "./i18n.js";
import { mountPlugins } from "./plugins-ui.js";
import { mountResourceLibrary } from "./resource-library-ui.js";

mountUiLanguage();
mountPlugins();
mountResourceLibrary();

if (document.body.classList.contains("edit")) {
    mountFiles();
    mountGit();
    mountFileUpload();
}
