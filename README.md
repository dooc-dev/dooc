# dooc
dooc is an orchestration tool for documentation.

1. Create documentation resources.
2. Build an interface for those resources.
3. Distribute documentation everywhere.

# Usage
```sh
pnpm exec dooc edit [root] [port]				 	# open dooc in edit mode 
pnpm exec dooc view [root] [port]					# open dooc in view mode 
pnpm exec dooc export zip  [root] [out]   # zip of the content (<root>/dist/<root name>.zip)
pnpm exec dooc export html [root] [out]   # single HTML file with everything embedded (<root>/dist/index.html)
pnpm exec dooc mcp [root]                 # stdio MCP server (all read / write operations)
```

Registering the MCP server (Claude Code):

```sh
claude mcp add docs -- pnpm exec dooc mcp /path/to/root
```

tool: `list_docs` `search_docs` `read_doc` `read_figure` `check` `add_doc` `write_doc` `move_doc` `rename_doc` `delete_doc` `add_figure` `delete_figure`

# Folder structure


