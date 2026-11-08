---
title: "Service cards"
lang: "alu"
---

A plugin fetches data and returns structured blocks. dooc renders the blocks using the current theme. These three fictional services use read-only local mock data.

## Orbit

Read the status, assignee, and checklist.

![Issue DOC-42](https://sample.dooc.invalid/tickets/DOC-42)

## Forge

Open the changed-files row to inspect the diff.

![Pull request 17](https://sample.dooc.invalid/pulls/17)

## Chatter

Read the conversation and its reactions.

![Release conversation](https://sample.dooc.invalid/messages/release-notes#message)

The top-right controls open the link, copy its URL, and fold the preview into a compact card. These sample cards do not write to a service.

## A URL without a plugin

![](https://unsupported.example/tickets/123)

Unmatched URLs stay links. Ordinary `[links](URL)` also stay links.

## Plugin contract

Register plugins in the viewer, outside the document folder. The example module is `examples/viewer-plugins/index.mjs`.

- `matches(url)` selects supported service URLs.
- `read(url, context)` fetches data and returns validated blocks.
- `header` provides the service name, context, reference, and optional theme-specific icons.
- `collapsed` optionally supplies a separate compact view.
- `actions` describes available edits; `act` validates and performs an authorized operation.

```javascript
return {
  format: "blocks",
  header: { title: "Orbit", reference: "DOC-42" },
  blocks: [
    { type: "heading", text: "Improve service previews" },
    { type: "context", items: [{ text: "Open", tone: "accent" }] },
    { type: "text", text: "**Assigned to Ada**", markdown: true }
  ],
  collapsed: {
    format: "blocks",
    blocks: [{ type: "context", items: ["Open", "DOC-42"] }]
  }
};
```

The block and action APIs are available in **dooc 0.0.22** and **@sasaki-s-sci/dooc-plugin 0.0.3**. HTML views remain supported for older plugins.

For editable Linear, GitHub, and Slack cards, use **@sasaki-s-sci/dooc-plugins 0.0.2**. Its playground uses the real provider plugins with local API fixtures, including comment editing, reactions, and confirmed deletion. In the `dooc-plugins` checkout, authenticate npm for GitHub Packages, then run `npm ci` and `mise run dev`. Dependencies are pinned to the released host and SDK; an adjacent dooc checkout is not required.

Authentication and fetched data stay in the viewer. Source exports contain the URLs.
