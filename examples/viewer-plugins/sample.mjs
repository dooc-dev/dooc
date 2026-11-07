import { readFileSync } from "node:fs";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

/** @returns {import("@sasaki-s-sci/dooc-plugin").DataPlugin} */
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
            const template = { ticket: "ticket.html", pull: "pull.html", message: "card.html" }[data.type];
            const values = {
                ...data, initial: data.author.slice(0, 1).toUpperCase(),
                acknowledgementsPlusOne: String((Number(data.acknowledgements) || 0) + 1),
                celebrationsPlusOne: String((Number(data.celebrations) || 0) + 1),
            };
            const summaries = {
                ticket: '<div class="compact ticket"><span class="marker" aria-hidden="true">◈</span><div class="text"><strong>{{id}}</strong><span>{{title}}</span></div><span class="badge">{{status}}</span></div>',
                pull: '<div class="compact pull"><svg class="marker" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="15" cy="4" r="2"/><path d="M5 6v8m10-8v2a4 4 0 0 1-4 4H5"/></svg><div class="text"><strong>PR {{id}} · {{repository}}</strong><span>{{title}}</span></div><span class="badge">✓ {{checks}} checks</span></div>',
                message: '<div class="compact chat"><span class="avatar" aria-hidden="true">{{initial}}</span><div class="text"><strong>{{author}}<small>#{{channel}}</small></strong><span>{{title}}</span></div><span class="badge">✦ {{celebrations}}</span></div>',
            };
            const css = readFileSync(new URL("./card.css", import.meta.url), "utf8");
            const render = (html) => `<style>${css}</style>` + html.replace(
                /\{\{(\w+)\}\}/g, (_, key) => escapeHtml(values[key] ?? ""));
            return {
                format: "html",
                height: "auto",
                html: render(readFileSync(new URL(template, import.meta.url), "utf8")),
                collapsed: {
                    format: "html", height: 56,
                    html: render(`<style>${readFileSync(new URL("./compact.css", import.meta.url), "utf8")}</style>${summaries[data.type]}`),
                },
            };
        },
    };
};
