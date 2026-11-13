/** Remote CLI sessions retain repository files without executing their workspace configuration. */
export const allowsWorkspaceCode = (): boolean => process.env.DOOC_REMOTE_WORKSPACE !== "1";
