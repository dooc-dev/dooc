import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("./language-picker.ts", import.meta.url), "utf8");
const extract = (start: string, end: string): string => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
};
const run = (code: string, globals: Record<string, unknown>) => {
    const context = createContext(globals);
    runInContext(
        transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
        context,
    );
    return context;
};

it("fits workspace labels with literal dots while retaining the full title and Unicode characters", () => {
    const input = { clientWidth: 108, value: "", title: "" };
    const context = run(
        `${extract("const fitWorkspaceLabel =", "\n/**")}\nglobalThis.fit = fitWorkspaceLabel;`,
        {
            document: {
                createElement: () => ({
                    getContext: () => ({
                        font: "",
                        measureText: (text: string) => ({ width: [...text].length * 10 }),
                    }),
                }),
            },
            getComputedStyle: () => ({
                font: "12px sans-serif",
                paddingLeft: "4px",
                paddingRight: "4px",
            }),
        },
    );
    const label = "feature🦄/long-repository";
    context.fit(input, label);
    expect(input.value).toBe("feature...");
    expect(input.title).toBe(label);
    input.clientWidth = 118;
    context.fit(input, label);
    expect(input.value).toBe("feature🦄...");
    input.clientWidth = 400;
    context.fit(input, label);
    expect(input.value).toBe(label);
    expect(input.title).toBe(label);
});

it("opens, navigates, selects, and closes the readonly workspace picker from the keyboard", () => {
    const input = new EventTarget();
    let opened = false;
    const open = vi.fn(() => {
        opened = true;
    });
    const hidePopover = vi.fn(() => {
        opened = false;
    });
    const item = { dataset: { value: "feature" } };
    const highlight = vi.fn();
    const choose = vi.fn();
    run(
        extract(
            'input.addEventListener("keydown"',
            '\n        list.addEventListener("pointerdown"',
        ),
        {
            input,
            workspace: true,
            translations: false,
            isOpen: () => opened,
            open,
            active: 1,
            highlight,
            list: { children: [0, 1, 2], querySelector: () => item },
            choose,
            popup: { hidePopover },
        },
    );
    const key = (value: string, isComposing = false) => {
        const event = new Event("keydown", { cancelable: true });
        Object.assign(event, { key: value, isComposing });
        input.dispatchEvent(event);
        return event;
    };
    expect(key("Enter", true).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(key(" ").defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    key("ArrowDown");
    expect(highlight).toHaveBeenLastCalledWith(2);
    key("ArrowUp");
    expect(highlight).toHaveBeenLastCalledWith(0);
    key("Home");
    expect(highlight).toHaveBeenLastCalledWith(0);
    key("End");
    expect(highlight).toHaveBeenLastCalledWith(2);
    key("Enter");
    expect(choose).toHaveBeenCalledWith(item);
    key("Escape");
    expect(hidePopover).toHaveBeenCalledOnce();
    expect(opened).toBe(false);
    key("ArrowDown");
    expect(open).toHaveBeenCalledTimes(2);
});

it.each([true, false])("shows unavailable options only in workspace pickers (%s)", (workspace) => {
    const element = () => ({
        dataset: {} as Record<string, string>,
        attributes: {} as Record<string, string>,
        children: [] as unknown[],
        textContent: "",
        setAttribute(name: string, value: string) {
            this.attributes[name] = value;
        },
        append(child: unknown) {
            this.children.push(child);
        },
        replaceChildren(...children: unknown[]) {
            this.children = children;
        },
    });
    const list = {
        children: [] as ReturnType<typeof element>[],
        replaceChildren(fragment: { children: ReturnType<typeof element>[] }) {
            this.children = fragment.children;
        },
    };
    const reason = "This branch is unavailable while its workspace is disconnected.";
    const select = {
        id: "workspace-select-1",
        disabled: false,
        options: [
            { value: "main", text: "main/repo", selected: true, dataset: {} },
            {
                value: "offline",
                text: "offline/repo",
                title: reason,
                disabled: true,
                dataset: { unavailable: reason },
            },
            { value: "create", text: "Create branch...", dataset: { create: "true" } },
        ],
    };
    run(`${extract("const render =", "\n        const sync =")}\nrender();`, {
        workspace,
        translations: false,
        isOpen: () => false,
        query: "",
        select,
        list,
        document: { createElement: element, createDocumentFragment: element },
        empty: {},
        highlight: vi.fn(),
        t: (key: string) => key,
    });
    expect(list.children.map((item) => item.dataset.value)).toEqual(
        workspace ? ["main", "offline", "create"] : ["main", "create"],
    );
    if (workspace) {
        const unavailable = list.children[1];
        expect(unavailable?.attributes["aria-disabled"]).toBe("true");
        expect(unavailable?.attributes["aria-description"]).toBe(reason);
        expect(unavailable).toMatchObject({ title: reason, disabled: false });
        expect(unavailable?.children[1]).toMatchObject({
            className: "workspace-unavailable-icon",
            attributes: { "aria-hidden": "true" },
        });
        expect(list.children[2]?.dataset.create).toBe("true");
    }
});

it("rejects disabled or removed workspace rows and dispatches the creation action normally", () => {
    const select = {
        value: "main",
        disabled: false,
        options: [
            { value: "main", disabled: false },
            { value: "offline", disabled: true },
            { value: "create", disabled: false },
        ],
        dispatchEvent: vi.fn(),
    };
    const hidePopover = vi.fn();
    const sync = vi.fn();
    const context = run(
        `${extract("const choose =", "\n        const toggle =")}\nglobalThis.choose = choose;`,
        { workspace: true, translations: false, select, popup: { hidePopover }, sync, Event },
    );
    context.choose({ dataset: { value: "offline" } });
    context.choose({ dataset: { value: "removed" } });
    expect(select.value).toBe("main");
    expect(select.dispatchEvent).not.toHaveBeenCalled();
    expect(hidePopover).not.toHaveBeenCalled();
    context.choose({ dataset: { value: "create" } });
    expect(select.value).toBe("create");
    expect(select.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "change", bubbles: true }),
    );
    expect(hidePopover).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledOnce();
});
