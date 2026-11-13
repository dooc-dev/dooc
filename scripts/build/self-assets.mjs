import { cpSync } from "node:fs";

cpSync("scripts/release/install.sh", "dist/install.sh");
