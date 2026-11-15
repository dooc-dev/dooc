#!/usr/bin/env node
import { relayCommand } from "./mcp-relay.js";

relayCommand(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
