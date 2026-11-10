---
title: "Service cards"
lang: "alu"
---

A plugin fetches data and returns structured blocks. dooc renders the blocks using the current theme. These three fictional services are interactive local demos. No external account is needed; changes last until the viewer restarts.

Run `mise run dev` to register the demo plugins and load this sample workspace. The **Plugins** card lists **Service cards** (`sample`) and **Service cards (sign-in demo)** (`sample-auth`). TaskApp, GitApp, and ChatApp connect automatically.

## TaskApp

Turn on Edit, then double-click a value (or press Enter / F2) to change the title, status, assignee, priority, due date, labels, estimate, and checklist. Values save automatically. Markdown stays rendered until you open its editor.

![Issue DOC-42](https://sample.dooc.invalid/tickets/DOC-42)

## GitApp

Inspect the diff, change the review status, and post or edit comments.

![Pull request 17](https://sample.dooc.invalid/pulls/17)

## ChatApp

Edit the message, reply to the thread, and toggle reactions. Your own comments can be edited or deleted after confirmation.

![Release conversation](https://sample.dooc.invalid/messages/release-notes#message)

The top-right controls open the link, copy its URL, toggle Edit, and collapse the card. Editing is available only while Edit is on. Cards check for updates every five seconds and when you return to the tab; try the same card in two tabs. The sample URLs belong to the local mock service and are not public websites.

## Try the login flow

Open **Plugins**, find **Service cards (sign-in demo)**, and choose **Sign in**. The local consent screen lets you authorize **Alice**, authorize **Bob**, or cancel. No external service, password, or real account is used. Return to this page to see the account you chose; use **Sign out** to try again. This login demo has its own account and data, so the three cards above remain available.

![Login demo](https://auth.sample.dooc.invalid/tickets/DOC-42)

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
async function read(url, { request }) {
  const data = await request(url.href);
  if (!data || ["id", "title", "status", "body"].some(key => typeof data[key] !== "string")) {
    throw new Error("Invalid service response");
  }
  return {
    header: { title: "TaskApp", reference: data.id },
    blocks: [
      { type: "heading", text: data.title },
      { type: "context", items: [{ text: data.status, tone: "accent" }] },
      { type: "text", text: data.body, markdown: true }
    ],
    collapsed: {
      blocks: [{ type: "context", items: [data.status, data.id] }]
    }
  };
}
```

The block and action APIs are available in **@dooc-dev/dooc 0.0.1** and **@dooc-dev/dooc-plugin 0.0.1**. Cards use structured blocks for both expanded and collapsed views. Card values are returned by `read()` at runtime; `package.json` contains package metadata only.

For editable Linear, GitHub, and Slack cards, use **@sasaki-s-sci/dooc-plugins 0.0.2**. Its playground uses the real provider plugins with local API fixtures, including comment editing, reactions, and confirmed deletion. In the `dooc-plugins` checkout, authenticate npm for GitHub Packages, then run `npm ci` and `mise run dev`. Dependencies are pinned to the released host and SDK; an adjacent dooc checkout is not required.

Authentication and fetched data stay in the viewer. Source exports contain the URLs.
