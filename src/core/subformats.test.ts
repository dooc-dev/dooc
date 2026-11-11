import { expect, it } from "vitest";
import {
    parseSubformats,
    type SubformatField,
    sortSubformatRecords,
    subformatSourcePath,
} from "./subformats.js";

it("preserves explicit card title layouts and rejects invalid settings", () => {
    const config = { ext: "issue", format: "yaml", schema: "issue.schema.json" };
    expect(parseSubformats([config])).toEqual([config]);
    for (const layouts of [
        {},
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
