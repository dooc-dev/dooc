A plugin turns a service URL into a live card. Write the URL as an embed; a plugin that matches it fetches the data and returns structured blocks, and dooc draws them in the current theme. Pages store only the URL.

This guide describes the current trusted service-plugin runtime. The accepted [sandbox, host and kit architecture](contents/md/plugin-architecture.md) is not implemented yet; existing plugin packages do not have its sandbox guarantees.

```text
![Issue DOC-42](https://sample.dooc.invalid/tickets/DOC-42)
```

| URL                          | Result        |
| ---------------------------- | ------------- |
| Matched by an enabled plugin | Plugin card   |
| Not matched                  | Stays a link  |
| Written as `[text](url)`     | Always a link |

## Demo plugins

Three fictional services show what a card can do. They run on a local mock: no account, no network, and changes last until the reader restarts.

| Service                           | Card for       | Try                                          |
| --------------------------------- | -------------- | -------------------------------------------- |
| [TaskApp](contents/md/taskapp.md) | A ticket       | Edit fields in place                         |
| [GitApp](contents/md/gitapp.md)   | A pull request | Read the diff, change review status, comment |
| [ChatApp](contents/md/chatapp.md) | A message      | Reply to the thread, toggle reactions        |

The demo modules are development files in a source checkout; they are not bundled with dooc. After [development setup](contents/md/development.md#set-up-and-run), load a module explicitly with `--reader-plugins`. To use them with a cloned documentation workspace, run from that trusted source checkout:

```sh
dooc editor run node --client --server --project dooc-docs --repo https://github.com/dooc-dev/dooc.git \
  --reader-plugins ./sample/examples/reader-plugins/index.mjs
```

The **Plugins** tool then lists **Sample plugin** (`sample`) and **Sample plugin (sign-in demo)** (`sample-auth`). Opening the documentation with `dooc reader run node --client --server --project dooc-docs --repo https://github.com/dooc-dev/dooc.git` or `dooc self docs` does not load these modules; the demo cards stay links.

## Card controls

| Control              | Effect                                                      |
| -------------------- | ----------------------------------------------------------- |
| Open link, Copy link | Go to the service, or copy the URL                          |
| Edit                 | Turn editing on; double-click a value, or press Enter or F2 |
| Collapse card        | Switch to the compact view                                  |
| Resize handle        | Change the card height                                      |

Values save as you leave a field. Cards refresh every five seconds and when you return to the tab, so the same card in two tabs stays in step.

## Add a plugin

| Source        | How                                                                 | Kept in               |
| ------------- | ------------------------------------------------------------------- | --------------------- |
| Plugin ZIP    | `dooc plugin add <zip>`, or **Add plugins** in the **Plugins** tool | `.dooc/plugins/`      |
| Reader module | `dooc editor run node --client --server --reader-plugins <module>`, or `DOOC_READER_PLUGINS`     | Outside the workspace |

A ZIP is installed per project and can be enabled, disabled, replaced, or deleted in the **Plugins** tool. A reader module is trusted code chosen by whoever starts dooc; its plugins show as **Provided by reader**.

To remove an installed ZIP from a terminal, run `dooc plugin remove example.zip [dooc.yaml]` with the file name shown in the **Plugins** tool. This deletes the ZIP and its workspace approval without executing it. Saved logins are retained; sign out before removing the plugin to disconnect the account. Reader modules are selected through the startup configuration and are not installed ZIPs.

In an `edit` or `view` session opened with `--repo`, workspace ZIPs remain files but are not activated, even if previously approved. Installing, enabling, replacing, or editing a workspace plugin is disabled in that session. An explicitly selected local `--reader-plugins` module remains supported; `edit` and `view` also accept `DOOC_READER_PLUGINS`. To use workspace ZIPs, inspect and trust a local checkout, then open its manifest without `--repo`.

## Sign in

A plugin signs in with OAuth. Tokens and approvals stay in `~/.dooc/plugins/` on your computer (`DOOC_USER_DIR` moves it) and never enter a page, an export, or a bundle.

| Action                  | How                                               |
| ----------------------- | ------------------------------------------------- |
| Sign in                 | **Sign in** on the plugin in the **Plugins** tool |
| Sign in from a terminal | `dooc plugin login <id>`                          |
| Sign out                | **Sign out**; the card asks to connect again      |

Try it with the sign-in demo: choose **Sign in** on **Sample plugin (sign-in demo)**, then authorize **Alice** or **Bob** on the local consent screen. The card below shows the account you chose. It has its own account and data, separate from the three demo services.

![Sign-in demo](https://auth.sample.dooc.invalid/tickets/DOC-42)

## Plugins in a build

| Build                                         | Cards                                                        |
| --------------------------------------------- | ------------------------------------------------------------ |
| `dooc build --mode static`                    | Fetched once with your build-time sign-in and embedded       |
| `dooc build --mode live --auth external`      | Fetched when opened; the hosting page supplies the transport |
| `dooc zip`                                    | Not fetched; the URLs stay in the source                     |

## A URL without a plugin

![](https://unsupported.example/tickets/123)

To build your own, see [Write a plugin](contents/md/plugin-dev.md).
