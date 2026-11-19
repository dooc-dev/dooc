A workspace is the folder selected by its manifest. Choose a local Node workspace, a browser folder, saved browser storage, or a Git clone according to where the files should live. The active preview pane decides which workspace receives navigation and edits.

| Source | Where changes persist | Start here |
| --- | --- | --- |
| Local Node workspace | Files on the server's filesystem | `dooc editor run node --client --server --project path/to/dooc.yaml` |
| Git clone opened with `--repo` | A saved local clone for editing; a temporary clone for viewing | [Repository commands](contents/md/cli.md#git-repositories) |
| Browser local folder | The folder explicitly permitted by the browser | **Open workspace → Local folder** |
| Browser workspace | This browser origin's private storage | **New browser workspace** or **Saved browser workspace** |
| Connected server | The server's selected workspace | [App runtimes](contents/md/runtimes.md) |

## Workspaces and branches

Open the branch selector to visit another branch or choose **Create branch**. Labels show only the branch name; long labels shorten with `...`, and hovering shows the full name. Historical workspaces show their version number. The active pane's label is underlined. Git changes determine the text color: added or untracked files are green, modifications orange, and deletions red.

A branch must contain the selected manifest at the same repository path. Unavailable branches remain visible in red with an information icon; hover or keyboard focus explains why they cannot be selected. **Create branch** is disabled until the manifest is committed in `HEAD`. Enter a valid Git branch name in its dialog to create a branch from the latest commit. Unsaved edits stay in the original workspace.

Split view shows two branch selectors in preview-pane order. Choosing a branch in either selector affects only its pane; clicking a preview pane makes its navigation and editing context active. Switching back restores that pane's draft and undo history, including unsaved form edits. Drafts, pull-request drafts, and commit messages stay with their workspace while the page remains open; save document changes before closing it.

Each branch reuses its existing workspace. Node workspaces use existing Git worktrees or create persistent worktrees under the repository's Git metadata in `dooc-worktrees`. Browser branches use separate persisted repository copies. Opening another branch does not stash or discard the original workspace's changes, and closing the page does not delete these workspaces.

## Editing in the browser

The workspace chooser supports **Local folder**, **New browser workspace**, **Saved browser workspace**, and **Clone Git repository**, without a Node workspace server.

Local folders require explicit browser read/write permission and support for `showDirectoryPicker`. Select the repository folder containing `.git`; specify the manifest path when it is in a subdirectory. Files save directly to that folder. Linked Git worktrees and symbolic links require the Node server.

New and cloned browser workspaces persist in origin-private storage. Reopen them through **Saved browser workspace** after a reload. Clearing site data removes that storage, so push commits or download files you need to keep elsewhere. A browser workspace has a 128 MiB working limit, including Git objects. External file changes are checked before writes; failed saves report an error.

Browser Git supports stage, unstage, diff, commit, fetch, fast-forward pull, push, and GitHub pull requests. Enter an author name and email for commits. Remotes must accept browser CORS requests or use a Git CORS proxy that you explicitly configure. GitHub's Git transport needs a proxy; its pull-request REST API is used directly. A proxy can receive repository data and credentials, so choose one you control or trust. Tokens remain in memory until the page closes and are not stored with saved workspaces or exports.

SSH remotes, stashes, and external formatting or lint commands require the Node server. Plugins whose server capabilities are unavailable keep their source links in the browser editor.

For Node workspaces, Git uses the system credential helper. GitHub pull-request operations use GitHub CLI (`gh auth login`), unless an origin plugin supplies another provider. The pull-request view includes open, closed, and merged requests. Creation requires pushing the current commit first; merging includes the reviewed head commit and respects GitHub branch protections. Editing a file alone never starts a remote operation.

Node and browser workspaces require a clean working tree before **Pull (fast-forward)**. Commit or stash pending changes first; a pull fails if the histories have diverged instead of creating a merge commit. Stashing is available only through the Node server.

## History

Open **Files → History** in `dooc editor run node --client --server` or a connected Node workspace. Browser-only workspaces do not offer snapshots.

| Workspace               | A snapshot is                                     |
| ----------------------- | ------------------------------------------------- |
| Inside a Git repository | A commit of everything under the workspace folder |
| Not under Git           | A copy of the files under `.dooc/snapshots/`      |

Save pending editor changes before taking a snapshot. In a Git workspace, snapshot or commit pending changes before restoring. A restore replaces the workspace files and records the result as a new commit, preserving existing commits. Outside Git, restoring first saves a **Before restoring** snapshot of the current files.

Undo and redo inside the editor are separate from snapshots and cover recent typing.

## Edit together

```sh
dooc editor run node --client --server --shared main
```

| Behaviour     | Detail                                                                   |
| ------------- | ------------------------------------------------------------------------ |
| Identity      | Each person enters a name once; it is not authentication                 |
| Snapshots     | Recorded only on the named branch, with every editor as `Co-authored-by` |
| Auto snapshot | Pending edits are saved as a snapshot a few minutes after the last edit  |
| Git           | Branch switching is hidden so everyone stays on the shared branch        |

TLS is available for the combined editor:

```sh
dooc editor run node --client --server --shared main --tls-cert cert.pem --tls-key key.pem
```

`DOOC_TLS_CERT` and `DOOC_TLS_KEY` set the same files. The listener still binds to loopback; TLS does not expose it to other machines. Editing requests require a local host and the matching browser origin. The entered name identifies contributions and does not authenticate a remote connection.
