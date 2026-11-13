export const FOLDER_ICON_PATH = "M2 5h6l2 2h8v10H2Z";
export const RELOAD_ICON_PATH = "M17 8a7 7 0 1 0 0 5M17 3v5h-5";
export const SEARCH_ICON_PATH = "M14 14l4 4M15 9a6 6 0 1 1-12 0 6 6 0 0 1 12 0";

export const CHECK_ICON =
    '<svg class="ic-ok" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>';

export const PLUGINS_ICON =
    '<svg class="nav-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 2 4 2v5l-4 2-4-2V4Zm-4 2 4 2 4-2m-4 2v5M6 9l-4 2v5l4 2 4-2v-5m-8 0 4 2 4-2m-4 2v5m8-9 4 2v5l-4 2-4-2m0-5 4 2 4-2m-4 2v5"/></svg>';

const glyph = (paths: string): string =>
    `<svg class="nav-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** One glyph per Library view, so views are told apart without reading their names. */
export const LIBRARY_ICONS: Readonly<Record<string, string>> = {
    codeblocks: glyph('<path d="m7 6-4 4 4 4M13 6l4 4-4 4"/>'),
    urls: glyph(
        '<path d="M8.5 11.5a3 3 0 0 0 4.2 0l3-3a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-3 3a3 3 0 0 0 4.2 4.2l1-1"/>',
    ),
    "url-previews": glyph(
        '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 8h14M6 12.5h5"/>',
    ),
    csv: glyph(
        '<rect x="3" y="4" width="14" height="12" rx="1"/><path d="M3 8h14M3 12h14M8 4v12"/>',
    ),
    tsv: glyph('<path d="M3 6h8M3 10h8M3 14h8M13.5 7l3 3-3 3M17 5v10"/>'),
    mermaid: glyph(
        '<rect x="3" y="3" width="6" height="4" rx="1"/><rect x="11" y="13" width="6" height="4" rx="1"/><path d="M6 7v6a2 2 0 0 0 2 2h3"/>',
    ),
    callouth: glyph('<path d="M4 4h12v9H9l-4 3v-3H4Z"/>'),
    schemath: glyph(
        '<ellipse cx="10" cy="5" rx="6" ry="2.5"/><path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5"/>',
    ),
    graphth: glyph(
        '<circle cx="5" cy="10" r="2"/><circle cx="15" cy="5" r="2"/><circle cx="15" cy="15" r="2"/><path d="m6.8 9.1 6.4-3.2M6.8 10.9l6.4 3.2"/>',
    ),
    termth: glyph('<path d="M5 3h10v14H5Z"/><path d="m8 12 2-5 2 5M8.7 10.5h2.6"/>'),
};
export const libraryIcon = (view: string): string | undefined =>
    Object.hasOwn(LIBRARY_ICONS, view) ? LIBRARY_ICONS[view] : undefined;
