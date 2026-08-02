#!/usr/bin/env node
import { spawnSync } from "node:child_process";

// Production + site sources only (test doubles inflate clone %). Spec threshold 3%.
const result = spawnSync(
  "jscpd",
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
  {
    stdio: "inherit",
    cwd: process.cwd(),
    shell: process.platform === "win32",
    env: { ...process.env, PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH ?? ""}` },
  },
);
process.exit(result.status ?? 1);
