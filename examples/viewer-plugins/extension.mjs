import { readFileSync } from "node:fs";
import { createSampleMock } from "./mock.mjs";
import { createSamplePlugin } from "./sample.mjs";

const mock = createSampleMock();
const plugin = createSamplePlugin({
    authorizationUrl: `${mock.origin}/authorize`, tokenUrl: `${mock.origin}/token`,
    userUrl: `${mock.origin}/me`, clientId: "dooc-sample",
});
const icons = Object.fromEntries(["TaskApp", "GitApp", "ChatApp"].map((name) => [
    name, `data:image/svg+xml;base64,${readFileSync(new URL(`./assets/${name.toLowerCase()}.svg`, import.meta.url)).toString("base64")}`,
]));
const read = plugin.read;
plugin.read = async (...args) => {
    const view = await read(...args);
    view.header.icon = { light: icons[view.header.title] };
    return view;
};
export default { plugins: [plugin], mocks: { sample: mock } };
