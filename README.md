# Documentation tools that extend Markdown

# Usage
```sh
pnpm exec document-system edit [root] [port]        # viewer
pnpm exec document-system export json [root] [out]  # full docs.json set (<root>/dist/artifact/)
pnpm exec document-system export zip  [root] [out]  # zip of the content (<root>/dist/<root name>.zip)
pnpm exec document-system export html [root] [out]  # single HTML file with everything embedded (<root>/dist/index.html)
pnpm exec document-system mcp [root]                # stdio MCP server (all read / write operations)

# Layout operations (--root <dir> sets the docs root; defaults to cwd)
pnpm exec document-system doc ls
pnpm exec document-system doc add    <id> [--title <t>] [--parent <id>]
pnpm exec document-system doc move   <id> [--parent <id>] [--index <n>]  # omit parent = top level
pnpm exec document-system doc rename <id> <newId>                        # doc: links are updated too
pnpm exec document-system doc delete <id> [--force]
pnpm exec document-system figure ls
pnpm exec document-system figure add    <file> [--name <name>]
pnpm exec document-system figure delete <name> [--force]
```

Registering the MCP server (Claude Code):

```sh
claude mcp add docs -- pnpm exec document-system mcp /path/to/root
```

tool: `list_docs` `search_docs` `read_doc` `read_figure` `check` `add_doc` `write_doc` `move_doc` `rename_doc` `delete_doc` `add_figure` `delete_figure`


Embedding external files with preview rules
```
:::figure(filepath.png, webp, jpeg, svg, etc.)[caption]
:::html(filepath)
```

```md
:::textfile(examples/filename.tdl)
```

`textfile` reads a UTF-8 file relative to the docs root and displays its contents in a
transparent frame with the filename on the top-right border, without a separate header row.
Write the directive on a single line.
Highlighting follows the filename extension (for example `.ts`, `.py`, or a registered
`.tdl` grammar); unregistered extensions render as plain text. Local files must stay inside
the docs root. In the editor, use the disclosure control beside the directive to edit and save
the file. A missing path opens a new file; “Create file” also creates its parent folders.
Open, validate/format, save, and reload controls sit beside the directive. Save uses
Ctrl/Cmd+S; validate/format uses Shift+Alt+F and the same language registrations under
`.document-system/editor-tools/` as Markdown code blocks (for example `rust.json`).
Formatting stays in the file draft until saved. Both editors use the preview’s syntax colors.
Markdown and local file drafts update the preview while typing, without saving the draft.
External saves, replacements, deletion and recreation of referenced local files are detected
automatically. The editor's top-right indicator shows a spinner while updating, ✓ when current,
and ! when rendering fails; a failed update keeps the last valid preview (hover ! for details).
Conflicts show both versions and let you choose “Use my edits”, “Use external changes”, or
cancel and keep editing. Choosing your edits saves them only if the external version has not
changed again.

Append a range to display an excerpt:

```md
:::textfile(filepath.ext)[1,3]
:::textfile(filepath.ext)[1,*]
:::textfile(filepath.ext)[1:5, 7:3]
:::textfile(filepath.ext)["AAAA", "BBB"]
:::textfile(filepath.ext)["aaa", *]
```

Line and column numbers start at 1, and both endpoints are included. Columns count Unicode
code points. `*` means the file boundary (the beginning for a start, the end for an end).
Quoted strings match exactly, including case: the first start match and the first end match
after it are included. Escape quotes and backslashes as in JSON. Numbers, positions, strings,
and `*` can be mixed. Missing matches, invalid positions, and reversed ranges are errors.
Ranges affect preview and exported excerpts; the expanded editor and source ZIP keep the full local file.
Hover over the frame to see the original path/URL and range directive.

HTTP(S) file URLs can be used directly. GitHub file-page URLs also work. For a public Git
repository, add `#ref:path/to/file` (a repository URL and branch alone do not identify a file):

```md
:::textfile(https://example.com/src/hello.rs)[2,3]
:::textfile(https://github.com/owner/repo/blob/main/src/hello.rs)
:::textfile(https://example.com/repo.git#main:src/hello.rs)["fn main", *]
```

Remote files are read-only in the expanded editor. Reads are cached for one minute;
“Reload file” fetches immediately. Remote text is limited to 2 MiB with a fetch timeout,
and `.git` sources require Git to be installed. URLs with embedded credentials are rejected.
Compiled JSON/HTML includes the fetched excerpt; source ZIPs preserve the URL without
bundling remote files. Missing files and failed remote requests show a compact placeholder
without preventing the rest of the document or its export from rendering.

```
:::graph[caption]
[a]: A
[b]: B
[a] -> [b]
:::
```

```md
:::schema[caption]
users:
  id: pk
  team_id: fk(teams)
teams:
  id: pk
:::
```

```md
:::callout[caption]
- <item>
:::
```

```md
:::term(<id>)
name: "<name>"
definition: "<definition>"
description: "<description>" # optional
:::

Inline reference: :::term(<id>)
```



# Folder structure

```
<root>/
  docs.config.mjs    # optional: default language + language adapters (see Languages)
  manifest.yaml     # doc hierarchy and order
  content/
    <id>.md          # body. file name = doc id (URL /<id>, link doc:<id>)
  figures/
    <name>.svg | <name>.drawio.svg | <name>.png | <name>.webp | <name>.jpg | <name>.html

src/
  core/        # package export
  compiler/
  viewer/
sample-content/
```



