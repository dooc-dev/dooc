import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["packages/**/*.test.ts", "plugins/**/*.test.ts", "scripts/**/*.test.ts"],
        exclude: ["**/node_modules/**", "**/dist/**"],
    },
});
