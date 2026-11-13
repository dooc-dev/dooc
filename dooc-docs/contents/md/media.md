Visual files render in place. The alt text becomes the caption.

## Images

| Format | Embed                                                            |
| ------ | ---------------------------------------------------------------- |
| SVG    | `![From source to a shared document](contents/svg/workflow.svg)` |
| PNG    | `![Preview coverage](contents/png/coverage.png)`                 |
| JPEG   | `![JPEG export](contents/jpg/coverage.jpg)`                      |
| WebP   | `![WebP export](contents/webp/coverage.webp)`                    |
| GIF    | `![A small loading indicator](contents/gif/activity.gif)`        |

![From source to a shared document](contents/svg/workflow.svg)

![Preview coverage](contents/png/coverage.png)

![JPEG export](contents/jpg/coverage.jpg)

![WebP export](contents/webp/coverage.webp)

![A small loading indicator](contents/gif/activity.gif)

An SVG's `<title>` and `<desc>` name and describe the figure. SVG files saved from draw\.io, including editable `.drawio.svg`, are accepted as they are. The SVG and PNG above have dark [theme variants](contents/md/variants.md).

## Video

![A three-step document workflow](contents/mp4/workflow.mp4)

![The same workflow in WebM](contents/webm/workflow.webm)

## HTML

An HTML fragment is isolated from the page layout and can carry its own styles and controls. A leading comment names it:

```html
<!--fig
title: Release note
desc: A responsive release note with feature cards.
-->
```

![Release note](contents/html/note.html)

## PDF

![Two-page team meeting notes](contents/pdf/meeting-notes.pdf)

## DXF

![Dimensioned mounting plate with top and section views](contents/dxf/mounting-plate.dxf)

A link to a visual file opens its preview: [open the drawing](contents/dxf/mounting-plate.dxf).
