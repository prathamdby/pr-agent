import { createWritableRepositoryReader } from "../../src/prWorkspace/repositoryReader.js";
import { createCachedPrDiffIndex } from "../../src/review/placement/reviewDiffIndex.js";
import { type LocalPrWorkspace } from "../../src/prWorkspace/localPrWorkspace.js";
import { buildCheckoutCoverage } from "../../src/prWorkspace/repositoryReader.js";

export function mockLocalPrWorkspace(
  agentCwd = "/tmp/pr-agent",
  overrides?: Partial<
    Pick<LocalPrWorkspace["reader"], "checkoutMode" | "checkoutPaths" | "changedFiles" | "stats">
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
    reader: {
      ...createWritableRepositoryReader(agentCwd),
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
    },
    cleanup: async () => {},
  };
}
