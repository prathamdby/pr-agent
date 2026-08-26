import { createCachedPrDiffIndex } from "../../src/review/placement/reviewDiffIndex.js";
import {
  buildCheckoutCoverage,
  type LocalPrWorkspace,
} from "../../src/prWorkspace/localPrWorkspace.js";

export function mockLocalPrWorkspace(
  agentCwd = "/tmp/pr-agent",
  overrides?: Partial<
    Pick<LocalPrWorkspace, "checkoutMode" | "checkoutPaths" | "changedFiles" | "stats">
  >,
): LocalPrWorkspace {
  const checkoutMode = overrides?.checkoutMode ?? "full";
  const changedFiles = overrides?.changedFiles ?? [];
  const checkoutPaths = overrides?.checkoutPaths ?? new Set<string>();
  const stats = overrides?.stats ?? { truncated: false, totalChanges: 0, fileCount: 0 };
  let searchTruncated = false;
  return {
    rootDir: agentCwd,
    privateGitDir: `${agentCwd}/.git`,
    agentCwd,
    checkoutMode,
    changedFiles,
    changedFileByPath: new Map(changedFiles.map((file) => [file.path, file])),
    checkoutPaths,
    sortedCheckoutPaths: [...checkoutPaths].toSorted(),
    diffIndex: createCachedPrDiffIndex(),
    stats,
    grepLiteral: async () => ({ matches: [], truncated: false }),
    getDiffForPath: async () => "",
    getBlameForPath: async () => "",
    isPathInCheckout: () => false,
    getCoverage: () =>
      buildCheckoutCoverage({
        checkoutMode,
        checkoutPaths,
        changedFiles,
        stats,
        searchTruncated,
      }),
    noteSearchTruncated: () => {
      searchTruncated = true;
    },
    lookupSymbol: () => [],
    getSymbolIndexStatus: () => ({ available: false }),
    cleanup: async () => undefined,
  };
}
