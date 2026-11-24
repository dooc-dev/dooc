name: Navigation and workspace state consistency
area: Runtime
status: Shipped
priority: High
summary: |
  Navigation and history retain the latest request across pane changes, slow reads and external updates. Cancellation reaches the workspace transport, Node reads avoid blocking behind remote Git reads, and navigation avoids body compilation. Files, Git, search, themes and focus preserve their workspace context. Sidebar, drag-and-drop, expanded figure and menu regressions cover the 2026-11-24 UX follow-up.
