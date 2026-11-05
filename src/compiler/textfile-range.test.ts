import { expect, it } from "vitest";
import { parseFileReference } from "../core/textfile.js";
import { parseTextfileRange, selectTextfileRange } from "./textfile.js";

it("selects whole lines using GitHub's one-based inclusive syntax", () => {
    const text = "one\ntwo\nthree\n";
    expect(selectTextfileRange(text)).toBe(text);
    expect(selectTextfileRange(text, "#L2")).toBe("two");
    expect(selectTextfileRange(text, "#L1-L3")).toBe("one\ntwo\nthree");
    expect(selectTextfileRange(text, "#L2-L2")).toBe("two");
    expect(selectTextfileRange("", "#L1")).toBe("");
    expect(selectTextfileRange("あ😀\r\nかき\r\nく", "#L1-L2")).toBe("あ😀\r\nかき");
    expect(selectTextfileRange("a\rb\rc", "#L2-L3")).toBe("b\rc");
});

it.each([
    "",
    "#L0",
    "#L01",
    "#L-1",
    "#L1.5",
    "#L1-L0",
    "#L3-L1",
    "#L9007199254740992",
    "#L1-20",
    "#L1C2-L3C4",
    "#line=0,3",
    "[1,3]",
    '["start",*]',
    "#L1-L2junk",
])("rejects unsupported or invalid selectors: %s", (range) => {
    expect(() => parseTextfileRange(range)).toThrow();
});

it("rejects out-of-bounds lines, including a phantom line after a final newline", () => {
    expect(() => selectTextfileRange("a\nb\n", "#L3")).toThrow("range line 3 does not exist");
    expect(() => selectTextfileRange("a\nb", "#L1-L3")).toThrow("range line 3 does not exist");
});

it("separates URL fragments from decoded filenames and keeps HTTPS query parameters", () => {
    expect(parseFileReference("examples/a%20%23b%3F%25.txt#L2-L3")).toEqual({
        file: "examples/a #b?%.txt",
        range: "#L2-L3",
    });
    expect(parseFileReference("https://example.com/a%20b.txt?raw=1#L2")).toEqual({
        file: "https://example.com/a%20b.txt?raw=1",
        range: "#L2",
    });
    expect(parseFileReference("./examples/a.txt")).toEqual({ file: "./examples/a.txt" });
    for (const invalid of ["", "#L1", "%zz.txt", "a.txt?query"])
        expect(() => parseFileReference(invalid)).toThrow();
});
