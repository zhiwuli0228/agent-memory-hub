#!/usr/bin/env node
// CJS launcher for the ESM CLI (ADR-0024): npm installs `bin` as a symlink.
// When Node runs an ESM entry THROUGH a symlink, its relative imports
// (`./core/...`) resolve against the symlink's directory and die silently
// (exit 0, no output) on Linux. CJS module resolution uses realpath, so this
// tiny launcher hands off to the real ESM entry with correct base paths.
// Dynamic import (not require) keeps every Node version compatible.
import('../dist/cli.js').catch((e) => {
  console.error(e)
  process.exit(1)
})
