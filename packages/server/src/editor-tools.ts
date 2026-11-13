import * as tools from "../../workspace/src/editor-tools.js";
import { allowsWorkspaceCode } from "./workspace-trust.js";

export {
    codeBlockAt,
    isLocalHost,
    isLocalToolRequest,
    requestScheme,
} from "../../workspace/src/editor-tools.js";

export const runCodeTool = (
    root: string,
    body: string,
    position: number,
    action: "format" | "lint",
) => tools.runCodeTool(root, body, position, action, allowsWorkspaceCode());

export const validateCodeTools = (root: string, body: string) =>
    tools.validateCodeTools(root, body, allowsWorkspaceCode());

export const validateTextfileCode = (root: string, language: string, content: string) =>
    tools.validateTextfileCode(root, language, content, allowsWorkspaceCode());
