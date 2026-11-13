import { RELOAD_ICON_PATH } from "../../engine/src/core/icons.js";
import { pageWorkspace } from "../../workspace/src/client.js";
import { workspaceId } from "../../workspace/src/connection.js";
import type { GitPullRequest, GitState } from "../../workspace/src/git-types.js";
import { confirmDialog } from "./edit-dialog.js";
import { openWorkspaceBranch, updateWorkspaceLocation } from "./git-branches.js";
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

interface GitDrafts {
    pullRequests: Map<
        number,
        { title: string; body: string; base: string; draft: boolean; revision: string }
    >;
    message: string;
    branchName: string;
    view: "changes" | "pull-requests";
    opened: Set<string>;
}

// Keep drafts across navigation without sharing them between repositories or branches.
const savedDrafts = new Map<string, GitDrafts>();
let viewSequence = 0;
const draftsFor = (workspace: string, branch: string): GitDrafts => {
    const key = JSON.stringify([workspace, branch]);
    let drafts = savedDrafts.get(key);
    if (!drafts) {
        drafts = {
            pullRequests: new Map(),
            message: "",
            branchName: "",
            view: "changes",
            opened: new Set(),
        };
        savedDrafts.set(key, drafts);
    }
    return drafts;
};
window.addEventListener("beforeunload", (event) => {
    if ([...savedDrafts.values()].some((drafts) => drafts.pullRequests.size || drafts.message))
        event.preventDefault();
});

export const mountGit = (
    host = document.getElementById("git-manager"),
    workspace = workspaceId(),
): (() => void) | undefined => {
    if (!host || host.dataset.mounted) return;
    const client = pageWorkspace(workspace);
    const viewId = `git-${++viewSequence}`;
    host.dataset.mounted = "true";
    let state: GitState | undefined;
    let busy = false;
    let disposed = false;
    const notice = element("p", "git-notice");
    notice.setAttribute("role", "status");
    const controls = element("fieldset", "git-controls");
    host.append(notice, controls);

    const request = <T>(input: Record<string, unknown>) =>
        client.request<T>("git", { version: state?.version, ...input });
    const load = async () => {
        const next = await request<GitState>({ action: "read" });
        if (disposed) return;
        state = next;
        if (workspaceId() === workspace) updateWorkspaceLocation(next);
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
    const openBranch = async (branch: string, create = false, saved?: () => void) => {
        if (busy || disposed) return;
        busy = controls.disabled = true;
        notice.textContent = t("Working…");
        try {
            await openWorkspaceBranch(
                branch,
                create,
                workspace,
                host.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId,
            );
            saved?.();
            notice.textContent = "";
        } catch (error) {
            notice.textContent = error instanceof Error ? error.message : String(error);
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
        const { opened } = draftsFor(workspace, state?.branch || state?.head || "");
        const node = element("details", "resource-item");
        node.open = opened.has(key);
        node.addEventListener("toggle", () => (node.open ? opened.add(key) : opened.delete(key)));
        return node;
    };
    const prForm = (pr?: GitPullRequest) => {
        const branch = state?.branch || state?.head || "";
        const version = state?.version;
        const drafts = draftsFor(workspace, branch).pullRequests;
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
        if (!pr) form.append(element("p", "git-caption", `${t("Source branch")}: ${branch}`));
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
        if (pr?.state && pr.state !== "open")
            for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
                "input, textarea",
            ))
                field.readOnly = true;
        save.disabled =
            Boolean(pr?.state && pr.state !== "open") ||
            !state?.origin?.capabilities.includes(pr ? "updatePr" : "createPr") ||
            (!pr && (!state.branch || !state.head));
        actions.append(save);
        form.onsubmit = (event) => {
            event.preventDefault();
            void perform(
                pr
                    ? {
                          version,
                          action: "updatePr",
                          number: pr.number,
                          title: draft.title,
                          body: draft.body,
                          revision: draft.revision,
                      }
                    : {
                          version,
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
            if (
                state?.origin?.capabilities.includes("mergePr") &&
                (!pr.state || pr.state === "open")
            ) {
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
                                        version,
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
        const current = state;
        if (!current || disposed) return;
        const drafts = draftsFor(workspace, current.branch || current.head);
        const act = (input?: Record<string, unknown>, saved?: () => void) =>
            perform(input ? { version: current.version, ...input } : undefined, saved);
        const changesPanel = element("section");
        changesPanel.id = `${viewId}-changes`;
        changesPanel.setAttribute("aria-label", t("Changes"));
        const pullRequestsPanel = element("section");
        pullRequestsPanel.id = `${viewId}-pull-requests`;
        pullRequestsPanel.setAttribute("aria-label", t("Pull requests"));
        changesPanel.hidden = drafts.view !== "changes";
        pullRequestsPanel.hidden = drafts.view !== "pull-requests";
        const synchronization = element("section");
        synchronization.setAttribute("aria-label", t("Synchronization"));
        controls.replaceChildren();
        const toolbar = element("div", "git-toolbar");
        toolbar.append(
            element("strong", "resource-name", current.repo),
            element("span", "resource-source", current.branch || current.head.slice(0, 7)),
            button("Reload", () => void act()),
        );
        if (current.origin?.capabilities.includes("createPr"))
            toolbar.append(
                button("Create pull request", () => {
                    drafts.view = "pull-requests";
                    drafts.opened.add("new-pr");
                    render();
                    controls
                        .querySelector<HTMLInputElement>(`#${viewId}-pull-requests input`)
                        ?.focus();
                }),
            );
        controls.append(toolbar);
        const branches = element("div", "git-actions");
        const select = element("select");
        select.setAttribute("aria-label", t("Branch"));
        for (const branch of [...new Set([current.branch, ...current.branches])]) {
            const option = element("option", "", branch || current.head.slice(0, 7));
            option.value = branch;
            select.append(option);
        }
        select.onchange = () => {
            const selected = select.value;
            if (busy || selected === current.branch) return;
            select.disabled = true;
            void (async () => {
                await openBranch(selected);
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
        name.value = drafts.branchName;
        name.oninput = () => {
            drafts.branchName = name.value;
        };
        const create = actionButton("Create branch");
        create.type = "submit";
        createBranch.append(name, create);
        createBranch.onsubmit = (event) => {
            event.preventDefault();
            void openBranch(name.value, true, () => {
                drafts.branchName = "";
            });
        };
        const branchControls = element("div", "git-branches");
        branchControls.append(branches, createBranch);
        controls.append(branchControls);
        const tabs = element("nav", "resource-tabs");
        tabs.setAttribute("aria-label", t("Git views"));
        for (const [view, label, count] of [
            ["changes", "Changes", current.changes.length],
            ["pull-requests", "Pull requests", current.origin?.pullRequests.length ?? 0],
        ] as const) {
            const tab = element("a", "", `${t(label)} (${count})`);
            tab.href = `#${viewId}-${view}`;
            tab.dataset.gitView = view;
            tab.setAttribute("aria-controls", `${viewId}-${view}`);
            if (drafts.view === view) tab.setAttribute("aria-current", "page");
            tab.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                drafts.view = view;
                changesPanel.hidden = view !== "changes";
                pullRequestsPanel.hidden = view !== "pull-requests";
                for (const item of tabs.querySelectorAll("a")) item.removeAttribute("aria-current");
                tab.setAttribute("aria-current", "page");
            };
            tabs.append(tab);
        }
        controls.append(synchronization, tabs, changesPanel, pullRequestsPanel);
        const stash = element("div", "git-toolbar git-stash");
        const saved = element(
            "span",
            "resource-name",
            current.stash ? current.stash.label : t("Stash · empty"),
        );
        saved.title = current.stash?.label ?? t("Stash · empty");
        stash.append(
            saved,
            button(
                current.stash ? "Restore stash" : "Stash changes",
                () => void act({ action: current?.stash ? "restoreStash" : "stash" }),
                current.stash ? !!current.changes.length : !current.changes.length || !current.head,
            ),
        );
        if (
            current.localCapabilities === undefined ||
            current.localCapabilities.includes(current.stash ? "restoreStash" : "stash")
        )
            changesPanel.append(stash);
        const changes = element("div", "resource-toolbar");
        changes.append(
            element("span", "", t("Changes")),
            element("span", "resource-count", String(current.changes.length)),
        );
        changesPanel.append(changes, element("p", "git-caption", t("Git uses saved files.")));
        for (const change of current.changes) {
            const row = details(`file:${change.path}`);
            const summary = element("summary");
            const path = element("span", "resource-name", change.path);
            path.title = change.path;
            summary.append(element("span", "git-status", change.index + change.worktree), path);
            if (change.worktree !== " ")
                summary.append(
                    button("Stage", () => void act({ action: "stage", path: change.path })),
                );
            if (![" ", "?"].includes(change.index))
                summary.append(
                    button("Unstage", () => void act({ action: "unstage", path: change.path })),
                );
            const diff = element("pre", "git-diff");
            row.append(summary, diff);
            let loaded = false;
            row.addEventListener("toggle", () => {
                if (!row.open || loaded || busy) return;
                loaded = true;
                diff.textContent = t("Working…");
                void request<{ diff: string }>({
                    action: "diff",
                    path: change.path,
                    version: current.version,
                }).then(
                    (data) => {
                        diff.textContent = data.diff;
                    },
                    (error) => {
                        loaded = false;
                        diff.textContent = String(error.message);
                    },
                );
            });
            changesPanel.append(row);
        }
        if (!current.changes.length)
            changesPanel.append(element("p", "git-caption", t("Working tree clean")));
        const commit = element("form", "git-form git-commit");
        commit.append(
            input(
                "Commit message",
                drafts.message,
                (value) => {
                    drafts.message = value;
                },
                true,
            ),
        );
        const save = actionButton("Commit staged changes");
        save.type = "submit";
        save.disabled = !current.changes.some((change) => ![" ", "?"].includes(change.index));
        commit.append(save);
        commit.onsubmit = (event) => {
            event.preventDefault();
            void act({ action: "commit", message: drafts.message }, () => {
                drafts.message = "";
            });
        };
        changesPanel.append(commit);
        const origin = current.origin;
        const remote = element("div", "git-toolbar");
        remote.append(
            element("strong", "", t("Synchronization")),
            element("span", "resource-name", origin?.name ?? "origin"),
        );
        for (const [action, label] of [
            ["fetch", "Fetch"],
            ["pull", "Pull (fast-forward)"],
            ["push", "Push"],
        ] as const) {
            if (origin?.capabilities.includes(action))
                remote.append(
                    button(
                        label,
                        () => void act({ action }),
                        (action !== "fetch" && (!current.branch || !current.head)) ||
                            (action === "pull" && !!current.changes.length),
                    ),
                );
        }
        synchronization.append(remote);
        if (!origin) {
            const reason =
                current.originError || t("Remote operations are not available for this workspace.");
            synchronization.append(element("p", "git-caption", reason));
            pullRequestsPanel.append(element("p", "git-caption", reason));
            return;
        }
        if (current.upstream)
            synchronization.append(
                element(
                    "p",
                    "git-caption",
                    `${current.upstream} · ↑${current.ahead} ↓${current.behind}`,
                ),
            );
        pullRequestsPanel.append(element("div", "resource-toolbar", t("Pull requests")));
        if (origin.capabilities.includes("createPr")) {
            const create = details("new-pr");
            create.append(element("summary", "", t("Create pull request")), prForm());
            pullRequestsPanel.append(create);
            if (!current.branch || !current.head)
                pullRequestsPanel.append(
                    element(
                        "p",
                        "git-caption",
                        t("Create a commit on a branch before opening a pull request."),
                    ),
                );
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
                element(
                    "span",
                    "resource-badge",
                    [
                        t(
                            pr.state === "merged"
                                ? "Merged"
                                : pr.state === "closed"
                                  ? "Closed"
                                  : "Open",
                        ),
                        pr.draft && (!pr.state || pr.state === "open") ? t("Draft") : "",
                        pr.status,
                    ]
                        .filter(Boolean)
                        .join(" · "),
                ),
            );
            row.append(summary, prForm(pr));
            pullRequestsPanel.append(row);
        }
        if (!origin.pullRequests.length)
            pullRequestsPanel.append(element("p", "git-caption", t("No pull requests")));
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
