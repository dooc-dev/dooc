import { createHash, randomBytes } from "node:crypto";
import { sampleActions } from "./sample.mjs";

/** A local fixture provider; no real users, passwords, or external network requests. */
export const createSampleMock = ({ autoConnect = false, id = "sample", origin = "https://sample.dooc.invalid" } = {}) => {
    const users = { alice: { id: "mock-alice", name: "Alice (mock)" }, bob: { id: "mock-bob", name: "Bob (mock)" } };
    const resources = {
        "/tickets/DOC-42": {
            type: "ticket", id: "DOC-42", title: "Preview external service URLs", status: "In progress", author: "Alice Chen",
            body: "Keep tickets, reviews, and discussions right beside the docs.",
            project: "Editor", priority: "High", label: "Enhancement", cycle: "Cycle 08",
            due: "2026-11-12", estimate: "3", labels: JSON.stringify(["Enhancement", "Viewer"]),
            checklist: "- [x] Match service URLs\n- [x] Fetch preview data\n- [x] Render compact cards\n- [ ] Review accessibility\n- [ ] Ship the release",
            task1: "Match service URLs", task2: "Fetch preview data", task3: "Render compact cards", task4: "Review accessibility", task5: "Ship the release",
        },
        "/pulls/17": {
            type: "pull", id: "#17", title: "Add URL previewers", status: "Ready for review", author: "Bob Park",
            body: "URL matching, authenticated reads, and inline service previews.",
            repository: "dooc / editor", branch: "feat/previews", base: "main", additions: "248", deletions: "36", files: "8", checks: "4", reviews: "1 approval",
            diff: "+ const plugin = plugins.find(p => p.matches(url));\n+ const view = await plugin.read(url, context);\n+ renderPreview(view);\n- renderLink(url);",
        },
        "/messages/release-notes": {
            type: "message", id: "release-notes", title: "Preview cards are ready to ship", status: "Open", author: "Alice Chen",
            body: "Previews look good. One last pass on the release notes?",
            time: "10:24", channel: "release", attachment: "preview-release-notes.md", attachmentPreview: "## Preview cards\n- Tickets and pull requests\n- Inline message permalinks\nReady for release.",
            acknowledgements: "6", celebrations: "3", replies: "4",
        },
    };
    for (const resource of Object.values(resources)) {
        resource.version = 1;
        resource.comments = [
            { id: "1", user: "mock-alice", author: "Alice (mock)", body: "The preview is ready. Please check the mobile layout.", time: "2026-11-08 09:30 UTC" },
            { id: "2", user: "mock-bob", author: "Bob (mock)", body: "Looks good. I will review the keyboard controls next.", time: "2026-11-08 10:00 UTC" },
        ];
        resource.reactions = { "👍": ["mock-bob"], "🎉": [] };
    }
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
        return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 60, scope: "read write" });
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
                    !["read", "read write"].includes(params.get("scope")) || params.get("code_challenge_method") !== "S256" ||
                    !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "") ||
                    !params.get("state") || params.get("state").length > 512 ||
                    callback.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname) ||
                    callback.username || callback.password || callback.search || callback.hash ||
                    callback.pathname !== `/api/plugins/callback/${id}`) return error("Invalid mock authorization request");
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
            if (Object.hasOwn(resources, url.pathname) && request.method === "POST") {
                const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
                const grant = access.get(token);
                if (!grant) return error("invalid_token", 401);
                let operation;
                try { operation = await request.json(); } catch { return error("Invalid operation"); }
                const data = resources[url.pathname];
                const action = sampleActions(data, grant.user).find((action) => action.id === operation?.id);
                if (!action) return error("Operation is not available", 403);
                if (action.version !== undefined && operation.version !== action.version) return error("Content changed. Edit again to apply your input.", 409);
                if (action.destructive && operation.confirmed !== true) return error("Confirm the operation target");
                const values = operation.values;
                if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).some((key) => !action.fields.some((field) => field.name === key))) return error("Invalid fields");
                for (const field of action.fields) {
                    if (action.partial && !Object.hasOwn(values, field.name)) continue;
                    const value = values[field.name];
                    if (typeof value !== "string" || value.length > (field.maxLength ?? 4000) || (field.required && !value.trim())) return error("Invalid value");
                    if (field.type === "select" && !field.options.some((option) => option.value === value)) return error("Invalid selection");
                    if (field.type === "multiselect") {
                        let selected;
                        try { selected = JSON.parse(value); } catch { return error("Invalid selection"); }
                        if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some((item) => !field.options.some((option) => option.value === item))) return error("Invalid selection");
                    }
                    if (value && field.type === "number" && (!Number.isFinite(Number(value)) || Number(value) < field.min || Number(value) > field.max)) return error("Invalid number");
                    if (value && field.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return error("Invalid date");
                }
                if (action.id === "update") Object.assign(data, values);
                else if (action.id === "comment") data.comments.push({ id: nonce(), user: grant.user.id, author: grant.user.name, body: values.body, time: new Date().toISOString() });
                else if (action.id === "react") {
                    const users = data.reactions[values.emoji];
                    data.reactions[values.emoji] = users.includes(grant.user.id) ? users.filter((id) => id !== grant.user.id) : [...users, grant.user.id];
                } else if (action.id.startsWith("edit:")) data.comments.find((comment) => comment.id === action.id.slice(5)).body = values.body;
                else data.comments = data.comments.filter((comment) => comment.id !== action.id.slice(7));
                data.version++;
                return Response.json({ message: "Saved" });
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
