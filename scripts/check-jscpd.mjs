#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const localBin = path.join(process.cwd(), "node_modules", ".bin", "jscpd");
const cmd = fs.existsSync(localBin) ? localBin : "jscpd";

// Production + site sources only (test doubles inflate clone %). Spec threshold 3%.
const result = spawnSync(
  cmd,
  [
    "src",
    "site",
    "--ignore",
    "**/node_modules/**,**/dist/**,**/coverage/**,site/.output/**,site/routeTree.gen.ts,**/*.test.ts,**/*.test.tsx,**/__snapshots__/**",
    "--threshold",
    "3",
    "--reporters",
    "console,threshold",
  ],
  { stdio: "inherit", cwd: process.cwd(), shell: process.platform === "win32" },
);
process.exit(result.status ?? 1);
