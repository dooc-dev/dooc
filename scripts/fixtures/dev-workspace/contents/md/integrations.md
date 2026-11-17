# Local integrations

`mise run dev` loads the existing demo plugins. Their fictional services run locally and do not contact a real ticket, Git, or chat service. Changes to their mock data last until the server restarts.

## Ticket fields

![TaskApp ticket](https://sample.dooc.invalid/tickets/DOC-42)

Enable **Edit**, then double-click the title, priority, assignee, date, estimate, labels, or description. Try the multi-select and add a comment.

## Pull-request review

![GitApp pull request](https://sample.dooc.invalid/pulls/17)

Expand the diff, change the review status, and add a comment. Try collapsing and resizing the card.

## Conversation

![ChatApp conversation](https://sample.dooc.invalid/messages/release-notes#message)

Reply, react, edit your message, and open the attachment. Open this page in another tab to observe refreshed cards.

## Sign-in and plugin management

![Sign-in demo](https://auth.sample.dooc.invalid/tickets/DOC-42)

Open **Plugins**, choose **Sign in** for **Sample plugin (sign-in demo)**, and select Alice or Bob on the local consent page. Sign out to see the disconnected state. The generated workspace keeps demo credentials in its ignored `.dooc/user/` directory.

Reader-provided plugins are listed separately from installed ZIP packages. To try ZIP installation, build the existing sample package with `pnpm run build:sample-extension`, then use **Add plugins** in a separate disposable workspace. See [Plugins](contents/md/plugins.md) for packaging and trust boundaries.

## MCP and export

The development task starts editor MCP at `http://localhost:2000/mcp` and reader MCP at `http://localhost:2001/mcp`. Editor MCP includes editing tools; reader MCP exposes read tools only and rejects writes. Connect your MCP client to the endpoint with the permissions you need. Open **MCP connection** for the browser connection options. Connecting an external assistant is a separate action; the sample contains no assistant credentials.

From the repository checkout, archive the generated workspace or build a reader:

```sh
mise run dooc zip build/dev/workspace/dooc.yaml build/playground-source
mise run dooc build build/dev/workspace/dooc.yaml build/playground-reader
```

The source export keeps the local files, themes, translations, font, grammar, and editor-tool configuration. External plugin URLs stay references unless an explicitly configured build plugin supplies snapshots. [Publishing](contents/md/publishing.md) covers static, live, Node, and browser outputs.
