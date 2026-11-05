import { mountFileUpload } from "./file-upload.js";
import { mountFiles } from "./files-ui.js";
import { mountUiLanguage } from "./i18n.js";
import { mountPreviewSettings } from "./preview-settings-ui.js";

mountUiLanguage();
mountPreviewSettings();

mountFiles();
mountFileUpload();
