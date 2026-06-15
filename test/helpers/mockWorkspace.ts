import { createCachedPrDiffIndex } from "../../src/review/placement/reviewDiffIndex.js";
import type { LocalPrWorkspace } from "../../src/prWorkspace/localPrWorkspace.js";

export function mockLocalPrWorkspace(agentCwd = "/tmp/pr-agent"): LocalPrWorkspace {
  return {
    rootDir: agentCwd,
    privateGitDir: `${agentCwd}/.git`,
    agentCwd,
    checkoutMode: "full",
    changedFiles: [],
    changedFileByPath: new Map(),
    checkoutPaths: new Set(),
    sortedCheckoutPaths: [],
    diffIndex: createCachedPrDiffIndex(),
    stats: { truncated: false, totalChanges: 0, fileCount: 0 },
    grepLiteral: async () => ({ matches: [], truncated: false }),
    getDiffForPath: async () => "",
    getBlameForPath: async () => "",
    isPathInCheckout: () => false,
    cleanup: async () => {},
  };
}
