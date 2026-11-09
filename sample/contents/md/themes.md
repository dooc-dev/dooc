---
title: "Themes and file variants"
---

The document theme is independent of the editor theme. Use split view to show this page in light and dark at the same time.

## The same link, two assets

![A theme-aware workflow](contents/svg/workflow.svg)

![A theme-aware report](contents/png/coverage.png)

## Text can vary too

![](contents/txt/palette.txt)

## File layout

Keep a default file at its normal path. Mirror that path under `themes/light/` or `themes/dark/` to provide an alternative.

```text
contents/images/coverage.png
themes/light/contents/images/coverage.png
themes/dark/contents/images/coverage.png

contents/themes/palette.txt
themes/light/contents/themes/palette.txt
themes/dark/contents/themes/palette.txt
```

A missing variant falls back to the original file. This convention works for embedded local files, including binary images, HTML, code, data, and diagram sources. Variants stay in source exports and standalone HTML.

Theme names are directory keys. Light and dark are the built-in choices; extra named variants can use the same path convention without changing document links.
