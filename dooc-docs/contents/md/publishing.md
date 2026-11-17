Choose whether the recipient needs a document snapshot, editable source or a live workspace. Saving in the editor writes source files; it does not publish them.

## Choose an output

| Recipient needs | Use | Result |
| --- | --- | --- |
| A document to read or host | `dooc build` | `build/index.html` |
| The source files as authored | `dooc zip` | `dist/bundle.zip`; remote references stay URLs |
| Editable source with captured remote embeds | `dooc zip --url_preview embed` | `dist/bundle.zip` |
| A live editing or viewing application | [App runtimes](contents/md/runtimes.md) | Application assets and selected runtime components |
| Agent access to a workspace | `dooc editor/reader run node --mcp`, or [Web MCP connections](contents/md/web-mcp.md) | An MCP connection with the selected access mode and transport |

## Review before sharing

1. Save pending editor changes.
2. Run `dooc check` and fix local content errors.
3. Build the artifact with the URL behavior you intend.
4. Open the output and review navigation, diagrams, records and external dependencies.
5. Share the accepted artifact or hand it to your hosting process.

```sh
dooc check dooc.yaml
dooc build
```

`build/` holds only the reading page, so that folder can be served as it is; `dooc zip` writes archives to `dist/` instead. The build commands create files; they do not deploy a site. Use [CI/CD](contents/md/ci.md) to repeat the validation and artifact steps in a pipeline.

## Choose network and file behavior

`--url_preview` controls remote embeds. Local files are always included.

| Choice | Behavior | Suitable for |
| --- | --- | --- |
| Default `--url_preview network` | Keep remote references; the page fetches previews when opened | Content that should stay connected |
| `--url_preview embed` | Capture supported remote embeds during the build | A portable snapshot |
| `dooc build --mode live --auth external` | Keep plugin requests live with a host-provided transport | An integrated application with authentication supplied by its host |

Git-hosted child manifests are resolved before `build` or `zip`, including network mode, and can require Git and network access. Source ZIPs include their referenced files under `dooc-imports/` while keeping authored manifest URLs. Ordinary links remain links. Remote capture has download limits and does not execute a source site's JavaScript or sign in. Network-mode text embeds need the remote server's CORS permission. See [Build output](contents/md/cli.md#build-output) for exact constraints and failure behavior.

## Choose download behavior

Reader HTML accepts `--download easy|normal|block`. This replaces `--easy-download` and is independent of whether remote content is captured or fetched when opened.

| Mode | Behavior |
| --- | --- |
| `normal` (default) | Hide download buttons; keep normal right-click saving and browser behavior |
| `easy` | Add download buttons for complete resource files and record sources |
| `block` | Hide download links, suppress context menus, save/print shortcuts and media dragging, hide printed content and request media controls without a download button |

`block` also restricts embedded HTML frames, prevents pointer interaction inside script-free SVG frames and requests a hidden PDF toolbar. Reading navigation and code-copy controls remain available. Browser menus, native PDF viewers, external destinations and developer tools can still save content. The HTML already contains the material required to display it. For managed Chrome, [DownloadRestrictions](https://support.google.com/chrome/a/answer/7579271?hl=en) and [AllowFileSelectionDialogs](https://chromeenterprise.google/policies/allow-file-selection-dialogs/) are administrator policies; a dooc build cannot set them. ZIP output rejects `--download` because it does not run the reader's controls.

## Integrate a service or agent

Use [Plugins](contents/md/plugins.md) for service cards inside pages, and [Write a plugin](contents/md/plugin-dev.md) for the plugin contract. Use [Web MCP and Desktop connections](contents/md/web-mcp.md) to connect an agent to an open browser workspace.

These are different connections: a plugin supplies content from a service, while MCP exposes selected workspace operations to a client. A standalone document does not acquire either connection merely because it was built from an editable workspace.
