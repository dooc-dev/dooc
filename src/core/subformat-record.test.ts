import { expect, it } from "vitest";
import { parseSubformatRecord, setSubformatValue } from "./subformat-record.js";

it.each([
    "json",
    "yaml",
    "toml",
] as const)("edits nested %s values without changing other data", (format) => {
    const source = {
        json: '{"title":"Old","owner":{"name":"A"},"tags":["one"],"extra":true}\n',
        yaml: "# Keep\ntitle: Old\nowner:\n  name: A # Keep name\ntags: [one]\nextra: true\n",
        toml: '# Keep\ntitle = "Old"\ntags = ["one"]\nextra = true\n[owner]\nname = "A" # Keep name\n',
    }[format].replaceAll("\n", "\r\n");
    const updated = setSubformatValue(source, format, ["owner", "name"], "B");
    expect(parseSubformatRecord(updated, format)).toEqual({
        title: "Old",
        owner: { name: "B" },
        tags: ["one"],
        extra: true,
    });
    expect(updated).toContain("\r\n");
    if (format !== "json") {
        expect(updated).toContain("# Keep\r\n");
        expect(updated).toContain("# Keep name");
    }
    const added = setSubformatValue(updated, format, ["owner", "email"], "a@example.com");
    expect(parseSubformatRecord(added, format).owner).toEqual({
        name: "B",
        email: "a@example.com",
    });
});

it("preserves TOML arrays of tables, quoted keys and date values", () => {
    const source =
        'date = 2026-11-10\n[[owners]]\n"full name" = "A" # Keep\n[[owners]]\n"full name" = "B"\n';
    const updated = setSubformatValue(source, "toml", ["owners", 1, "full name"], "C");
    expect(updated).toBe(source.replace('"B"', '"C"'));
    expect(setSubformatValue('owner = {name = "A"}\n', "toml", ["owner", "name"], "B")).toBe(
        'owner = {name = "B"}\n',
    );
});

it("replaces TOML table values while preserving unrelated tables and dates", () => {
    const source =
        'date = 2026-11-10\n[[owners]]\nname = "A"\n[[owners]]\nname = "B"\n[extra]\nkeep = true\n';
    const updated = setSubformatValue(source, "toml", ["owners"], [{ name: "C" }]);
    expect(parseSubformatRecord(updated, "toml")).toEqual({
        date: "2026-11-10",
        owners: [{ name: "C" }],
        extra: { keep: true },
    });
    expect(updated).toContain("date = 2026-11-10");
    expect(updated).toContain("[extra]\nkeep = true");
    expect(
        parseSubformatRecord(
            setSubformatValue('owner.name = "A"\nother = true\n', "toml", ["owner"], { name: "B" }),
            "toml",
        ),
    ).toEqual({ owner: { name: "B" }, other: true });
});

it("rejects unsafe edits without mutating unrelated values or prototypes", () => {
    expect(() => setSubformatValue("a: &a {name: A}\nb: *a\n", "yaml", ["a", "name"], "B")).toThrow(
        "without changing other values",
    );
    expect(() =>
        setSubformatValue('{"count":1}', "json", ["count"], Number.MAX_SAFE_INTEGER + 1),
    ).toThrow("finite JSON-compatible");
    expect(() => setSubformatValue('title = "A"', "toml", ["title"], null)).toThrow();
    expect(() => setSubformatValue("{}", "json", ["__proto__", "name"], "bad")).toThrow();
    const updated = setSubformatValue(
        '{"__proto__":{"name":"A"}}',
        "json",
        ["__proto__", "name"],
        "B",
    );
    expect(JSON.parse(updated)).toEqual(JSON.parse('{"__proto__":{"name":"B"}}'));
});
