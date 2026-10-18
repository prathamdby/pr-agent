import { vi } from "vitest";

vi.mock("../../src/github/ciStatus.ts", () => ({
  listLegacyCommitStatusesForHeadDetailed: vi.fn(async () => ({
    legacyStatuses: [],
    truncated: false,
  })),
  readCiStatusSources: vi.fn(async () => ({
    checkRuns: [],
    legacyStatuses: [],
    checkRunsComplete: true,
    legacyStatusesComplete: true,
    sources: {
      checks: { access: "available", complete: true },
      statuses: { access: "available", complete: true },
    },
  })),
}));
