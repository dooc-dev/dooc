import { describe, expect, it } from "vitest";
import { parseDateValue } from "./date-picker.js";

describe("date input", () => {
    it.each([
        "2024-02-29",
        "2026-12-31",
        "0099-01-01",
        "0000-01-01",
        "9999-12-31",
    ])("preserves the local calendar date %s", (value) => {
        const date = parseDateValue(value);
        if (!date) throw new Error(`Expected a valid date: ${value}`);
        expect([date.getFullYear(), date.getMonth() + 1, date.getDate()]).toEqual(
            value.split("-").map(Number),
        );
    });
    it.each([
        "",
        "2026-02-29",
        "2026-02-30",
        "2026-13-01",
        "2026-01-00",
        "2026-1-1",
        "2026-11-11T00:00:00Z",
    ])("rejects invalid or incomplete dates: %s", (value) =>
        expect(parseDateValue(value)).toBeUndefined());
});
