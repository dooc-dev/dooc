import { expect, it } from "vitest";
import {
    advanceVersion,
    latestVersionOnly,
    parseVersionConfig,
    parseVersionSelection,
    selectVersions,
} from "./document-version.js";

const versions = ["1.2.8", "1.2.9", "1.3.1", "1.3.2", "2.0.0", "2.1.0", "2.1.1"].map((version) => ({
    version,
}));

it.each([
    ["latest", ["2.1.1"]],
    ["latest.latest.latest", ["2.1.1"]],
    ["latest.*.*", ["2.1.1", "2.1.0", "2.0.0"]],
    ["latest.latest.*", ["2.1.1", "2.1.0"]],
    ["1.2.latest", ["1.2.9"]],
    ["*.latest.latest", ["2.1.1", "1.3.2"]],
    ["*.*.latest", ["2.1.1", "2.0.0", "1.3.2", "1.2.9"]],
    [">=1.3.0 <2.0.0", ["1.3.2", "1.3.1"]],
    ["1.2.8", ["1.2.8"]],
    ["latest.3.*", []],
])("selects %s from existing versions", (selector, expected) => {
    expect(
        selectVersions(versions, parseVersionSelection(selector)).map((row) => row.version),
    ).toEqual(expected);
});

it("resolves the latest minor and patch inside their parents", () => {
    expect(
        selectVersions(
            [{ version: "1.2.9" }, { version: "1.3.2" }, { version: "2.0.0" }],
            parseVersionSelection(),
        ),
    ).toEqual([{ version: "2.0.0" }]);
    expect(latestVersionOnly(parseVersionSelection("latest"))).toBe(true);
    expect(latestVersionOnly(parseVersionSelection("latest.latest.latest"))).toBe(true);
    expect(latestVersionOnly(parseVersionSelection("*.*.latest"))).toBe(false);
});

it.each([
    "",
    "1.latest",
    "latest*latest*latest",
    ">=1.2",
    "01.2.3",
    "1.2.-1",
    "1.2.3+dirty",
])("rejects invalid publication selection %s", (value) => {
    expect(() => parseVersionSelection(value)).toThrow();
});

it("accepts fixed components and rejects mixed automatic sources", () => {
    expect(parseVersionConfig({})).toEqual({ major: 0, minor: "git", patch: "git" });
    expect(parseVersionConfig({ major: 1, minor: 4, patch: "hash" })).toEqual({
        major: 1,
        minor: 4,
        patch: "hash",
    });
    for (const value of [
        { major: "1" },
        { minor: -1 },
        { patch: 0.5 },
        { minor: "git", patch: "hash" },
        { auto: "git" },
    ])
        expect(() => parseVersionConfig(value)).toThrow();
});

it("increments once per input change and resets only automatic lower components", () => {
    let state = advanceVersion({
        config: { major: 1, minor: "git", patch: "git" },
        definition: "a",
        content: "a",
    });
    expect(state.version).toBe("1.0.0");
    state = advanceVersion({ ...state, content: "b" }, state);
    expect(state.version).toBe("1.0.1");
    expect(advanceVersion(state, state).version).toBe("1.0.1");
    state = advanceVersion({ ...state, definition: "b", content: "c" }, state);
    expect(state.version).toBe("1.1.0");
    expect(advanceVersion({ ...state, config: { ...state.config, major: 2 } }, state).version).toBe(
        "2.0.0",
    );
    state = advanceVersion({ ...state, config: { major: 1, minor: 4, patch: "git" } }, state);
    expect(state.version).toBe("1.4.0");
    state = advanceVersion({ ...state, definition: "c", content: "d" }, state);
    expect(state.version).toBe("1.4.1");
    expect(advanceVersion({ ...state, config: { ...state.config, major: 2 } }, state).version).toBe(
        "2.4.0",
    );
    state = advanceVersion({ ...state, config: { major: 1, minor: "git", patch: 3 } });
    expect(advanceVersion({ ...state, definition: "d" }, state).version).toBe("1.1.3");
});
