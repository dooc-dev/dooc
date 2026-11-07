#!/usr/bin/env sh
set -eu
pnpm exec tsc --noEmit
pnpm exec vitest run
