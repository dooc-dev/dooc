import { afterEach, expect, it, vi } from "vitest";
import { mountPluginActions } from "./plugin-actions.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
    ".plugin-toolbar",
    "[data-plugin-status]",
    "[data-plugin-result]",
])("rejects a view missing %s before installing handlers or making requests", (missing) => {
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener });
    const section = {
        querySelector: (selector: string) => (selector === missing ? null : {}),
        addEventListener,
    } as unknown as HTMLElement;
    const api = vi.fn(async () => ({}));
    const refresh = vi.fn(async () => {});
    expect(() => mountPluginActions(section, api, refresh, () => true)).toThrow(
        "Plugin request failed",
    );
    expect(addEventListener).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
});
