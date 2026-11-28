import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("ignores generated output at every workspace depth while keeping source inputs", () => {
    const generated = [
        "build/index.html",
        "dist/bundle.zip",
        "dooc-editor-node/server.mjs",
        "dooc-editor-web/index.html",
        "dooc-reader-node/server.mjs",
        "dooc-reader-web/index.html",
        ".dooc/user/credentials.json",
        ".dooc/snapshots/snapshot.json",
        ".dooc/versions/version.zip",
        ".dooc/versions.json",
        ".dooc/versions.lock",
        "reports/review.md",
        "audit-reports/dependencies.csv",
        "screenshots/reader.png",
        "tmp/check.json",
    ];
    const ignored = [
        ...["", "dooc-docs/", "sample/dooc-sample-project/"].flatMap((root) =>
            generated.map((file) => root + file),
        ),
        "dooc-docs/design/repository-artifacts.md",
        "dooc-docs/contents/md/progress.md",
        "dooc-docs/contents/md/icon-variants.md",
        "dooc-docs/contents/md/theme-variants.md",
        "dooc-docs/contents/html/icon-variants.html",
        "dooc-docs/contents/html/theme-variants.html",
        "dooc-docs/contents/png/icon-variants.png",
        "dooc-docs/contents/png/theme-variants/current-dark-reader.png",
        "dooc-docs/contents/svg/icon-variants/solid.svg",
    ];
    const sources = [
        "dooc-docs/dooc.yaml",
        "dooc-docs/contents/md/development.md",
        "dooc-docs/contents/png/editor.png",
        "dooc-docs/contents/svg/_site.svg",
        "dooc-docs/contents/html/architecture.html",
        "dooc-docs/themes/dark/contents/svg/_site.svg",
        "sample/dooc-sample-project/dooc.yaml",
        "sample/dooc-sample-project/contents/html/roadmap.html",
        "sample/dooc-sample-saas/contents/log/application.log",
        "scripts/build/new-generator.mjs",
        "scripts/fixtures/dev-workspace/.gitignore",
        "scripts/fixtures/dev-workspace/.dooc/editor-tools/json.mjs",
        "scripts/fixtures/dev-workspace/.dooc/code-languages/taskplan.json",
        "dooc-docs/.dooc/fonts/project.woff2",
        "packages/frontend/src/flow-base-css.generated.ts",
    ];
    const repository = new URL("../", import.meta.url);
    const actual = execFileSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
        cwd: repository,
        input: `${[...ignored, ...sources].join("\0")}\0`,
        encoding: "utf8",
    })
        .split("\0")
        .filter(Boolean);
    expect(actual).toEqual(ignored);
    expect(
        execFileSync("git", ["ls-files", "-ci", "--exclude-standard"], {
            cwd: repository,
            encoding: "utf8",
        }),
    ).toBe("");
});
