export const CHECK_KINDS = ["render", "languages", "themes"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export interface CheckOptions {
    /** Run only these checks; omitted means all checks. Manifest validity is always checked. */
    only?: readonly CheckKind[];
    /** Permit identical SVG files across themes, including symlinks and byte copies. */
    allowSharedSvg?: boolean;
    warningsAsErrors?: boolean;
}

export type CheckCode =
    | "INVOCATION_INVALID"
    | "CHECK_FAILED"
    | "MANIFEST_INVALID"
    | "RENDER_INVALID"
    | "FILE_MISSING"
    | "FILE_UNREADABLE"
    | "DOCUMENT_INVALID"
    | "ASSET_INVALID"
    | "LANGUAGE_INVALID"
    | "LANGUAGE_UNDECLARED"
    | "TRANSLATION_MISSING"
    | "TRANSLATION_ORPHAN"
    | "TRANSLATION_IDENTICAL"
    | "LANGUAGE_MISMATCH"
    | "LANGUAGE_SUSPECT"
    | "LANGUAGE_UNDETERMINED"
    | "LANGUAGE_UNCHECKED"
    | "THEME_INVALID"
    | "THEME_UNDECLARED"
    | "THEME_VARIANT_MISSING"
    | "THEME_VARIANT_ORPHAN"
    | "THEME_CONTENT_IDENTICAL"
    | "REMOTE_UNCHECKED";

export interface CheckDiagnostic {
    check: CheckKind | "config";
    code: CheckCode;
    severity: "error" | "warning" | "info";
    message: string;
    /** Path relative to report.root; lines and columns are one-based. */
    file: string;
    line?: number;
    column?: number;
    documentId?: string;
    sourceFile?: string;
    relatedFile?: string;
    /** Expected language, normalized to ISO 639-3. */
    language?: string;
    detectedLanguage?: string;
    theme?: string;
}

export interface CheckReport {
    schemaVersion: 1;
    root: string;
    /** Checks actually requested, so a partial report cannot be mistaken for a full audit. */
    checks: CheckKind[];
    languages: string[];
    themes: string[];
    /** Sorted deterministically by file, line, code, language and theme. */
    diagnostics: CheckDiagnostic[];
    summary: { errors: number; warnings: number; info: number };
    /** 0 = passed, 1 = findings failed policy, 2 = invocation or execution failed. */
    exitCode: 0 | 1 | 2;
}
