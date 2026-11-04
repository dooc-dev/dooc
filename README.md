# dooc

Documentation tools that extend Markdown

# Usage
```sh
pnpm exec dooc edit [root] [port]        # viewer
pnpm exec dooc export json [root] [out]  # full docs.json set (<root>/dist/artifact/)
pnpm exec dooc export zip  [root] [out]  # zip of the content (<root>/dist/<root name>.zip)
pnpm exec dooc export html [root] [out]  # single HTML file with everything embedded (<root>/dist/index.html)
pnpm exec dooc mcp [root]                # stdio MCP server (all read / write operations)

# Layout operations (--root <dir> sets the docs root; defaults to cwd)
pnpm exec dooc doc ls
pnpm exec dooc doc add    <id> [--title <t>] [--parent <id>]
pnpm exec dooc doc move   <id> [--parent <id>] [--index <n>]  # omit parent = top level
pnpm exec dooc doc rename <id> <newId>                        # doc: links are updated too
pnpm exec dooc doc delete <id> [--force]
pnpm exec dooc figure ls
pnpm exec dooc figure add    <file> [--name <name>]
pnpm exec dooc figure delete <name> [--force]
```

Registering the MCP server (Claude Code):

```sh
claude mcp add docs -- pnpm exec dooc mcp /path/to/root
```

tool: `list_docs` `search_docs` `read_doc` `read_figure` `check` `add_doc` `write_doc` `move_doc` `rename_doc` `delete_doc` `add_figure` `delete_figure`


Embedding external files with preview rules
```
:::figure(filepath.png, webp, jpeg, svg, etc.)[caption]
:::html(filepath)
```

```md
:::textfile(examples/filename.rs)
```

```md
:::textfile(filepath.ext)[1,3]
:::textfile(filepath.ext)[1,*]
:::textfile(filepath.ext)[1:5, 7:3]
:::textfile(filepath.ext)["AAAA", "BBB"]
:::textfile(filepath.ext)["aaa", *]
```


```md
:::textfile(https://example.com/src/hello.rs)[2,3]
:::textfile(https://github.com/owner/repo/blob/main/src/hello.rs)
:::textfile(https://example.com/repo.git#main:src/hello.rs)["fn main", *]
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



