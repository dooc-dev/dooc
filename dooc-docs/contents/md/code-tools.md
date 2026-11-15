The validation button or **Shift+Alt+F** formats and checks the whole current Markdown page, regardless of cursor position. It handles Markdown and configured, closed code fences, including fences inside lists and block quotes. dooc directives and unconfigured code remain intact; JSON has built-in formatting and validation. Text-file editors use the same registered tools for their language.

Formatting is undoable. Hover an underlined diagnostic to read it. If the edited text or target changes while a tool is running, its result is discarded. Error diagnostics prevent formatting changes; successful formatting is checked again before it is applied. Enable **Auto validate** to run validation after edits. The validation button is green after success, red for errors, muted when pending, and blue while checking.

Sessions opened with `--repo` disable configured external formatters and linters, including manual requests. Editing, saving, and built-in Markdown and JSON formatting and validation remain available. See [Git repositories](contents/md/cli.md#git-repositories) for the scope of executable configuration in remote sessions.

## Configure a language

Put the configuration beside the manifest in `.dooc/editor-tools/<language>.json`. The filename must match the code fence's language exactly: `js` and `javascript` are separate configurations. Changes take effect on the next run.

For example, `.dooc/editor-tools/typescript.json`:

```json
{
  "formatter": ["pnpm", "exec", "prettier", "--stdin-filepath", "example.ts"],
  "linter": ["node", ".dooc/editor-tools/check-typescript.mjs"]
}
```

Either command may be omitted. Install the tools in the document project's environment. Each command is an executable and argument array, runs from the manifest's directory, and receives the code body with a trailing newline on standard input. There is no shell expansion or temporary file; pass a filename hint such as `--stdin-filepath` when required. Commands have a 10-second timeout and a 1 MiB output limit. They run with the local user's permissions, so use trusted configurations and scripts.

The formatter must exit with code `0` and write only the formatted code to standard output. Empty output that would erase nonempty code, or output that would close the Markdown fence, is rejected.

## Linter diagnostics

The linter must exit with code `0` or `1` and write a JSON array to standard output. Return `[]` when there are no findings; send other logs to standard error. Adapt tools such as ESLint to this contract:

```json
[
  {
    "message": "Unused variable",
    "severity": "warning",
    "line": 1,
    "column": 7,
    "endLine": 1,
    "endColumn": 8
  }
]
```

Positions are one-based within the code body. Columns count UTF-16 code units, and the end position is exclusive. Omit `endLine` and `endColumn` together for a one-character range. Severity is `error`, `warning`, or `info`, with `warning` as the default. Invalid positions or malformed diagnostics reject the result.

Tool configuration and adapters are included in source exports. External command execution is available only through a Node editing workspace, not browser storage, read-only viewing, or published HTML. The combined editor requires same-origin requests through `localhost`, `127.0.0.1`, or `[::1]`; the separate workspace server uses its configured client origin. Syntax highlighting remains independent of these tools. LSP connections and running these tools during builds are not supported.
