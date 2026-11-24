name: Split HTML builds and output limits
area: Release
status: Shipped
priority: Normal
summary: |
  HTML builds can publish immutable split assets, optionally compress supported media previews while retaining original downloads, enforce per-file and total size limits, and fail on warnings. Output checks precede the atomic entry-point replacement. CLI and MCP expose the same options; split HTML requires HTTP hosting.
