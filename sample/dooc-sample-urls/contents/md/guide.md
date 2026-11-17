This gallery contains every supported kind of `document.url`. Open the sidebar title to return to its generated contents. Underlined titles in the link color lead to another document, page or website; ordinary content titles keep their normal styling.

## URL examples

| Sidebar entry | Authored URL | What opens |
| --- | --- | --- |
| How to use this gallery | `contents/md/guide.md` | This Markdown page |
| Automatic contents | Omitted, `""`, or `null` | The immediate children as contents cards |
| File previews | `.txt`, `.csv`, `.json`, `.html`, `.svg`, `.pdf` paths | The corresponding file preview |
| Local handbook | `sections/handbook/dooc.yaml` | A locally included document with its own children |
| Named reference | `sections/reference.dooc.yaml` | A named document with generated contents |
| Project delivery from GitHub | `https://github.com/dooc-dev/dooc/blob/dooc-v0.0.16/sample/dooc-sample-project/dooc.yaml` | A read-only project document from Git |
| Product reference from Git | `https://github.com/dooc-dev/dooc.git#dooc-v0.0.16:dooc-docs/dooc.yaml` | Product documentation from the same release |
| Example website | `https://example.com` | A Web preview |
| Website that refuses framing | `https://github.com` | The external-opening confirmation when framing is refused |
| Example website over HTTP | `http://example.com` | A Web preview; the browser or site may upgrade or block HTTP |
| Existing page | `/guide` | This page without an intermediate preview |
| Page with language and heading | `/guide?lang=eng#click-behavior` | The click behavior section below |
| First child redirect | `redirect:first` | Its first immediate child |

The local handbook uses version **2.1.0**, the named reference uses **3.0.0**, and this gallery uses **1.0.0**. Opening each section selects its own manifest's version. Remote sections use their source manifest and repository history.

## Click behavior

- Click normally to open a document or file inside dooc. Desktop Web entries use an iframe.
- Middle-click or Ctrl/Cmd-click a Web entry to open the original website in a new tab.
- On a phone, a Web entry asks before opening externally. Cancel keeps the current page.
- If an iframe is refused, confirm **Open externally** or cancel. Browser restrictions can hide some failures; the Web preview always includes an explicit external-opening action.
- The custom SVG icon keeps its original artwork and colors. No auxiliary destination icon is added.

## GitHub raw URL variant

`raw.dooc.yaml` is a separate runnable manifest that uses the raw GitHub spelling of the project source. Open it from the repository root:

```sh
dooc reader run node --client --server --project sample/dooc-sample-urls/raw.dooc.yaml
```

Its root contains:

```yaml
document:
  title: GitHub raw URL
  url: https://raw.githubusercontent.com/dooc-dev/dooc/dooc-v0.0.16/sample/dooc-sample-project/dooc.yaml
```

The separate entry point avoids mounting the same project pages twice in one document tree. All Git examples use the published `dooc-v0.0.16` tag so that future changes to the repository do not change their source.

The first opening needs network access to fetch the Git documents. Source ZIP exports include the referenced remote files. Web previews remain dependent on their original websites; static HTML asks before opening them externally, while network-enabled HTML can embed them.
