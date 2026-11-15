# History playground

This generated directory is its own Git repository. It starts with two commits on **main** and an **example** branch at the first commit. It has no remote.

| Location | Document version | First task |
| --- | --- | --- |
| example | 1.0.0 | Todo |
| main | 1.0.1 | Doing |

## Compare branches

Open [the first task](contents/task/first.task), enable **Split view**, and select **example** in one pane's workspace and branch picker. Compare its status with **main**. Return to the other pane to continue editing there.

Use **Create branch** to make another disposable branch. The **Git** tool shows changed files, diffs, staging, and commit controls. Remote fetch, push, and provider pull requests require a Git remote you choose; the [local GitApp demo](contents/md/integrations.md) provides a mock pull-request card without one.

## Browse versions

The sidebar **Version** picker lists 1.0.1 and 1.0.0 on main. Selecting 1.0.0 opens a read-only historical snapshot. Return to **latest** to edit again. An unsaved draft remains available through the drafts picker when you move between contexts.

## Save a checkpoint

1. Change a task or this page and save.
2. Open **Files → History** and create a snapshot.
3. Make another change, then inspect or restore a checkpoint.

Git history and document versions are related: a committed content change advances the automatic patch version. Edits remain disposable across a fresh `mise run editor` start. Read [Document versions](contents/md/version.md) for the increment rules and [Workspace history](contents/md/workspaces.md#history) for restore behavior.
