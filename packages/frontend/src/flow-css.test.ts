// Tests guarding two properties of the injected stylesheet:
//   1. The generated file (flow-base-css.generated.ts) matches the installed `@xyflow/react`
//      (detects it going stale from a forgotten build:css run / a React Flow upgrade).
//   2. No default theme is included; colors come from `--doc-*` (the palette the caller injects).
import { describe, expect, it } from "vitest";
import { readXyflowBaseCss } from "../../../scripts/build/flow-css.js";
import { XYFLOW_BASE_CSS } from "./flow-base-css.generated.js";
import { SCHEMA_GRAPH_FLOW_CSS } from "./flow-css.js";

describe("schema graph stylesheet", () => {
    it("generated file matches the installed base.css (run pnpm run build:css if it drifts)", () => {
        expect(XYFLOW_BASE_CSS).toBe(readXyflowBaseCss());
    });

    it("includes the structural rules that keep it from collapsing", () => {
        expect(SCHEMA_GRAPH_FLOW_CSS).toContain(".react-flow__container");
        expect(SCHEMA_GRAPH_FLOW_CSS).toContain(".react-flow__panel");
        expect(SCHEMA_GRAPH_FLOW_CSS).toContain(".react-flow__minimap");
    });

    it("takes colors from --doc-* and scopes custom rules to the mounted graph", () => {
        const theme = SCHEMA_GRAPH_FLOW_CSS.slice(XYFLOW_BASE_CSS.length);
        expect(theme).toContain("var(--doc-panel");
        for (const rule of theme.split("}")) {
            const selector = rule.split("{")[0]?.trim() ?? "";
            if (selector !== "") {
                expect(selector).toContain(".doc-sg-flow ");
            }
        }
    });

    it("does not include React Flow's default theme (colors from style.css)", () => {
        // No default colors that only style.css has (node border / Controls button background).
        expect(XYFLOW_BASE_CSS).not.toContain("--xy-node-background-color-default");
        expect(XYFLOW_BASE_CSS).not.toContain("--xy-controls-button-background-color-default");
    });
});
