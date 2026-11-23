`dooc.yaml` defines a document and its children, record types, and display settings. Every local path in it is relative to its own folder. A named manifest, `<name>.dooc.yaml`, works the same way. Unknown keys are errors.

## Document tree

Every manifest has one root `document`. Each child wraps another `document` with the same structure. `children` belongs inside its document; there is no separate `center_contents` section.

```yaml
document:
  title: Handbook
  url: ""
  children:
    - document:
        title: Guide
        url: guide.md
        children:
          - document:
              title: Install
              url: install.md
    - document:
        title: Reference
        url: reference/dooc.yaml
    - document:
        title: Website
        url: https://example.com
```

The root owns `/`. Its file name never adds a URL segment to its children. A document with no `url`, an empty string, or an empty YAML value shows an automatically generated table of contents for its immediate children. This also works for an empty workspace. Opening `/` does not implicitly redirect to the first page.

| `document.url` | Behavior |
| --- | --- |
| Omitted, `""`, or `null` | Generate a table of contents |
| `contents/md/guide.md` | Render a local Markdown file |
| `contents/pdf/guide.pdf` | Open a local file with its usual previewer |
| `reference/dooc.yaml` | Include that manifest's root and children |
| `https://github.com/team/docs/blob/main/reference/dooc.yaml` | Include a Git-hosted manifest and its referenced files; GitHub raw URLs work too |
| `https://git.example.com/team/docs.git#main:reference/dooc.yaml` | Include a manifest at an explicit Git branch, tag, or commit |
| `https://example.com` | Show the website inside dooc; HTTP is also accepted |
| `/guide/install` | Navigate directly to a page in this site; queries and heading fragments are allowed |
| `redirect:first` | Redirect to the first immediate child; a child is required |

`url` identifies what to open, not an override for the document's own public path. Local Markdown paths are plain paths, external links have an HTTP(S) scheme, and site links begin with a single `/`. Unsupported schemes, credentials, paths outside the workspace, include cycles, and redirect cycles are errors.

An included manifest keeps its own file. Its relative content paths and Markdown references are resolved from its folder, and its root is mounted at the including document's position. For example, `reference/dooc.yaml` owns `/reference`, and its `install.md` child owns `/reference/install`. A named manifest uses its name instead of the containing folder. Includes cannot also declare inline `children`.

The selected manifest controls workspace settings such as offered languages and themes. Included record types must not conflict with the workspace's existing definitions.

Locally included Markdown pages remain editable. Change their tree structure in the child manifest; the parent sidebar does not move or delete included pages.

Remote Git manifests are read-only in the including workspace. Their Markdown, images, schemas, translations, and nested manifests resolve relative to the remote manifest. The workspace keeps referenced sources under `dooc-imports/`, and source exports include these files. Edit the source repository to change remote content. Public HTTPS sources are supported; embedded credentials, private network addresses, and remote include cycles are rejected. Browser Git access requires a remote that permits browser requests or the Git CORS proxy explicitly configured for that workspace.

Remote branch and tag references are resolved once for a server process or browser worker. Restart the server or reopen the browser workspace to refresh them; use a commit reference for reproducible content. A remote manifest at the repository root uses the repository name as its section URL. Named manifests and manifests in subfolders use the same names as local includes.

Each section uses the version configuration and history of the manifest that provides it, including remote Git sections. See [Document versions](contents/md/version.md).

### Clicks and link titles

The reader chooses how to open an entry. There is no author-defined `mode` setting.

- A regular click opens the content inside dooc: Markdown as a page, a local file in its previewer, an included document as its section, and a Web URL in an iframe. On desktop and mobile, the iframe fills the central pane without surrounding margins, borders, a URL bar or document controls.
- A middle click or Ctrl/Cmd-click opens a new tab. For Web URLs, that tab opens the original website directly.
- A confirmed framing refusal asks **Open externally?**. **Open externally** opens the website in a new tab; **Cancel** keeps the preview and its external-opening action. Node workspaces also check public HTTPS response headers for explicit framing denials. Loading, timeouts and network errors do not show the external-opening action. Browsers can hide cross-origin framing failures, and header checks cannot resolve every policy or redirect; middle-click or Ctrl/Cmd-click the sidebar entry to open the original website in that case.

Sidebar rows and generated contents cards identify links through the title: entries that open an included document, an HTTP(S) website, another site page, or `redirect:first` use an underlined title in the link color. Ordinary Markdown, local files and generated contents keep their normal title styling. There are no destination badges, auxiliary icons, or type/extension labels. Existing page artwork remains unchanged. A Git-hosted `dooc.yaml` opens as an included document, not a Web preview.

Static HTML exports remain offline: Web pages ask before opening the website externally. Network-enabled HTML exports can show Web pages in iframes.

The [Version specification](contents/md/version.md) describes the `version` setting, automatic numbering, and reader publication selectors.

### Planned manifest authorization

**Status: Planned; not implemented.** Server-hosted dooc will support additional authorization when `document.url` resolves to another `dooc.yaml` or `<name>.dooc.yaml`. This includes local child manifests and supported remote manifest sources. Access to the selected root manifest remains subject to the host's existing access policy; opening the root does not automatically authorize a protected child.

This feature applies only to manifest connections. Ordinary Web URLs, iframe previews, local file previews and Markdown links do not acquire a new authentication option. Web destinations retain their own login flow and sessions. A manifest connection uses data requests controlled by dooc, so the server can handle credentials, authorization challenges and retries explicitly. An iframe or normal browser navigation cannot accept arbitrary authorization headers from the parent page; cross-origin communication requires cooperation from the destination. See [same-origin restrictions](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).

The server owns the policy for each resolved target manifest and the integration with its authentication provider. Document files do not supply executable authentication handlers, secrets or arbitrary credential destinations. This decision introduces no new YAML keys or public authentication API; the provider and host configuration remain to be designed.

The intended flow is:

1. Before authorization, show the parent-authored entry title and a locked state. Do not expose the child's contents or descendants through the parent page.
2. On entry, the server checks the user's root access and target policy. It returns **allow**, **challenge** or **deny**. A challenge requests the additional authentication needed; deny means the user lacks access.
3. After successful authentication, the server checks authorization again and opens the requested child page. An existing valid grant can be reused for that session and target until it expires or is revoked.

Permission to read a document and the strength or freshness of a user's authentication are separate checks. Reauthentication or MFA can satisfy a challenge without granting a missing permission. [RFC 9470](https://www.rfc-editor.org/rfc/rfc9470.html) describes step-up authentication challenges.

For a child on the same server, the grant can stay in the server session. A remote source requires credentials accepted by that destination, limited to that destination and the required access. Never forward the root session cookie or bearer token to an arbitrary manifest URL or redirect. The current remote importer supports public Git sources only; authenticated remote retrieval still needs implementation.

The target manifest defines an access boundary for its contents, including nested documents and their assets. The server must enforce it on direct URLs, search, previews, file and record operations, attachments, version history, MCP and export requests. Alternate links to the same protected source must not bypass the policy, and nested includes must retain their parent restrictions. Shared caches and change notifications must not disclose protected content or reuse another user's authorization. The existing eager manifest expansion must respect this boundary before returning data to a client.

Browser-only workspaces and standalone HTML or ZIP files cannot enforce this server policy. Exporting protected content requires an explicit server-side policy because the resulting artifact cannot preserve the runtime access boundary. A source that is publicly accessible at its original URL also remains publicly accessible outside dooc.

Implementation is tracked as **Manifest step-up authorization** in **Development → Feature gaps**.

## Keys

| Key                           | Value                                                      |
| ----------------------------- | ---------------------------------------------------------- |
| `system.default_lang`         | Language tag of the source pages; `en` when omitted        |
| `system.languages`            | Offered languages; must include the default                |
| `system.themes`               | Offered themes: `light`, `dark`                            |
| `system.licence`              | Local licence file, included in source exports             |
| `system.files.default_layout` | Layout option of the file card                             |
| `document`                    | Required root document                                    |
| `document.sidebar.title`      | Site title per language; must include the default language |
| `document.sidebar.icon`       | `light` and `dark` SVG files                               |
| `json_subformats`             | Record types                                               |
| `default_subformat_folder`    | Folder scanned for records and used by **Create**          |

## Page tree entries

| Entry        | Keys                                                |
| ------------ | --------------------------------------------------- |
| Page         | `url`, `title`, `icon`, `children`                 |
| Record board | `subformat` (an `ext`), `title`, `icon`, `children` |
| Library page | `library` (a view), `title`, `icon`, `children`     |

Every entry above is the value of a `document` key, including boards and Library pages. `url`, `subformat`, and `library` are alternative content sources. `title` is the page name in navigation and browser tabs; a Markdown page without one uses its file name. It is not added to the page body: write headings in the content itself. `icon` is a local SVG file shown beside the entry in the tree. It is drawn as an image, so give it fixed colours that read on both themes; `currentColor` does not follow the theme. A board without an `icon` uses the icon of its record type. The root's `sidebar` holds the site's sidebar settings; its title defaults to the root document title.

A Library page lists one kind of content from the whole workspace. Its view is a block label (`callouth`, `graphth`, `schemath`, `termth`, `mermaid`, `csv`, `tsv`), `urls`, or `url-previews`.

## Page URLs

URLs follow the `document.children` hierarchy. Each Markdown page uses its file name without `.md`: `contents/md/start.md` directly under the root is `/start`, and the same page under `contents/md/guide.md` is `/guide/start`. Source folders and the `_docs` prefix are not part of the URL. Changing a Markdown page's display title does not change its URL. Generated pages and links use their title as the URL segment, or `page-N` when untitled. URL segments are percent-encoded.

Library pages use their `library` value, and record boards use their `subformat` value. For example, `library: termth` under `reference.md` is `/reference/termth`.

Other local files keep their full file name as the URL segment: `contents/pdf/guide.pdf` directly under the root is `/guide.pdf`.

Sibling pages must have distinct URL names. Top-level names starting with `_`, plus `api` and `assets`, are reserved for application routes. Language and version remain query parameters, such as `/start?lang=eng&version=1.0.0`. The app adds its hosting prefix, such as `/client`, when needed.

## Record type entries

| Key                  | Value                           |
| -------------------- | ------------------------------- |
| `ext`                | File extension without the dot  |
| `format`             | `yaml`, `json`, or `toml`       |
| `schema`             | Local JSON Schema path          |
| `icon`               | Local SVG file for the type     |
| `layouts.card_title` | Field shown as the card heading |
| `layouts.group_by`   | Enum field used for columns     |
| `layouts.sort_by`    | Field used for ordering         |
| `layouts.sort_order` | `asc` or `desc`                 |

## This workspace

![](dooc.yaml)

The editor rewrites this file when pages are added, moved, or renamed, so hand edits and tree edits are interchangeable.

Older `center_contents` lists and `file` entries remain readable. To migrate, move the list to `document.children`, wrap each entry in `document`, replace `file` with `url`, and move `left_sidebar` to `document.sidebar`. Choose the root's content explicitly, or leave its `url` empty for a table of contents. Moving an existing `index.md` page to the root changes its old `/index` URL and any `/index/...` descendants; update links to those public paths as part of that migration.

## Files beside it

| Path                             | Purpose                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `themes/<theme>/…`               | [Theme variants](contents/md/variants.md)                                    |
| `locales/<lang>/…`               | [Translations](contents/md/variants.md)                                      |
| `.dooc/fonts/`                   | Project fonts, managed with `dooc font`                                      |
| `.dooc/plugins/`                 | Installed [plugin](contents/md/plugins.md) ZIPs                              |
| `.dooc/snapshots/`               | [History](contents/md/workspaces.md#history) when the workspace is not under Git |
| `.dooc/code-languages/`          | Extra TextMate grammars for code highlighting                                |
| `.dooc/editor-tools/<lang>.json` | Formatter and linter commands for code fences                                |
| `docs.config.mjs`                | Language adapters for term matching and prose linting                        |

When `edit` or `view` opens a repository with `--repo`, these files are retained, but `docs.config.mjs` is not loaded, external editor-tool commands do not run, and workspace plugin ZIPs cannot be activated. Built-in JSON tools and syntax highlighting remain available. Open a trusted local checkout without `--repo` to use its executable configuration; an explicitly selected local `--reader-plugins` module also works in a remote session. See [Git repositories](contents/md/cli.md#git-repositories) and [Code tools](contents/md/code-tools.md).

Folder names such as `contents/md/` are a convention. Only the paths written in `dooc.yaml`, links, and embeds matter.

An editor tool configuration, for example `.dooc/editor-tools/typescript.json`:

```json
{
  "formatter": ["pnpm", "exec", "prettier", "--stdin-filepath", "example.ts"],
  "linter": ["node", ".dooc/editor-tools/check-typescript.mjs"]
}
```
