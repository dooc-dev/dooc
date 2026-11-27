# Theme palette study

## Design before implementation

Compare the current dooc palette with three alternatives before changing the application theme. This is a visual study for the existing editor and reader: preserve the product layout, content, SVG icons and controls, and change color tokens only. Keep the screenshots at the same viewport and route so that differences come from the palette. The presentation uses an unobtrusive comparison sheet with Light and Dark images beside each other, palette swatches and full-size image viewing.

| Candidate | Direction | Purpose |
| --- | --- | --- |
| Current | Existing cool gray and vivid orange | Reference for the shipped palette |
| A · Graphite | Neutral gray with muted amber | Recommended starting point; quieter contrast while retaining the warm accent |
| B · Paper | Warm gray with terracotta | A warmer alternative for sustained reading |
| C · Slate | Cool gray with teal | A cooler alternative with less orange emphasis |

Use a separate Light and Dark palette for every candidate rather than inverting colors. Preserve the original logo, layout, font sizes and syntax highlighting. Keep success, warning and error colors recognizable. The same subdued icon color is shared across ordinary controls. No candidate is adopted by this study, and the production theme source remains unchanged.

## Deliverables and validation

- Store the comparison at `contents/html/theme-variants.html` and rendered application screenshots under `contents/png/theme-variants/`.
- Link to the standalone HTML in the source repository. Local HTML references are validated as script-free figures; keep view switching and enlargement in the separately opened comparison.
- Embed all sixteen screenshots as PNG data URLs in the comparison HTML. File previews can render HTML through a sandboxed `srcdoc` without a usable base URL; the sheet must not depend on relative image paths or a running server. Keep the existing standalone PNG files as source assets.
- Present the current palette and three candidates with consistent sample content, plus named color swatches for the main roles.
- Capture the editor's task board and the reader's playground document for every palette. A shared view switch changes all comparisons together; each view retains side-by-side Light and Dark images.
- Make images enlargeable using both the mouse and keyboard, with a close action and Escape support.
- Present the interactive sheet in a totex `iframe` pane using a local HTTP server bound to `127.0.0.1`. Totex's file preview strips scripts and truncates text at 64 KiB, so a file pane cannot support this image-heavy interactive comparison. Keep the reader and editor panes unchanged and reuse the comparison pane's ID.
- Verify all images load, Light and Dark captures use the intended colors, and the comparison fits desktop and mobile widths without horizontal overflow.
- Record text contrast for candidate palette pairs and inspect the rendered comparison before sharing it.

## Preview

[Download the standalone theme comparison](https://raw.githubusercontent.com/dooc-dev/dooc/main/dooc-docs/contents/html/theme-variants.html)

Download the HTML and open it in a browser to switch views and enlarge screenshots. The interactive sheet is not embedded as a static document figure.

## Validation

The comparison contains sixteen real application screenshots: four palettes, two color schemes and two views. Every capture uses a 1600 × 960 viewport; the editor panel is set to 320 px so all three task-board columns remain visible. Theme-dependent syntax highlighting finishes before capture. The task board has no resource-index errors.

The initial local-file check verified all sixteen images and the controls, but did not cover the canvas's file-preview restrictions. Relative image URLs failed to resolve there. Embedding the PNGs removed that dependency, but the subsequent sandbox test allowed document scripts and omitted the host's 64 KiB text limit; it did not reproduce totex's actual file preview. The interactive comparison must be served over loopback HTTP and displayed through totex's live iframe. The standalone HTML retains all sixteen embedded PNGs for opening directly in a browser.

The live preview at `http://localhost:2003/contents/html/theme-variants.html` was checked using the nested iframe structure, sandbox flags and content policy from totex's `LiveFrame`. The complete HTML and all sixteen images loaded, Editor/Reader/Editor switching changed and restored the images, enlargement opened and closed, and 1480/390 px layouts fit without page errors. The existing comparison pane now uses this live URL; the other two canvas panes remain unchanged. Totex application code was not modified.

For body, secondary and accent text on the canvas and panel backgrounds, the lowest candidate contrast ratios are Graphite 4.86:1 Light / 6.28:1 Dark, Paper 4.53:1 Light / 5.88:1 Dark, and Slate 4.78:1 Light / 6.27:1 Dark. These checks cover the proposed palette pairs, not every application state. Production theme definitions and README files were not changed.
