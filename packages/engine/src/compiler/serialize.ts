/** Body md → full file text (normalized to one trailing newline). */
export const assembleDoc = (body: string): string => {
    const b = body.replace(/\n+$/, "");
    return b === "" ? "" : `${b}\n`;
};
