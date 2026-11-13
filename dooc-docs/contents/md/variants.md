A file can have a copy per theme and a page can have a copy per language. The copy sits at the same relative path under a prefix folder. Links and embeds never change.

| Variant     | Path                            | Applies to              | Fallback          |
| ----------- | ------------------------------- | ----------------------- | ----------------- |
| Theme       | `themes/<theme>/<path>`         | Any embedded local file | The original file |
| Translation | `locales/<ISO 639-3>/<path>.md` | Pages                   | The source page   |

## Themes

`light` and `dark` are the built-in themes. Each document pane has its own theme picker; use split view to see both at once.

```text
contents/svg/workflow.svg
themes/dark/contents/svg/workflow.svg
```

An image:

![A theme-aware workflow](contents/svg/workflow.svg)

![A theme-aware report](contents/png/coverage.png)

A text file:

![](contents/txt/palette.txt)

A diagram source:

![](contents/mermaid/review.mermaid)

The site icon takes one file per theme in `left_sidebar.icon`.

![The dooc icon](contents/svg/_site.svg)

## Languages

```text
contents/md/variants.md
locales/jpn/contents/md/variants.md
```

The translated file is an ordinary page. Adding a language to a page in the editor creates this file from the source page.

Declare the offered languages and themes in `dooc.yaml` to have `dooc check` require them:

```yaml
system:
  default_lang: eng
  languages: [eng, jpn]
  themes: [light, dark]
```

Without the declaration, languages are discovered from the folders under `locales/`. This workspace ships no translation.
