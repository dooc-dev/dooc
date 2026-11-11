import { type CodeTokenRequest, type CodeTokenResponse, tokenizeCode } from "./code-tokens.js";

globalThis.onmessage = async ({ data }: MessageEvent<CodeTokenRequest>) => {
    let response: CodeTokenResponse;
    try {
        response = { id: data.id, tokens: await tokenizeCode(data) };
    } catch (error) {
        response = { id: data.id, error: error instanceof Error ? error.message : String(error) };
    }
    globalThis.postMessage(response);
};
