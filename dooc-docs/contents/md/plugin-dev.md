A plugin is a JavaScript object that matches service URLs and returns a view. Types and OAuth helpers come from `@dooc-dev/dooc-plugin`. The demo source is `examples/viewer-plugins/` in the dooc repository.

## Contract

| Member         | Required | Purpose                                                       |
| -------------- | -------- | ------------------------------------------------------------- |
| `id`           | yes      | Stable identifier, used by `dooc plugin login <id>`           |
| `name`, `icon` | no       | Label and `{ light, dark }` icon in the **Plugins** tool      |
| `matches(url)` | yes      | Decide, without fetching, whether a URL belongs to the plugin |
| `oauth`        | yes      | Authorization and token URLs, client id, scopes               |
| `apiOrigins`   | yes      | Exact HTTPS origins that requests may reach                   |
| `identifyUser` | yes      | Resolve the signed-in user: `{ id, name }`                    |
| `read`         | yes      | Fetch the resource and return a view                          |
| `actions`      | no       | List the edits the current user may make                      |
| `act`          | no       | Recheck permissions and versions, then perform one edit       |

`read`, `actions`, and `act` receive `request`, which sends authenticated JSON requests to `apiOrigins` only. Credentials never reach the browser.

## A view

```javascript
async function read(url, { request }) {
  const data = await request(url.href);
  if (!data || ["id", "title", "status", "body"].some(key => typeof data[key] !== "string")) {
    throw new Error("Invalid service response");
  }
  return {
    header: { title: "TaskApp", reference: data.id },
    blocks: [
      { type: "heading", text: data.title },
      { type: "context", items: [{ text: data.status, tone: "accent" }] },
      { type: "text", text: data.body, markdown: true }
    ],
    collapsed: {
      blocks: [{ type: "context", items: [data.status, data.id] }]
    }
  };
}
```

| Part        | Holds                                                                 |
| ----------- | --------------------------------------------------------------------- |
| `header`    | Service `title`, `context`, `reference`, and a `{ light, dark }` icon |
| `blocks`    | The expanded card                                                     |
| `collapsed` | Optional compact card with its own `blocks`                           |

## Blocks

| Type              | Shows                                            |
| ----------------- | ------------------------------------------------ |
| `heading`, `text` | Text; `markdown: true` renders Markdown          |
| `context`         | A row of short items, badges, and copyable codes |
| `fields`          | Labelled values                                  |
| `table`           | Headers and rows                                 |
| `code`            | Source; `diff: true` colours a diff              |
| `message`         | An author, text, time, and reactions             |
| `section`         | A titled group of blocks; can start collapsed    |
| `columns`         | A main and an aside column                       |
| `progress`        | A labelled bar                                   |
| `actions`         | Buttons for action ids, or a composer            |
| `divider`         | A rule                                           |

Tones are `neutral`, `accent`, `success`, `warning`, and `danger`. A view is validated and limited to 2 MiB.

## Editing

`actions` returns what can change; a block points at one with `edit: { action, field }`.

| Action key               | Meaning                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `id`, `label`, `target`  | What the action is and what it changes                                |
| `fields`                 | Inputs: `text`, `textarea`, `select`, `multiselect`, `date`, `number` |
| `version`                | Resource version; `act` rejects a stale one                           |
| `partial`                | Only the changed fields are sent                                      |
| `destructive`, `confirm` | Ask before running                                                    |

## Package

```sh
dooc plugin pack ./built my-plugin.zip
dooc plugin add my-plugin.zip
```

| Rule          | Value                                                              |
| ------------- | ------------------------------------------------------------------ |
| ZIP root      | `package.json` with `name`, `version`, `type: module`, and `main`  |
| `main`        | A bundled `.js` or `.mjs`; dependencies must already be bundled in |
| `icon`        | Optional path to a bundled SVG, up to 64 KiB                       |
| Limits        | 16 MiB and 256 files                                               |
| Client secret | Never in a ZIP; ship a public client id                            |

A viewer module skips packaging: it default-exports `{ plugins: [...] }` and is passed with `--viewer-plugins`.
