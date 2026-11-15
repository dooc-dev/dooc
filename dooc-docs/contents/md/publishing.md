Choose whether the recipient needs a document snapshot, editable source or a live workspace. Saving in the editor writes source files; it does not publish them.

## Choose an output

| Recipient needs | Use | Result |
| --- | --- | --- |
| A document to read | `dooc build html` | `dist/bundle.html` |
| Editable source with captured remote embeds | `dooc build zip` | `dist/bundle.zip` |
| The source files as authored | `dooc export` | `dist/bundle.zip`; remote references stay URLs |
| A live editing or viewing application | [App runtimes](contents/md/runtimes.md) | Application assets and selected runtime components |
| Agent access to a workspace | `dooc mcp`, or [Web MCP connections](contents/md/web-mcp.md) | An MCP connection with the selected access mode |

## Review before sharing

1. Save pending editor changes.
2. Run `dooc check` and fix local content errors.
3. Build the artifact with the URL behavior you intend.
4. Open the output and review navigation, diagrams, records and external dependencies.
5. Share the accepted artifact or hand it to your hosting process.

```sh
dooc check dooc.yaml
dooc build html dooc.yaml dist
```

The build commands create files; they do not deploy a site. Use [CI/CD](contents/md/ci.md) to repeat the validation and artifact steps in a pipeline.

## Decide how remote content behaves

| Choice | Behavior | Suitable for |
| --- | --- | --- |
| Default `--url_preview embed` | Capture supported remote embeds during the build | A portable snapshot |
| `--url_preview network` | Keep remote references and fetch them when opened | Content that should stay connected |
| HTML `--mode live --auth external` | Keep plugin requests live with a host-provided transport | An integrated application with authentication supplied by its host |

Ordinary links remain links. Remote capture has download limits and does not execute a source site's JavaScript or sign in. Network-mode text embeds need the remote server's CORS permission. See [Build output](contents/md/cli.md#build-output) for exact constraints and failure behavior.

## Integrate a service or agent

Use [Plugins](contents/md/plugins.md) for service cards inside pages, and [Write a plugin](contents/md/plugin-dev.md) for the plugin contract. Use [Web MCP and Desktop connections](contents/md/web-mcp.md) to connect an agent to an open browser workspace.

These are different connections: a plugin supplies content from a service, while MCP exposes selected workspace operations to a client. A standalone document does not acquire either connection merely because it was built from an editable workspace.
