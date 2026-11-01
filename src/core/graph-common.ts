// Layout helpers shared by the two DSLs that draw static SVG graphs (`:::schema` = ER diagram /
// `:::graph` = relationship graph); browser-safe, no dependencies. Text-width estimation, band
// (level) assignment, column splitting, orthogonal paths and namespace uids are the rules behind
// "same input, same picture", so they live here as the SoT instead of being written twice.

/** Coordinates are rounded to one decimal place (keeps the SVG stable and short). */
export const round1 = (v: number): number => Math.round(v * 10) / 10;

// Full-width characters (CJK / full-width symbols) count as double width. Approximates 12px mono
// (font metrics can't be measured, so this is an estimate = deterministic).
const charW = (code: number): number => (code > 0x2e7f ? 12 : 6.7);

/** Estimated rendered width (px) of a string. scale = actual font size / 12. */
export const textW = (s: string, scale = 1): number =>
    [...s].reduce((sum, ch) => sum + charW(ch.codePointAt(0) ?? 0) * scale, 0);

/**
 * Dependency depth = the level of the column band. `deps[i]` = the set of elements i depends on
 * (the caller decides which direction counts as "dependency" — schema uses "referenced target",
 * graph uses "incoming source").
 * Elements with no dependencies get 0; otherwise 1 + max(level of dependencies).
 * A memoized (settled) DFS plus an in-progress set (onStack) detects cycles; back-edges to an
 * ancestor still being explored don't contribute (they stay -1 and are ignored), so recursion is
 * cut off deterministically. Levels are settled in order from index 0, so the same input always
 * yields the same levels.
 */
export const depthLevels = (deps: readonly ReadonlySet<number>[]): number[] => {
    const level = new Array<number>(deps.length).fill(0);
    const settled = new Array<boolean>(deps.length).fill(false);
    const onStack = new Array<boolean>(deps.length).fill(false);
    const levelOf = (i: number): number => {
        if (settled[i]) {
            return level[i] ?? 0;
        }
        if (onStack[i]) {
            // back-edge (cycle) — this dependency doesn't contribute to the level.
            return -1;
        }
        onStack[i] = true;
        let max = -1;
        for (const d of deps[i] ?? []) {
            max = Math.max(max, levelOf(d));
        }
        onStack[i] = false;
        const result = max < 0 ? 0 : max + 1;
        level[i] = result;
        settled[i] = true;
        return result;
    };
    deps.forEach((_, i) => {
        levelOf(i);
    });
    return level;
};

/**
 * Splits a tall column into several columns (so it doesn't grow too tall). Takes box heights
 * (in original order); returns the positions per column (indices into the input array) — the
 * split is greedy = deterministic.
 */
export const splitByHeight = (
    heights: readonly number[],
    gapY: number,
    maxColH: number,
): number[][] => {
    const all = heights.map((_, i) => i);
    const total = heights.reduce((a, b) => a + b, 0) + gapY * Math.max(0, heights.length - 1);
    const count = Math.max(1, Math.ceil(total / maxColH));
    if (count === 1) {
        return [all];
    }
    const target = total / count;
    const cols: number[][] = [];
    let col: number[] = [];
    let colH = 0;
    for (const i of all) {
        const h = heights[i] ?? 0;
        if (col.length > 0 && colH + h > target && cols.length < count - 1) {
            cols.push(col);
            col = [];
            colH = 0;
        }
        col.push(i);
        colH += h + gapY;
    }
    cols.push(col);
    return cols;
};

/**
 * Orthogonal path (horizontal from the source → vertical along the corridor (cx) → horizontal to
 * the target). Corners are rounded with quadratic curves. Degenerates to a single straight line
 * when sy ≈ ty.
 */
export const orthPath = (
    sx: number,
    sy: number,
    cx: number,
    ty: number,
    tx: number,
    corner: number,
): string => {
    const p = (x: number, y: number): string => `${round1(x)},${round1(y)}`;
    if (Math.abs(sy - ty) < 0.6) {
        return `M${p(sx, sy)} L${p(tx, ty)}`;
    }
    const outDir = cx >= sx ? 1 : -1;
    const inDir = tx >= cx ? 1 : -1;
    const vDir = ty > sy ? 1 : -1;
    const r1 = Math.min(corner, Math.abs(cx - sx), Math.abs(ty - sy) / 2);
    const r2 = Math.min(corner, Math.abs(tx - cx), Math.abs(ty - sy) / 2);
    return [
        `M${p(sx, sy)}`,
        `L${p(cx - outDir * r1, sy)}`,
        `Q${p(cx, sy)} ${p(cx, sy + vDir * r1)}`,
        `L${p(cx, ty - vDir * r2)}`,
        `Q${p(cx, ty)} ${p(cx + inDir * r2, ty)}`,
        `L${p(tx, ty)}`,
    ].join(" ");
};

/**
 * String → deterministic short id (djb2). Callers pass the model serialized as JSON; the result
 * namespaces SVG classes / marker ids (= multiple graphs on the same page don't collide).
 */
export const hashId = (src: string): string => {
    let hash = 5381;
    for (let i = 0; i < src.length; i += 1) {
        hash = (hash * 33 + src.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
};
