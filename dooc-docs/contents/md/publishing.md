Choose whether the recipient needs a document snapshot, editable source or a live workspace. Saving in the editor writes source files; it does not publish them.

## Choose an output

| Recipient needs | Use | Result |
| --- | --- | --- |
| A document to read or host | `dooc build` | `build/index.html` |
| Documentation inside a GitHub repository | `dooc zip --target github` or `dooc build --target github` | Markdown ZIP, or an HTML body with separate assets |
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

## GitHub README output

```sh
dooc zip --target github
dooc build --target github --resources reference
```

The `github` target applies to both commands.

ZIP output is `dist/bundle.github.zip`. The first manifest page becomes `README.md`; other documents live under `pages/`, record and library pages under `views/`, generated SVGs under `assets/`, and copied source files under `resources/`. ZIP builds always include local files and capture supported remote embeds. Extract to the destination and commit the reviewed files together, preserving their relative locations. ZIP rejects `--resources reference` and `--url_preview network`.

HTML output is `build/bundle.github.html`, a GitHub-compatible HTML body with all pages linked by local anchors. Its generated and copied assets live beside it under `build/bundle.github/`. Keep that directory with the HTML. You can open the HTML for a static preview or paste its body into a README at the same directory level. This output has no reader runtime; code uses preformatted HTML, and authored Mermaid remains source code. Use ZIP's Markdown pages for GitHub's native fenced-code highlighting and Mermaid integration.

The build does not replace an existing repository README or publish to GitHub. HTML companions are replaced only when the destination directory belongs to a previous dooc GitHub build.

### Reference existing source files

For GitHub HTML, `--resources copy` is the default and includes referenced files. `--resources reference` instead links to existing files in the source workspace: raster images, self-contained SVG files, and complete code/data/media sources. SVGs that need dependency embedding, graphth/schemath/DXF conversions, and captured remote resources still produce generated assets. Code excerpts, tables and record contents are rendered snapshots; GitHub does not load their source text dynamically.

References are relative to the HTML output directory. The default base is calculated from the selected output directory to the manifest directory. For a README at the repository root, build into that directory so references have the same base. `--reference-base <relative-directory>` overrides the base for a planned destination. Move staged artifacts to that destination before checking them. Referenced sources must be committed along with the generated files, and moving the output requires rebuilding its relative links.

### Check a GitHub build

```sh
dooc check dooc.yaml --github-output build/bundle.github.html
dooc check dooc.yaml --only github --github-output dist/bundle.github.zip
```

Builds include `dooc-github.json` (inside the ZIP, or under `bundle.github/` for HTML). The offline check verifies generated files and their hashes, captured source files and their hashes, newly added dependencies, and the HTML reference base against the current project. Missing files, altered output or stale code excerpts/diagrams fail the check; rebuild to refresh them. `--github-output` paths are relative to the manifest directory unless absolute. Preserve the build manifest to keep the output checkable.

The check does not execute plugins or fetch remote resources, so it cannot detect remote content changes or GitHub renderer changes. ZIP inspection limits unpacked data to 256 MiB.

This is a reading format for GitHub's Markdown renderer. A single HTML file is optional for other publishing targets and does not bypass GitHub's restrictions. dooc's source can remain distributed across files; the compiler resolves those references before producing the reading pages.

### What carries over

| Reader content or behavior | GitHub output |
| --- | --- |
| Text, headings, lists, quotes and tables | Static content with section anchors and page navigation |
| Code and file excerpts | Links to the complete source; ZIP uses fenced code with GitHub highlighting, HTML uses preformatted text |
| graphth and schemath | Existing deterministic layout exported directly as SVG image files |
| SVG, draw.io SVG and DXF | Separate SVG images; DXF uses the existing conversion |
| Raster images and GIF | Separate image files |
| Collapsible tables and record details | Native `details` / `summary` disclosure controls |
| Structured records | Static groups in the configured sort order, with fields and source links |
| Terms | Links to a generated definitions page |
| Library pages | Terms and URL lists, or file listings for the selected format; no filters |
| Theme variants | Image variants use `picture`; other variants appear in labeled disclosure sections |
| Content languages | ZIP has pages under `locales/<language>/`; HTML links translated sections with anchors |
| HTML figures and plugin snapshots | Supported text, links, tables, disclosures and extracted SVGs; styles and interactive controls are removed, with build warnings |
| Video and PDF | Links to separate files for GitHub's file viewer or download |
| External previews in network mode | Ordinary links; there is no dooc runtime to fetch previews |

Graphth and schemath are not converted to Mermaid. In ZIP output, existing authored Mermaid blocks remain Mermaid code fences, which GitHub renders using its own integration.

### GitHub's boundary

GitHub sanitizes README HTML. Authored `iframe`, scripts, custom page CSS, inline `svg`, form controls and dooc's JavaScript cannot be carried into a README. A hosted reader cannot be embedded there with an iframe. Link to a separately hosted reader or `build` artifact when its interaction is required. See [GitHub's rendering pipeline](https://github.com/github/markup#github-markup) and [GFM's disallowed raw HTML](https://github.github.com/gfm/#disallowed-raw-html-extension-).

An SVG file referenced by `img` can preserve shapes, text, internal styles and supported declarative animation. It does not preserve pointer interaction inside the image: graph hover highlighting, node links, dragging, zoom and pan do not operate in the README. Image rendering also restricts external dependencies. Local SVG dependencies are embedded; unavailable dependencies are reported. See [SVG image processing restrictions](https://www.w3.org/TR/SVG2/conform.html#secure-animated-mode).

The export does not reproduce the reader's search, sidebar state, editable records, dynamic filtering or sorting, plugin authentication, or editor tools. HTML figures are exported semantically rather than taking a browser screenshot, so CSS-dependent layout and decoration are lost. The build reports content-specific fallbacks through CLI warnings or the MCP build result's `warnings` field. Review these warnings and the rendered pages before sharing.

The default `--url_preview embed` captures supported remote resources at build time using the existing download limits. GitHub HTML also supports `--url_preview network`, which skips downloads; remote previews become links, and an SVG's remote dependencies cannot be fetched from an image context. Neither option enables a live reader inside GitHub. `--mode`, `--auth`, `--source-url` and `--download` apply to reader HTML, not GitHub output.

Native controls such as [collapsed sections](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections) are useful substitutes for specific reader actions. They do not provide arbitrary application behavior. GitHub's sanitizer and media renderer can change independently of dooc, so verify the destination after updating a published bundle.

## Choose network and file behavior

Network resources and local files are independent choices. `--url_preview` controls remote embeds. `--resources` controls local file copies or references in GitHub HTML; ordinary reader HTML embeds its local files. ZIP fixes both choices to inclusion.

| Choice | Behavior | Suitable for |
| --- | --- | --- |
| Default `--url_preview embed` | Capture supported remote embeds during the build | A portable snapshot |
| HTML `--url_preview network` | Keep remote references; reader HTML fetches previews when opened, GitHub HTML links to them | Content that should stay connected |
| HTML `--mode live --auth external` | Keep plugin requests live with a host-provided transport | An integrated application with authentication supplied by its host |

Ordinary links remain links. Remote capture has download limits and does not execute a source site's JavaScript or sign in. Network-mode text embeds need the remote server's CORS permission. See [Build output](contents/md/cli.md#build-output) for exact constraints and failure behavior.

## Choose download behavior

Reader HTML accepts `--download easy|normal|block`. This replaces `--easy-download` and is independent of whether remote content is captured or fetched when opened.

| Mode | Behavior |
| --- | --- |
| `normal` (default) | Hide download buttons; keep normal right-click saving and browser behavior |
| `easy` | Add download buttons for complete resource files and record sources |
| `block` | Hide download links, suppress context menus, save/print shortcuts and media dragging, hide printed content and request media controls without a download button |

`block` also restricts embedded HTML frames, prevents pointer interaction inside script-free SVG frames and requests a hidden PDF toolbar. Reading navigation and code-copy controls remain available. Browser menus, native PDF viewers, external destinations and developer tools can still save content. The HTML already contains the material required to display it. For managed Chrome, [DownloadRestrictions](https://support.google.com/chrome/a/answer/7579271?hl=en) and [AllowFileSelectionDialogs](https://chromeenterprise.google/policies/allow-file-selection-dialogs/) are administrator policies; a dooc build cannot set them. ZIP and GitHub output reject `--download` because they do not run the reader's controls.

## Integrate a service or agent

Use [Plugins](contents/md/plugins.md) for service cards inside pages, and [Write a plugin](contents/md/plugin-dev.md) for the plugin contract. Use [Web MCP and Desktop connections](contents/md/web-mcp.md) to connect an agent to an open browser workspace.

These are different connections: a plugin supplies content from a service, while MCP exposes selected workspace operations to a client. A standalone document does not acquire either connection merely because it was built from an editable workspace.
