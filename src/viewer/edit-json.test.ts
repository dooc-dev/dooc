import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { jsonCompletion } from "./edit-json.js";

const context = (source: string) => {
    const pos = source.indexOf("|");
    return new CompletionContext(EditorState.create({ doc: source.replace("|", "") }), pos, true);
};

it("completes schema keywords and nested types in an unfinished 2020-12 schema", async () => {
    const complete = jsonCompletion(undefined, true);
    expect((await complete(context('{ "|" }')))?.options.map((item) => item.label)).toContain(
        "properties",
    );
    expect(
        (await complete(context('{ "properties": { "title": { "|" } } }')))?.options.map(
            (item) => item.label,
        ),
    ).toContain("minLength");
    expect(
        (await complete(context('{ "type": "|" }')))?.options.map((item) => item.label),
    ).toContain('"object"');
    expect(
        (await complete(context('{ "properties": { "title": { "mi|" } } }')))?.options.map(
            (item) => item.label,
        ),
    ).toEqual(expect.arrayContaining(["minLength"]));
    expect(
        (await complete(context('{ "properties": { "title": { "mi|" } } }')))?.options.map(
            (item) => item.label,
        ),
    ).not.toContain("properties");
});

it("completes record keys, enum values, and properties resolved through local refs", async () => {
    const complete = jsonCompletion({
        type: "object",
        $defs: { status: { type: "string", enum: ["Todo", "Done"] } },
        properties: {
            title: { type: "string" },
            status: { $ref: "#/$defs/status" },
            owner: { type: "object", properties: { name: { type: "string" } } },
        },
    });
    expect((await complete(context('{ "|" }')))?.options.map((item) => item.label)).toContain(
        "status",
    );
    expect(
        (await complete(context('{ "status": "|" }')))?.options.map((item) => item.label),
    ).toEqual(expect.arrayContaining(['"Todo"', '"Done"']));
    expect(
        (await complete(context('{ "owner": { "|" } }')))?.options.map((item) => item.label),
    ).toContain("name");
});

it("completes enums across file and remote schema documents without fetching from the browser", async () => {
    const uri = "file:///schemas/issue.json";
    const complete = jsonCompletion(
        { type: "object", properties: { status: { $ref: "common.json#/$defs/status" } } },
        false,
        {
            uri,
            schemas: {
                "file:///schemas/common.json": {
                    $defs: { status: { $ref: "https://schemas.example.test/status.json" } },
                },
                "https://schemas.example.test/status.json": {
                    type: "string",
                    enum: ["Todo", "Done"],
                },
            },
        },
    );
    expect((await complete(context('{"status":"|"}')))?.options.map((item) => item.label)).toEqual(
        expect.arrayContaining(['"Todo"', '"Done"']),
    );
});
