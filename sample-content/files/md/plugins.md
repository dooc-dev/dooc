---
title: "Service cards"
---

An external embed lets a plugin choose what to fetch and how to display it. These three fictional services use local mock data.

## Orbit

Change the status or open the checklist.

![Issue DOC-42](https://sample.dooc.invalid/tickets/DOC-42)

## Forge

Open the changed-files row to inspect the diff.

![Pull request 17](https://sample.dooc.invalid/pulls/17)

## Chatter

Open the attachment or add a reaction.

![Release conversation](https://sample.dooc.invalid/messages/release-notes#message)

The top-right controls open the link, copy its URL, and fold the preview into a compact card. Mock interactions stay inside the preview; they do not write to a service.

## A URL without a plugin

![](https://unsupported.example/tickets/123)

Unmatched URLs stay links. Ordinary `[links](URL)` also stay links.

## Plugin contract

Register plugins in the viewer, outside the document folder. The example module is `examples/viewer-plugins/index.mjs`.

- `matches(url)` selects supported service URLs.
- `read(url, context)` fetches data and returns an HTML or JSON view.
- `collapsed` optionally supplies a separate compact view.
- HTML `height: "auto"` follows the content; numeric heights stay fixed.

```javascript
return {
  format: "html",
  height: "auto",
  html: "<article>Full preview</article>",
  collapsed: {
    format: "html",
    height: 56,
    html: "<strong>Open · DOC-42</strong>"
  }
};
```

Authentication and fetched data stay in the viewer. Source exports contain the URLs.
