# dooc

![dooc Overview page in dark mode, with the live preview and Markdown editor side by side](dooc-docs/contents/png/editor.png)

dooc turns a folder of Markdown, data files, and schema-backed records into one browsable document.
`dooc.yaml` arranges the files; dooc edits, checks, and ships them as a single HTML file.

## Install

| Method   | Command                                                                                      |
| -------- | -------------------------------------------------------------------------------------------- |
| npm      | `npm install -g @dooc-dev/dooc`                                                              |
| curl     | `curl -fsSL https://github.com/dooc-dev/dooc/releases/latest/download/install.sh \| sh`      |
| mise     | `mise use -g github:dooc-dev/dooc@latest`                                                    |
| Homebrew | `brew tap dooc-dev/dooc https://github.com/dooc-dev/dooc && brew install dooc-dev/dooc/dooc` |

npm requires Node.js 22 or later. Standalone executables support Linux (glibc) and macOS on x64 and arm64. The curl installer writes to `~/.local/bin`; add it to `PATH` if needed.

## Start a project

```sh
mkdir my-docs && cd my-docs
dooc init
dooc edit
```

Open the URL printed in the terminal and add your first page in the editor. Keep the command running while editing. `dooc view` opens the same workspace read-only.

After saving your pages, stop the editor with **Ctrl+C**, then check and build:

```sh
dooc check
dooc build html
```

Share `dist/bundle.html` as a single file. `dooc check` validates local content; it does not fetch remote URLs.

## Documentation

```sh
dooc view dooc-docs --repo https://github.com/dooc-dev/dooc.git
dooc edit dooc-docs --repo https://github.com/dooc-dev/dooc.git
```

Requires Git and a network connection for the initial clone. Documentation is downloaded at runtime, separately from the npm package and standalone executable.

`view` downloads a fresh temporary read-only copy each time and removes it on exit. `edit` keeps a local clone and reopens your saved changes without fetching updates automatically; use the editor's Git tools to fetch and pull. Keep the command running while using either mode.

See [Commands](dooc-docs/contents/md/cli.md) for CLI options and Git workspace limitations, [Editor](dooc-docs/contents/md/editor.md) for editing and branch controls, and [Install](dooc-docs/contents/md/install.md) for updates.

## License

[MIT](LICENSE)
