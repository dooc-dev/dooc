import { expect, it } from "vitest";
import {
    matchesSubformatRecord,
    parseSubformatQuery,
    parseSubformats,
    type SubformatEmbedOptions,
    type SubformatField,
    sortSubformatRecords,
    subformatSourcePath,
    validateSubformatOptions,
} from "./subformats.js";

it("preserves explicit card title layouts and rejects invalid settings", () => {
    const config = { ext: "issue", format: "yaml", schema: "issue.schema.json" };
    expect(parseSubformats([config])).toEqual([config]);
    expect(parseSubformats([{ ...config, icon: "icons/issue.svg" }])[0]?.icon).toBe(
        "icons/issue.svg",
    );
    for (const icon of ["issue.png", "../issue.svg", 1])
        expect(() => parseSubformats([{ ...config, icon }])).toThrow("icon");
    for (const layouts of [
        {},
        { view: "card" },
        { view: "list" },
        { card_title: "subject" },
        { card_title: "" },
        { group_by: "status", sort_by: "due", sort_order: "desc" },
        { group_by: "", sort_by: "", sort_order: "asc" },
    ]) {
        expect(parseSubformats([{ ...config, layouts }])).toEqual([{ ...config, layouts }]);
    }
    for (const layouts of [
        null,
        [],
        "title",
        { title: "subject" },
        { card_title: 3 },
        { card_title: null },
        { group_by: 3 },
        { sort_by: null },
        { sort_order: "invalid" },
        { view: "grid" },
        { view: null },
    ]) {
        expect(() => parseSubformats([{ ...config, layouts }])).toThrow("layouts");
    }
});

it("sorts dates chronologically across time zones and leaves missing dates last in either direction", () => {
    const records = [
        { file: "missing", content: "", data: {} },
        { file: "later", content: "", data: { due: "2026-11-10T01:00:00Z" } },
        { file: "earlier", content: "", data: { due: "2026-11-10T09:00:00+09:00" } },
        { file: "invalid", content: "", data: { due: "invalid" } },
    ];
    const due: SubformatField = { name: "due", title: "Due", format: "date-time" };
    expect(sortSubformatRecords(records, due).map((item) => item.file)).toEqual([
        "earlier",
        "later",
        "invalid",
        "missing",
    ]);
    expect(sortSubformatRecords(records, due, true).map((item) => item.file)).toEqual([
        "later",
        "earlier",
        "invalid",
        "missing",
    ]);
    expect(records[0]?.file).toBe("missing");
});

it("orders enum values by schema order and sorts numbers, booleans, text and file names", () => {
    const records = [
        {
            file: "a",
            content: "",
            data: { status: "Done", points: 10, title: "Task 10", ready: true },
        },
        {
            file: "b",
            content: "",
            data: { status: "Todo", points: 2, title: "Task 2", ready: false },
        },
        { file: "c", content: "", data: {} },
    ];
    for (const field of [
        { name: "status", title: "Status", enum: ["Todo", "Done"] },
        { name: "points", title: "Points", type: "number" },
        { name: "title", title: "Title", type: "string" },
        { name: "ready", title: "Ready", type: "boolean" },
    ] satisfies SubformatField[]) {
        expect(sortSubformatRecords(records, field).map((item) => item.file)).toEqual([
            "b",
            "a",
            "c",
        ]);
        expect(sortSubformatRecords(records, field, true).map((item) => item.file)).toEqual([
            "a",
            "b",
            "c",
        ]);
    }
    expect(sortSubformatRecords(records, undefined, true).map((item) => item.file)).toEqual([
        "c",
        "b",
        "a",
    ]);
});

it("copies repository paths literally and encodes each URL path segment", () => {
    expect(subformatSourcePath("records/a b#1.issue", "repo/docs/")).toBe(
        "repo/docs/records/a b#1.issue",
    );
    expect(subformatSourcePath("records/日本語 #%.issue", "https://example.com/source/")).toBe(
        "https://example.com/source/records/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%23%25.issue",
    );
});

const fields: SubformatField[] = [
    { name: "title", title: "Title", type: "string" },
    { name: "status", title: "Status", enum: ["Todo", "Done"] },
    { name: "points", title: "Points", type: "number" },
    { name: "ready", title: "Ready", type: "boolean" },
    { name: "due", title: "Due", format: "date-time" },
    { name: "tags", title: "Tags" },
];

it("parses view parameters and validates field names and typed filter operands", () => {
    const options = parseSubformatQuery(
        "view=list&fields=title,points&card_title=title&group_by=status&sort_by=points&sort_order=desc&q=First+issue&filter.status=Todo&filter.points[gte]=0&filter.points[lt]=10",
    );
    expect(options).toEqual({
        view: "list",
        fields: ["title", "points"],
        card_title: "title",
        group_by: "status",
        sort_by: "points",
        sort_order: "desc",
        q: "First issue",
        filters: [
            ["status", "Todo"],
            ["points", "0", "gte"],
            ["points", "10", "lt"],
        ],
    });
    expect(() => validateSubformatOptions(options, fields)).not.toThrow();
    expect(parseSubformatQuery("fields=&group_by=&sort_by=&card_title=")).toEqual({
        fields: [],
        group_by: "",
        sort_by: "",
        card_title: "",
    });
    for (const query of [
        "fields=title,title",
        "fields=title,",
        "sort_order=newest",
        "filter.points[gte]=0&filter.points[gte]=1",
        "filter.title[unknown]=a",
    ])
        expect(() => parseSubformatQuery(query)).toThrow();
    for (const query of [
        "fields=unknown",
        "card_title=missing",
        "group_by=title",
        "sort_by=tags",
        "filter.missing=a",
        "filter.title[gt]=3",
        "filter.points[gte]=",
        "filter.points[lt]=NaN",
        "filter.due[gt]=invalid",
        "filter.status[in]=Todo,",
        "filter.ready[empty]=yes",
    ])
        expect(() => validateSubformatOptions(parseSubformatQuery(query), fields)).toThrow();
});

it("combines text search and filters without losing zero, false, missing or nested values", () => {
    const record = {
        file: "first.issue",
        content: "First ＴＡＳＫ",
        data: {
            title: "First ＴＡＳＫ",
            status: "Todo",
            points: 0,
            ready: false,
            due: "2026-11-10T09:00:00+09:00",
            tags: ["urgent", { owner: "A" }],
        },
    };
    const matches = (options: SubformatEmbedOptions) =>
        matchesSubformatRecord(record, options, fields);
    expect(
        matches({
            q: "FIRST task",
            filters: [
                ["points", "0"],
                ["ready", "false"],
                ["title", "task", "contains"],
                ["status", "Done,Todo", "in"],
            ],
        }),
    ).toBe(true);
    expect(matches({ q: "missing" })).toBe(false);
    expect(
        matches({
            filters: [
                ["tags", "urgent", "contains"],
                ["status", "Done", "ne"],
                ["points", "0", "gte"],
                ["points", "1", "lt"],
            ],
        }),
    ).toBe(true);
    expect(matches({ filters: [["due", "2026-11-10T00:30:00Z", "lt"]] })).toBe(true);
    expect(matches({ filters: [["points", "0", "gt"]] })).toBe(false);
    expect(matches({ filters: [["points", "0", "lte"]] })).toBe(true);
    expect(matches({ filters: [["tags", "[object Object]", "contains"]] })).toBe(false);
    expect(matches({ filters: [["tags", "urgent,[object Object]"]] })).toBe(false);
    expect(matches({ filters: [["absent", "undefined"]] })).toBe(false);
    expect(matches({ filters: [["toString", "x", "ne"]] })).toBe(false);
    expect(
        matches({
            filters: [
                ["ready", "false", "empty"],
                ["points", "false", "empty"],
                ["absent", "true", "empty"],
            ],
        }),
    ).toBe(true);
    for (const value of [null, "", []])
        expect(
            matchesSubformatRecord(
                { ...record, data: { title: value } },
                { filters: [["title", "true", "empty"]] },
                fields,
            ),
        ).toBe(true);
});
