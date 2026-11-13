A plugin turns a service URL into a live card. Write the URL as an embed; a plugin that matches it fetches the data and returns structured blocks, and dooc draws them in the current theme. Pages store only the URL.

```text
![Issue DOC-42](https://sample.dooc.invalid/tickets/DOC-42)
```

| URL                          | Result        |
| ---------------------------- | ------------- |
| Matched by an enabled plugin | Plugin card   |
| Not matched                  | Stays a link  |
| Written as `[text](url)`     | Always a link |

## Demo plugins

Three fictional services show what a card can do. They run on a local mock: no account, no network, and changes last until the viewer restarts.

| Service                           | Card for       | Try                                          |
| --------------------------------- | -------------- | -------------------------------------------- |
| [TaskApp](contents/md/taskapp.md) | A ticket       | Edit fields in place                         |
| [GitApp](contents/md/gitapp.md)   | A pull request | Read the diff, change review status, comment |
| [ChatApp](contents/md/chatapp.md) | A message      | Reply to the thread, toggle reactions        |

The demo plugins load in a source checkout with `mise run dev`. The **Plugins** tool then lists **Sample plugin** (`sample`) and **Sample plugin (sign-in demo)** (`sample-auth`). Without them, as in `dooc self docs`, the cards on these pages stay links.

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
| Viewer module | `dooc edit --viewer-plugins <module>`, or `DOOC_VIEWER_PLUGINS`     | Outside the workspace |

A ZIP is installed per project and can be enabled, disabled, replaced, or deleted in the **Plugins** tool. A viewer module is trusted code chosen by whoever starts dooc; its plugins show as **Provided by viewer**.

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
| `dooc build html` (`--mode static`)           | Fetched once with your build-time sign-in and embedded       |
| `dooc build html --mode live --auth external` | Fetched when opened; the hosting page supplies the transport |
| `dooc export`                                 | Not fetched; the URLs stay in the source                     |

## A URL without a plugin

![](https://unsupported.example/tickets/123)

To build your own, see [Write a plugin](contents/md/plugin-dev.md).
