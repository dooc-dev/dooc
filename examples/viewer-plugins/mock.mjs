import { createHash, randomBytes } from "node:crypto";

/** A local fixture provider; no real users, passwords, or external network requests. */
export const createSampleMock = ({ autoConnect = false } = {}) => {
    const origin = "https://sample.dooc.invalid";
    const users = { alice: { id: "mock-alice", name: "Alice (mock)" }, bob: { id: "mock-bob", name: "Bob (mock)" } };
    const resources = {
        "/tickets/DOC-42": {
            type: "ticket", id: "DOC-42", title: "Preview external service URLs", status: "In progress", author: "Alice Chen",
            body: "Keep tickets, reviews, and discussions right beside the docs.",
            project: "Editor", priority: "↑ High", label: "Enhancement", cycle: "Cycle 08",
            due: "Due Nov 12",
            task1: "Match service URLs", task2: "Fetch preview data", task3: "Render compact cards", task4: "Review accessibility", task5: "Ship the release",
        },
        "/pulls/17": {
            type: "pull", id: "#17", title: "Add URL previewers", status: "Ready for review", author: "Bob Park",
            body: "URL matching, authenticated reads, and inline service previews.",
            repository: "dooc / editor", branch: "feat/previews", base: "main", additions: "248", deletions: "36", files: "8", checks: "4", reviews: "1 approval",
            diff: "+ const plugin = plugins.find(p => p.matches(url));\n+ const view = await plugin.read(url, context);\n+ renderPreview(view);\n- renderLink(url);",
        },
        "/messages/release-notes": {
            type: "message", id: "release-notes", title: "Preview cards are ready to ship", status: "Updated 10:42", author: "Alice Chen",
            body: "Previews look good. One last pass on the release notes?",
            time: "10:24", channel: "release", attachment: "preview-release-notes.md", attachmentPreview: "## Preview cards\n- Tickets and pull requests\n- Inline message permalinks\nReady for release.",
            acknowledgements: "6", celebrations: "3", replies: "4",
        },
    };
    const approvals = new Map();
    const codes = new Map();
    const access = new Map();
    const refresh = new Map();
    const nonce = () => randomBytes(32).toString("base64url");
    const error = (message, status = 400) => Response.json({ error: message }, { status });
    const tokens = (user) => {
        const accessToken = `mock-access-${nonce()}`;
        const refreshToken = `mock-refresh-${nonce()}`;
        access.set(accessToken, { user, expires: Date.now() + 60_000 });
        refresh.set(refreshToken, { user, expires: Date.now() + 8 * 60 * 60_000 });
        return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 60, scope: "read" });
    };
    return {
        origin,
        autoConnect,
        async handle(request) {
            for (const entries of [approvals, codes, access, refresh]) {
                for (const [key, value] of entries) if (value.expires <= Date.now()) entries.delete(key);
                if (entries.size >= 128) return error("Mock session limit reached", 429);
            }
            const url = new URL(request.url);
            if (url.origin !== origin) return error("Unknown mock origin", 404);
            const params = url.searchParams;
            if (url.pathname === "/authorize" && request.method === "GET") {
                let callback;
                try { callback = new URL(params.get("redirect_uri")); } catch { return error("Invalid callback"); }
                if (params.get("client_id") !== "dooc-sample" || params.get("response_type") !== "code" ||
                    params.get("scope") !== "read" || params.get("code_challenge_method") !== "S256" ||
                    !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "") ||
                    !params.get("state") || params.get("state").length > 512 ||
                    callback.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname) ||
                    callback.username || callback.password || callback.search || callback.hash ||
                    callback.pathname !== "/api/plugins/callback/sample") return error("Invalid mock authorization request");
                if (autoConnect) {
                    const code = nonce();
                    codes.set(code, { callback: callback.href, challenge: params.get("code_challenge"), user: users.alice, expires: Date.now() + 60_000 });
                    callback.searchParams.set("state", params.get("state"));
                    callback.searchParams.set("code", code);
                    return new Response(null, { status: 303, headers: { location: callback.href } });
                }
                const transaction = nonce();
                approvals.set(transaction, { callback: callback.href, state: params.get("state"), challenge: params.get("code_challenge"), expires: Date.now() + 10 * 60_000 });
                return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Mock OAuth authorization</title><style>body{font:16px system-ui;max-width:600px;margin:64px auto;padding:24px}button{margin:8px;padding:12px}</style><h1>Mock OAuth authorization</h1><p>Local sample only. These users and their data are fictional. No password or external account is required.</p><form method="post"><input type="hidden" name="transaction" value="${transaction}"><button name="user" value="alice">Authorize Alice (mock)</button><button name="user" value="bob">Authorize Bob (mock)</button><button name="user" value="deny">Cancel</button></form></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
            }
            if (url.pathname === "/authorize" && request.method === "POST") {
                const form = new URLSearchParams(await request.text());
                const approval = approvals.get(form.get("transaction"));
                approvals.delete(form.get("transaction"));
                if (!approval) return error("Expired mock approval");
                const callback = new URL(approval.callback);
                callback.searchParams.set("state", approval.state);
                const user = Object.hasOwn(users, form.get("user")) ? users[form.get("user")] : undefined;
                if (!user) callback.searchParams.set("error", "access_denied");
                else {
                    const code = nonce();
                    codes.set(code, { ...approval, user, expires: Date.now() + 60_000 });
                    callback.searchParams.set("code", code);
                }
                return new Response(null, { status: 303, headers: { location: callback.href } });
            }
            if (url.pathname === "/token" && request.method === "POST") {
                const form = new URLSearchParams(await request.text());
                if (form.get("client_id") !== "dooc-sample") return error("invalid_client");
                if (form.get("grant_type") === "refresh_token") {
                    const grant = refresh.get(form.get("refresh_token"));
                    refresh.delete(form.get("refresh_token"));
                    return grant ? tokens(grant.user) : error("invalid_grant");
                }
                const grant = codes.get(form.get("code"));
                codes.delete(form.get("code"));
                const verifier = form.get("code_verifier") ?? "";
                if (form.get("grant_type") !== "authorization_code" || !grant ||
                    form.get("redirect_uri") !== grant.callback || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
                    createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return error("invalid_grant");
                return tokens(grant.user);
            }
            if ((url.pathname === "/me" || Object.hasOwn(resources, url.pathname)) && request.method === "GET") {
                const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
                const grant = access.get(token);
                return grant ? Response.json(url.pathname === "/me" ? grant.user : resources[url.pathname]) : error("invalid_token", 401);
            }
            return error("Unknown mock endpoint", 404);
        },
    };
};
