import { RELOAD_ICON_PATH } from "../core/icons.js";
import { confirmDialog } from "./edit-dialog.js";
import { confirmBranchSwitch, gitRequest, updateWorkspaceLocation } from "./git-branches.js";
import type { GitPullRequest, GitState } from "./git-types.js";
import { t } from "./i18n.js";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
};

const actionIcon: Record<string, string> = {
    Reload: RELOAD_ICON_PATH,
    Stage: "M10 4v12M4 10h12",
    Unstage: "M4 10h12",
    Fetch: "M10 3v10m-4-4 4 4 4-4M4 16h12",
    "Pull (fast-forward)": "M10 3v10m-4-4 4 4 4-4M3 13v4h14v-4",
    Push: "M10 14V4m-4 4 4-4 4 4M3 13v4h14v-4",
    "Create branch": "M5 5v10M5 10h5a5 5 0 0 0 5-5M12 5h6M15 2v6",
};
const actionButton = (label: string) => {
    const node = element("button", `pbtn${actionIcon[label] ? "" : " git-text-button"}`);
    node.type = "button";
    node.title = t(label);
    node.setAttribute("aria-label", t(label));
    if (actionIcon[label])
        node.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${actionIcon[label]}"/></svg>`;
    else node.textContent = t(label);
    return node;
};

// Keep drafts when navigating between Files, documents and the Git page.
const drafts = new Map<
    number,
    { title: string; body: string; base: string; draft: boolean; revision: string }
>();
let message = "";
let branchName = "";
window.addEventListener("beforeunload", (event) => {
    if (drafts.size || message) event.preventDefault();
});

export const mountGit = (): (() => void) | undefined => {
    const host = document.getElementById("git-manager");
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = "true";
    let state: GitState | undefined;
    let busy = false;
    let disposed = false;
    const opened = new Set<string>();
    const notice = element("p", "git-notice");
    notice.setAttribute("role", "status");
    const controls = element("fieldset", "git-controls");
    host.append(notice, controls);

    const request = async (input: Record<string, unknown>) => {
        return gitRequest({ version: state?.version, ...input });
    };
    const load = async () => {
        const next = (await request({ action: "read" })) as GitState;
        if (disposed) return;
        state = next;
        updateWorkspaceLocation(next);
        render();
    };
    const perform = async (input?: Record<string, unknown>, saved?: () => void) => {
        if (busy || disposed) return;
        busy = controls.disabled = true;
        notice.textContent = t("Working…");
        let completed = false;
        try {
            if (input) {
                await request(input);
                completed = true;
                saved?.();
            }
            await load();
            notice.textContent = input ? t("Done") : "";
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (input && !completed) await load().catch(() => {});
            notice.textContent = completed
                ? t("Operation completed, but reload failed: {error}", { error: detail })
                : detail;
        } finally {
            busy = controls.disabled = false;
        }
    };
    const button = (label: string, click: () => void, disabled = false) => {
        const node = actionButton(label);
        node.disabled = disabled;
        node.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            click();
        };
        return node;
    };
    const input = (
        label: string,
        value: string,
        change: (value: string) => void,
        multiline = false,
    ) => {
        const wrapper = element("label", "git-field", t(label));
        const field = multiline ? element("textarea") : element("input");
        field.value = value;
        field.required = !multiline;
        field.maxLength = multiline ? 65_536 : 256;
        if (field instanceof HTMLTextAreaElement) field.rows = 4;
        field.oninput = () => change(field.value);
        wrapper.append(field);
        return wrapper;
    };
    const details = (key: string) => {
        const node = element("details", "resource-item");
        node.open = opened.has(key);
        node.addEventListener("toggle", () => (node.open ? opened.add(key) : opened.delete(key)));
        return node;
    };
    const prForm = (pr?: GitPullRequest) => {
        const id = pr?.number ?? 0;
        const draft = drafts.get(id) ?? {
            title: pr?.title ?? "",
            body: pr?.body ?? "",
            base: pr?.base ?? state?.origin?.defaultBranch ?? "",
            draft: true,
            revision: pr ? JSON.stringify(pr) : "",
        };
        const change = () => drafts.set(id, draft);
        const form = element("form", "git-form resource-body");
        form.append(
            input("Title", draft.title, (value) => {
                draft.title = value;
                change();
            }),
        );
        form.append(
            input(
                "Description",
                draft.body,
                (value) => {
                    draft.body = value;
                    change();
                },
                true,
            ),
        );
        const actions = element("div", "git-actions");
        const save = actionButton(pr ? "Save" : "Create pull request");
        save.type = "submit";
        save.disabled = !state?.origin?.capabilities.includes(pr ? "updatePr" : "createPr");
        actions.append(save);
        form.onsubmit = (event) => {
            event.preventDefault();
            void perform(
                pr
                    ? {
                          action: "updatePr",
                          number: pr.number,
                          title: draft.title,
                          body: draft.body,
                          revision: draft.revision,
                      }
                    : {
                          action: "createPr",
                          title: draft.title,
                          body: draft.body,
                          base: draft.base,
                          draft: draft.draft,
                      },
                () => drafts.delete(id),
            );
        };
        if (!pr) {
            form.append(
                input("Base branch", draft.base, (value) => {
                    draft.base = value;
                    change();
                }),
            );
            const label = element("label", "git-checkbox");
            const checkbox = element("input");
            checkbox.type = "checkbox";
            checkbox.checked = draft.draft;
            checkbox.onchange = () => {
                draft.draft = checkbox.checked;
                change();
            };
            label.append(checkbox, document.createTextNode(t("Draft")));
            form.append(label);
        } else {
            const link = element("a", "resource-source", t("Open pull request"));
            try {
                const url = new URL(pr.url);
                if (url.protocol === "https:" && !url.username && !url.password) {
                    link.href = url.href;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    actions.append(link);
                }
            } catch {
                /* An invalid provider URL must not become a navigable link. */
            }
            if (state?.origin?.capabilities.includes("mergePr")) {
                const method = element("select");
                method.setAttribute("aria-label", t("Merge method"));
                for (const value of ["merge", "squash", "rebase"]) {
                    const option = element("option", "", value);
                    option.value = value;
                    method.append(option);
                }
                actions.append(
                    method,
                    button(
                        "Merge pull request",
                        () => {
                            void (async () => {
                                if (
                                    await confirmDialog(
                                        t("Merge #{number} into {base} using {method}?", {
                                            number: pr.number,
                                            base: pr.base,
                                            method: method.value,
                                        }),
                                        t("Merge pull request"),
                                    )
                                )
                                    await perform({
                                        action: "mergePr",
                                        number: pr.number,
                                        revision: JSON.stringify(pr),
                                        method: method.value,
                                    });
                            })();
                        },
                        pr.draft,
                    ),
                );
            }
        }
        if (drafts.has(id))
            actions.append(
                button("Reset edits", () => {
                    void (async () => {
                        if (
                            await confirmDialog(
                                t("Discard these pull request edits?"),
                                t("Reset edits"),
                            )
                        ) {
                            drafts.delete(id);
                            render();
                        }
                    })();
                }),
            );
        form.append(actions);
        return form;
    };
    const render = () => {
        if (!state || disposed) return;
        controls.replaceChildren();
        const toolbar = element("div", "git-toolbar");
        toolbar.append(
            element("strong", "resource-name", state.repo),
            button("Reload", () => void perform()),
        );
        controls.append(toolbar);
        const branches = element("div", "git-actions");
        const select = element("select");
        select.setAttribute("aria-label", t("Branch"));
        for (const branch of [...new Set([state.branch, ...state.branches])]) {
            const option = element("option", "", branch || state.head.slice(0, 7));
            option.value = branch;
            select.append(option);
        }
        select.onchange = () => {
            const selected = select.value;
            const current = state;
            if (!current || busy) return;
            select.disabled = true;
            void (async () => {
                if (await confirmBranchSwitch(current, selected))
                    await perform({
                        action: "switch",
                        branch: selected,
                        stash: !!current.changes.length,
                    });
                select.value = state?.branch ?? "";
                select.disabled = false;
            })();
        };
        branches.append(select);
        const createBranch = element("form", "git-actions");
        const name = element("input");
        name.placeholder = t("New branch");
        name.setAttribute("aria-label", t("New branch"));
        name.required = true;
        name.maxLength = 256;
        name.value = branchName;
        name.oninput = () => {
            branchName = name.value;
        };
        const create = actionButton("Create branch");
        create.type = "submit";
        createBranch.append(name, create);
        createBranch.onsubmit = (event) => {
            event.preventDefault();
            void perform({ action: "branch", branch: name.value }, () => {
                branchName = "";
            });
        };
        const branchControls = element("div", "git-branches");
        branchControls.append(branches, createBranch);
        controls.append(branchControls);
        const stash = element("div", "git-toolbar git-stash");
        const saved = element(
            "span",
            "resource-name",
            state.stash ? state.stash.label : t("Stash · empty"),
        );
        saved.title = state.stash?.label ?? t("Stash · empty");
        stash.append(
            saved,
            button(
                state.stash ? "Restore stash" : "Stash changes",
                () => void perform({ action: state?.stash ? "restoreStash" : "stash" }),
                state.stash ? !!state.changes.length : !state.changes.length || !state.head,
            ),
        );
        controls.append(stash);
        const changes = element("div", "resource-toolbar");
        changes.append(
            element("span", "", t("Changes")),
            element("span", "resource-count", String(state.changes.length)),
        );
        controls.append(changes, element("p", "git-caption", t("Git uses saved files.")));
        for (const change of state.changes) {
            const row = details(`file:${change.path}`);
            const summary = element("summary");
            const path = element("span", "resource-name", change.path);
            path.title = change.path;
            summary.append(element("span", "git-status", change.index + change.worktree), path);
            if (change.worktree !== " ")
                summary.append(
                    button("Stage", () => void perform({ action: "stage", path: change.path })),
                );
            if (![" ", "?"].includes(change.index))
                summary.append(
                    button("Unstage", () => void perform({ action: "unstage", path: change.path })),
                );
            const diff = element("pre", "git-diff");
            row.append(summary, diff);
            let loaded = false;
            row.addEventListener("toggle", () => {
                if (!row.open || loaded || busy) return;
                loaded = true;
                diff.textContent = t("Working…");
                void request({ action: "diff", path: change.path }).then(
                    (data) => {
                        diff.textContent = data.diff;
                    },
                    (error) => {
                        loaded = false;
                        diff.textContent = String(error.message);
                    },
                );
            });
            controls.append(row);
        }
        if (!state.changes.length)
            controls.append(element("p", "git-caption", t("Working tree clean")));
        const commit = element("form", "git-form git-commit");
        commit.append(
            input(
                "Commit message",
                message,
                (value) => {
                    message = value;
                },
                true,
            ),
        );
        const save = actionButton("Commit staged changes");
        save.type = "submit";
        save.disabled = !state.changes.some((change) => ![" ", "?"].includes(change.index));
        commit.append(save);
        commit.onsubmit = (event) => {
            event.preventDefault();
            void perform({ action: "commit", message }, () => {
                message = "";
            });
        };
        controls.append(commit);
        const origin = state.origin;
        const remote = element("div", "git-toolbar");
        remote.append(element("span", "resource-name", origin?.name ?? "origin"));
        for (const [action, label] of [
            ["fetch", "Fetch"],
            ["pull", "Pull (fast-forward)"],
            ["push", "Push"],
        ] as const) {
            if (origin?.capabilities.includes(action))
                remote.append(
                    button(
                        label,
                        () => void perform({ action }),
                        (action !== "fetch" && (!state.branch || !state.head)) ||
                            (action === "pull" && !!state.changes.length),
                    ),
                );
        }
        controls.append(remote);
        if (!origin) {
            controls.append(
                element(
                    "p",
                    "git-caption",
                    state.originError ||
                        t(
                            "Connect an origin provider from the viewer module to enable remote operations.",
                        ),
                ),
            );
            return;
        }
        if (state.upstream)
            controls.append(
                element("p", "git-caption", `${state.upstream} · ↑${state.ahead} ↓${state.behind}`),
            );
        controls.append(element("div", "resource-toolbar", t("Pull requests")));
        if (origin.capabilities.includes("createPr")) {
            const create = details("new-pr");
            create.append(element("summary", "", t("Create pull request")), prForm());
            controls.append(create);
        }
        for (const pr of origin.pullRequests) {
            const row = details(`pr:${pr.number}`);
            const summary = element("summary");
            const title = element("span", "resource-name", pr.title);
            title.title = pr.title;
            summary.append(
                element("span", "resource-badge", `#${pr.number}`),
                title,
                element("span", "resource-source", `${pr.head} → ${pr.base}`),
            );
            row.append(
                summary,
                element("p", "git-caption", `${pr.draft ? `${t("Draft")} · ` : ""}${pr.status}`),
                prForm(pr),
            );
            controls.append(row);
        }
        if (!origin.pullRequests.length)
            controls.append(element("p", "git-caption", t("No open pull requests")));
    };
    const relocalize = () => render();
    document.addEventListener("docs:ui-language", relocalize);
    controls.append(button("Reload", () => void perform()));
    void perform();
    return () => {
        disposed = true;
        document.removeEventListener("docs:ui-language", relocalize);
        delete host.dataset.mounted;
    };
};
