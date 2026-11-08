/** @returns {import("@dooc-dev/dooc-plugin").DataPlugin} */
export const createSamplePlugin = ({ authorizationUrl, tokenUrl, userUrl, clientId, clientSecret }) => {
    const origin = new URL(userUrl).origin;
    const matches = (url) => url.origin === origin &&
        /^\/(?:tickets\/[A-Z][A-Z0-9-]*-\d+|pulls\/\d+|messages\/[^/]+)$/.test(url.pathname);
    return {
        id: "sample",
        matches,
        oauth: { authorizationUrl, tokenUrl, clientId, clientSecret, scopes: ["read"] },
        apiOrigins: [origin],
        async identifyUser({ request }) {
            const value = await request(userUrl);
            if (!value || typeof value.id !== "string" || typeof value.name !== "string")
                throw new Error("Expected a user profile with string id and name");
            return { id: value.id, name: value.name };
        },
        async read(url, { request }) {
            if (!matches(url)) throw new Error("Unknown sample URL");
            const endpoint = new URL(url);
            endpoint.hash = "";
            const data = await request(endpoint.href);
            if (!data || !["ticket", "pull", "message"].includes(data.type) ||
                ["id", "title", "body", "status", "author"].some((key) => typeof data[key] !== "string"))
                throw new Error("Invalid sample resource response");
            const badge = { text: data.status, tone: "accent" };
            const blocks = [
                { type: "heading", text: data.title },
                { type: "context", items: [badge, data.id, data.author] },
                { type: "text", text: data.body, markdown: true },
            ];
            if (data.type === "ticket") blocks.push({ type: "fields", items: [
                { label: "Project", items: [(data.project ?? "—")] }, { label: "Priority", items: [(data.priority ?? "—")] },
                { label: "Cycle", items: [(data.cycle ?? "—")] }, { label: "Due", items: [(data.due ?? "—")] },
            ] }, { type: "section", title: "Checklist", blocks: [{ type: "text", markdown: true,
                text: [1, 2, 3, 4, 5].map(i => `- [${i <= 3 ? "x" : " "}] ${data[`task${i}`] ?? "—"}`).join("\n") }] });
            if (data.type === "pull") blocks.push({ type: "context", items: [
                { text: data.branch ?? "", code: true }, "→", { text: data.base ?? "", code: true }, `${data.checks} checks passed`, { text: `+${data.additions ?? 0}`, tone: "success" }, { text: `−${data.deletions ?? 0}`, tone: "danger" },
            ] }, { type: "section", title: `${data.files} files changed`, collapsed: true, blocks: [{ type: "code", text: data.diff ?? "", diff: true }] });
            if (data.type === "message") blocks.push({ type: "section", title: data.attachment ?? "Attachment", collapsed: true,
                blocks: [{ type: "text", text: data.attachmentPreview ?? "", markdown: true }] });
            return { format: "blocks", header: { title: { ticket: "Orbit", pull: "Forge", message: "Chatter" }[data.type],
                context: data.project ?? data.repository ?? data.channel, reference: data.id }, blocks,
                collapsed: { format: "blocks", blocks: [{ type: "context", items: [{ text: data.title, strong: true }, badge, ...(data.type === "pull" ? [`✓ ${data.checks} checks`] : [])] }] } };
        },
    };
};
