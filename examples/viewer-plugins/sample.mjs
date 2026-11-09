const serviceIcons = {
    ticket: '<circle cx="12" cy="12" r="7"/><ellipse cx="12" cy="12" rx="11" ry="4" transform="rotate(-35 12 12)"/>',
    pull: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10m12 0v-5c0-5-8-2-8-7m0 0 3 3m-3-3 3-3"/>',
    message: '<path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-8l-6 4v-4H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 8h10M7 13h7"/>',
};
const icon = (type, color) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${serviceIcons[type]}</svg>`).toString("base64")}`;
const options = (values) => values.map((value) => ({ value, label: value }));

export const sampleActions = (data, user) => {
    const fields = [
        { name: "title", label: "Title", type: "text", required: true, value: data.title },
        { name: "body", label: "Description", type: "textarea", value: data.body, maxLength: 10000 },
        { name: "status", label: "Status", type: "select", value: data.status,
            options: options(data.type === "ticket" ? ["Backlog", "In progress", "Done"] : data.type === "pull" ? ["Draft", "Ready for review", "Merged"] : ["Open", "Resolved"]) },
    ];
    if (data.type === "ticket") fields.push(
        { name: "priority", label: "Priority", type: "select", value: data.priority, options: options(["Low", "Normal", "High", "Urgent"]) },
        { name: "author", label: "Assignee", type: "select", value: data.author, options: options(["Alice Chen", "Bob Park", "Mina Ito"]) },
        { name: "due", label: "Due date", type: "date", value: data.due },
        { name: "estimate", label: "Estimate", type: "number", value: data.estimate, min: 0, max: 100 },
        { name: "labels", label: "Labels", type: "multiselect", value: data.labels, options: options(["Enhancement", "Viewer", "Accessibility"]) },
        { name: "checklist", label: "Checklist", type: "textarea", value: data.checklist },
    );
    return [
        { id: "update", label: "Edit details", target: data.id, version: String(data.version), partial: true, fields },
        { id: "comment", label: data.type === "message" ? "Reply" : "Post comment", target: data.id, fields: [{ name: "body", label: "Comment", type: "textarea", required: true }] },
        { id: "react", label: "React", target: data.id, fields: [{ name: "emoji", label: "Reaction", type: "select", options: options(["👍", "🎉"]) }] },
        ...(data.comments ?? []).filter((comment) => comment.user === user.id).flatMap((comment) => [
            { id: `edit:${comment.id}`, label: "Edit comment", target: `${data.id}: ${comment.body}`, version: String(data.version), fields: [{ name: "body", label: "Comment", type: "textarea", required: true, value: comment.body }] },
            { id: `delete:${comment.id}`, label: "Delete comment", target: `${data.id}: ${comment.body}`, version: String(data.version), destructive: true, fields: [] },
        ]),
    ];
};

/** @returns {import("@dooc-dev/dooc-plugin").DataPlugin} */
export const createSamplePlugin = ({ id = "sample", authorizationUrl, tokenUrl, userUrl, clientId, clientSecret }) => {
    const origin = new URL(userUrl).origin;
    const matches = (url) => url.origin === origin &&
        /^\/(?:tickets\/[A-Z][A-Z0-9-]*-\d+|pulls\/\d+|messages\/[^/]+)$/.test(url.pathname);
    const endpoint = (url) => {
        if (!matches(url)) throw new Error("Unknown sample URL");
        const result = new URL(url);
        result.hash = "";
        return result.href;
    };
    return {
        id,
        name: "Service cards",
        icon: { light: icon("ticket", "#303a4d"), dark: icon("ticket", "#d5dfef") },
        matches,
        oauth: { authorizationUrl, tokenUrl, clientId, clientSecret, scopes: ["read", "write"] },
        apiOrigins: [origin],
        async identifyUser({ request }) {
            const value = await request(userUrl);
            if (!value || typeof value.id !== "string" || typeof value.name !== "string")
                throw new Error("Expected a user profile with string id and name");
            return { id: value.id, name: value.name };
        },
        async read(url, { request, user }) {
            const data = await request(endpoint(url));
            if (!data || !["ticket", "pull", "message"].includes(data.type) ||
                ["id", "title", "body", "status", "author"].some((key) => typeof data[key] !== "string"))
                throw new Error("Invalid sample resource response");
            const edit = (field) => ({ action: "update", field });
            const field = (label, name, value = data[name]) => ({ label, items: [value ?? "—"], edit: edit(name) });
            const badge = { text: data.status, tone: data.status === "Done" || data.status === "Merged" || data.status === "Resolved" ? "success" : "accent" };
            const blocks = [
                { type: "heading", text: data.title, edit: edit("title") },
                { type: "context", items: [badge, { text: data.id, code: true, copy: data.id }, data.author] },
                { type: "text", text: data.body, markdown: true, edit: edit("body") },
                { type: "fields", items: [field("Status", "status"), ...(data.type === "ticket" ? [
                    field("Assignee", "author"), field("Priority", "priority"), field("Due", "due"), field("Estimate", "estimate"),
                    { label: "Labels", items: JSON.parse(data.labels ?? "[]"), edit: edit("labels") },
                    { label: "Project", items: [data.project ?? "—"] }, { label: "Cycle", items: [data.cycle ?? "—"] },
                ] : [])] },
            ];
            if (data.type === "ticket") blocks.push({ type: "section", title: "Checklist", blocks: [{ type: "text", markdown: true,
                text: data.checklist ?? "", edit: edit("checklist") }] });
            if (data.type === "pull") blocks.push({ type: "context", items: [
                { text: data.branch ?? "", code: true, copy: data.branch ?? "" }, "→", { text: data.base ?? "", code: true }, `${data.checks} checks passed`,
                { text: `+${data.additions ?? 0}`, tone: "success" }, { text: `−${data.deletions ?? 0}`, tone: "danger" }, data.reviews ?? "Awaiting review",
            ] }, { type: "section", title: `${data.files} files changed`, collapsed: true, blocks: [{ type: "code", text: data.diff ?? "", diff: true }] });
            if (data.type === "message") blocks.push({ type: "section", title: data.attachment ?? "Attachment", collapsed: true,
                blocks: [{ type: "text", text: data.attachmentPreview ?? "", markdown: true }] });
            blocks.push({ type: "section", title: `${data.type === "message" ? "Thread" : "Comments"} (${data.comments?.length ?? 0})`, blocks: [
                ...(data.comments ?? []).map((comment, index) => ({ type: "message", author: comment.author, text: comment.body, time: comment.time,
                    ...(index === 0 ? { reactions: ["👍", "🎉"].map((emoji) => ({
                        label: emoji, count: data.reactions?.[emoji]?.length ?? 0, active: data.reactions?.[emoji]?.includes(user.id) ?? false, action: "react", values: { emoji },
                    })) } : {}),
                    ...(comment.user === user.id ? { edit: { action: `edit:${comment.id}`, field: "body" }, actions: [`delete:${comment.id}`] } : {}) })),
                { type: "actions", ids: ["comment"], composer: true },
            ] });
            return { header: { title: { ticket: "Orbit", pull: "Forge", message: "Chatter" }[data.type],
                icon: { light: icon(data.type, "#303a4d"), dark: icon(data.type, "#d5dfef") },
                context: data.project ?? data.repository ?? data.channel, reference: data.id }, blocks,
                collapsed: { blocks: [{ type: "context", items: [{ text: data.title, strong: true }, badge, ...(data.type === "pull" ? [`✓ ${data.checks} checks`] : [])] }] } };
        },
        async actions(url, { request, user }) {
            return sampleActions(await request(endpoint(url)), user);
        },
        async act(url, { request }, operation) {
            return request(endpoint(url), { method: "POST", body: operation });
        },
    };
};
