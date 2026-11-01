# Documentation tools that extend Markdown

# Usage

The package name is `@sasaki-s-sci/document-system` and the CLI name is `document-system`. The examples below use a locally installed package.

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
:::dictionary
- term: "<term>"
  definition: "<definition>"
:::
```



# Folder structure

```
<root>/
  docs.config.mjs    # optional: default language + language adapters (see Languages)
  content/
    manifest.yaml    # doc hierarchy and order (see below)
    <id>.md          # body. file name = doc id (URL /<id>, link doc:<id>)
  figures/
    <name>.svg | <name>.drawio.svg | <name>.png | <name>.webp | <name>.jpg | <name>.html

src/
  core/        # package export
  compiler/
  viewer/
sample-content/
```



