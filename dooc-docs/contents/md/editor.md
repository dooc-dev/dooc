`dooc edit` opens the workspace in a browser with editing on. `dooc view` opens the same pages read-only. Both serve `http://localhost:5179` unless a port is given.

## Layout

| Area            | Holds                                                                 |
| --------------- | --------------------------------------------------------------------- |
| Document tree   | Pages and boards from `center_contents`; add, rename, move, set icons |
| Workspace tools | Files, Library, Subformats, Plugins, Git, History                     |
| Document pane   | The page, with source and preview side by side while editing          |
| Split view      | A second pane with its own page, language, and theme                  |

The editing sidebar header places the language control on the left, the workspace and branch selector in the center, and **Open a workspace** (the folder button) on the right. The folder button opens a local folder, browser workspace, Git clone, or server connection for the active pane.

Tree edits rewrite `dooc.yaml`, and hand edits to `dooc.yaml` show up in the tree. Renaming a file updates the links that point to it.

## Workspace tools

| Tool       | Use it to                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------- |
| Files      | Browse, upload, rename, and reorganize files; copy a path to embed                          |
| Library    | List every block, code fence, URL, and term in the workspace, with where it is used         |
| Subformats | Open [record boards](contents/md/subformats.md), add a record type, edit its schema         |
| Plugins    | Add, enable, and sign in to [plugins](contents/md/plugins.md)                               |
| Git        | Stage, commit, switch branch, fetch, pull, push; open pull requests with an origin provider |
| History    | Save a snapshot with a message, and restore every file to one                               |

A Library view can also be a page in the tree: see `library` in [dooc.yaml](contents/md/manifest.md). **Terms** at the bottom of this tree is one.

## Editing

| Action                 | How                                                 |
| ---------------------- | --------------------------------------------------- |
| Save                   | **Ctrl+S**, or leave **Auto save** on               |
| Format and validate    | **Shift+Alt+F**, or the validation button          |
| Search pages and files | **Ctrl+F**                                          |
| Insert a file          | Upload or pick it in **Files**; an embed is written |
| Add a translation      | **Add translation** in the language menu            |
| Switch theme           | **Theme**: Auto, Light, Dark; per pane              |
| Change fonts           | **Editor font**, **Viewer font**; per browser tab   |
| Edit a record          | Form, or the record's YAML, JSON, or TOML text      |
| Edit a schema          | Field builder, or JSON text                         |

Errors appear while you type and never block saving a page. A file changed outside the editor is reloaded; if both sides changed, you choose which edits to keep. Leaving an unsaved record or schema form prompts before discarding its changes.

**Auto save** starts on; **Auto validate** starts off. Both settings retain your choice. The save button is green after saving, orange for pending manual changes, and red after an error. Wait for a successful save before closing the page.

## Workspaces and branches

Open the branch selector to visit another branch or choose **Create branch**. Labels use `branch/workspace`; long labels shorten with `...`, and hovering shows the full name. The active pane's label is underlined. Git changes determine the text color: added or untracked files are green, modifications orange, and deletions red.

A branch must contain the selected manifest at the same repository path. Unavailable branches remain visible in red with an information icon; hover or keyboard focus explains why they cannot be selected. **Create branch** is disabled until the manifest is committed in `HEAD`. Enter a valid Git branch name in its dialog to create a branch from the latest commit. Unsaved edits stay in the original workspace.

Split view shows two branch selectors in preview-pane order. Choosing a branch in either selector affects only its pane; clicking a preview pane makes its navigation and editing context active. Switching back restores that pane's draft and undo history, including unsaved form edits. Drafts, pull-request drafts, and commit messages stay with their workspace while the page remains open; save document changes before closing it.

Each branch reuses its existing workspace. Node workspaces use existing Git worktrees or create persistent worktrees under the repository's Git metadata in `dooc-worktrees`. Browser branches use separate persisted repository copies. Opening another branch does not stash or discard the original workspace's changes, and closing the page does not delete these workspaces.

## Separate server and client

`dooc edit` serves the editor and its workspace together. You can also run the Node workspace service and static editor independently:

```sh
dooc server ./dooc.yaml 5179 --client-origin http://localhost:5180
dooc client 5180 --server ws://localhost:5179/api/workspace
```

Open `http://localhost:5180`. The server exposes only `/api/workspace` over WebSocket; it serves no HTML or assets. The client serves static files and has no filesystem or Git API of its own. Both commands bind to loopback. The server accepts exactly the configured browser origin, including its port: use `localhost` consistently, or configure `127.0.0.1` explicitly.

To deploy the editor on a static host:

```sh
dooc build client ./public-editor
dooc build client ./public-editor --server wss://workspace.example/api/workspace
```

The second command preconfigures an optional server connection in `dooc-client.json`; this file contains no credentials. Serve the output at the host's root, with document routes falling back to `index.html`. Missing `/assets/*` and `/api/*` requests must remain 404s. Building needs dooc but no manifest; hosting the generated files needs no Node process. An HTTPS client needs a secure WebSocket endpoint. A reverse proxy must preserve the browser's `Origin` and send a loopback `Host` header to the workspace server. Hosting-specific deployment configuration is not included.

## Editing in the browser

The workspace chooser supports **Local folder**, **New browser workspace**, **Saved browser workspace**, and **Clone Git repository**, without a Node workspace server.

Local folders require explicit browser read/write permission and support for `showDirectoryPicker`. Select the repository folder containing `.git`; specify the manifest path when it is in a subdirectory. Files save directly to that folder. Linked Git worktrees and symbolic links require the Node server.

New and cloned browser workspaces persist in origin-private storage. Reopen them through **Saved browser workspace** after a reload. Clearing site data removes that storage, so push commits or download files you need to keep elsewhere. A browser workspace has a 128 MiB working limit, including Git objects. External file changes are checked before writes; failed saves report an error.

Browser Git supports stage, unstage, diff, commit, fetch, fast-forward pull, push, and GitHub pull requests. Enter an author name and email for commits. Remotes must accept browser CORS requests or use a Git CORS proxy that you explicitly configure. GitHub's Git transport needs a proxy; its pull-request REST API is used directly. A proxy can receive repository data and credentials, so choose one you control or trust. Tokens remain in memory until the page closes and are not stored with saved workspaces or exports.

SSH remotes, stashes, and external formatting or lint commands require the Node server. Plugins whose server capabilities are unavailable keep their source links in the browser editor.

For Node workspaces, Git uses the system credential helper. GitHub pull-request operations use GitHub CLI (`gh auth login`), unless an origin plugin supplies another provider. The pull-request view includes open, closed, and merged requests. Creation requires pushing the current commit first; merging includes the reviewed head commit and respects GitHub branch protections. Editing a file alone never starts a remote operation.

## History

| Workspace               | A snapshot is                                     |
| ----------------------- | ------------------------------------------------- |
| Inside a Git repository | A commit of everything under the workspace folder |
| Not under Git           | A copy of the files under `.dooc/snapshots/`      |

Undo and redo inside the editor are separate from snapshots and cover recent typing.

## Edit together

```sh
dooc edit --shared main
```

| Behaviour     | Detail                                                                   |
| ------------- | ------------------------------------------------------------------------ |
| Identity      | Each person enters a name once; it is not authentication                 |
| Snapshots     | Recorded only on the named branch, with every editor as `Co-authored-by` |
| Auto snapshot | Pending edits are saved as a snapshot a few minutes after the last edit  |
| Git           | Branch switching is hidden so everyone stays on the shared branch        |

TLS is available for the combined editor:

```sh
dooc edit --shared main --tls-cert cert.pem --tls-key key.pem
```

`DOOC_TLS_CERT` and `DOOC_TLS_KEY` set the same files. The listener still binds to loopback; TLS does not expose it to other machines. Editing requests require a local host and the matching browser origin. The entered name identifies contributions and does not authenticate a remote connection.

## Code tools

The validation button or **Shift+Alt+F** formats and checks the whole current Markdown page, regardless of cursor position. It handles Markdown and configured, closed code fences, including fences inside lists and block quotes. dooc directives and unconfigured code remain intact; JSON has built-in formatting and validation. Text-file editors use the same registered tools for their language.

Formatting is undoable. Hover an underlined diagnostic to read it. If the edited text or target changes while a tool is running, its result is discarded. Error diagnostics prevent formatting changes; successful formatting is checked again before it is applied. Enable **Auto validate** to run validation after edits. The validation button is green after success, red for errors, muted when pending, and blue while checking.

### Configure a language

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

### Linter diagnostics

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
