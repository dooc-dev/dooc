import { expect, it } from "vitest";
import { parseTextfileRange, selectTextfileRange } from "./textfile.js";

const text = "abcde\nfghij\nklmno\npqrst\nuvwxy\n12345\nABCDE\n";

it("selects inclusive line and character ranges with one-based positions and open ends", () => {
    expect(selectTextfileRange(text)).toBe(text);
    expect(selectTextfileRange(text, "[1,3]")).toBe("abcde\nfghij\nklmno");
    expect(selectTextfileRange(text, "[1,*]")).toBe(text);
    expect(selectTextfileRange(text, "[1:5, 7:3]")).toBe(
        "e\nfghij\nklmno\npqrst\nuvwxy\n12345\nABC",
    );
    expect(selectTextfileRange(text, "[2,2]")).toBe("fghij");
    expect(selectTextfileRange(text, "[1:2,1:2]")).toBe("b");
    expect(selectTextfileRange(text, "[*,1:3]")).toBe("abc");
    expect(selectTextfileRange("", "[1,*]")).toBe("");
});

it("includes exact string matches and finds the first end after the complete start match", () => {
    const source = "BBB before\nAAAA start\nmiddle\nBBB end\nAAAA later BBB\n";
    expect(selectTextfileRange(source, '["AAAA", "BBB"]')).toBe("AAAA start\nmiddle\nBBB");
    expect(selectTextfileRange(source, '["AAAA", *]')).toBe(
        "AAAA start\nmiddle\nBBB end\nAAAA later BBB\n",
    );
    expect(selectTextfileRange(source, '[2, "BBB"]')).toBe("AAAA start\nmiddle\nBBB");
    expect(selectTextfileRange(source, '["AAAA", 3:3]')).toBe("AAAA start\nmid");
    expect(selectTextfileRange("aa x aa tail", '["aa", "aa"]')).toBe("aa x aa");
    expect(selectTextfileRange("prefix * tail", '["*", *]')).toBe("* tail");
    expect(selectTextfileRange("a,b middle c]d suffix", '["a,b", "c]d"]')).toBe("a,b middle c]d");
});

it("counts Unicode code points and preserves CRLF boundaries", () => {
    expect(selectTextfileRange("あ😀いう\nかきく", "[1:2,2:2]")).toBe("😀いう\nかき");
    const source = "a\r\nbc\r\nd";
    expect(selectTextfileRange(source, "[2:2,3:1]")).toBe("c\r\nd");
    expect(selectTextfileRange(source, "[1,2]")).toBe("a\r\nbc");
    expect(selectTextfileRange(source, "[1,*]")).toBe(source);
    expect(selectTextfileRange("a\rb\rc", "[2,3]")).toBe("b\rc");
});

it.each([
    "[]",
    "[1]",
    "[1,2,3]",
    "[0,1]",
    "[1:0,2]",
    "[-1,2]",
    "[1.5,2]",
    "[9007199254740992,*]",
    '["",*]',
    '["bad\\x",*]',
    "[start,end]",
])("rejects invalid selectors: %s", (range) => {
    expect(() => parseTextfileRange(range)).toThrow();
});

it.each([
    "[8,1]",
    "[1,99]",
    "[1:6,2]",
    "[3,1]",
    '["missing",*]',
    '["ABCDE","abcde"]',
    '["ABC", "abc"]',
])("reports unresolved or reversed boundaries: %s", (range) => {
    expect(() => selectTextfileRange(text, range)).toThrow();
});
