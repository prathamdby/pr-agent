import { vi } from "vitest";

/** Default stub so publish/ack paths never hit the live Checks API in unit tests. */
vi.mock("../../src/github/ciStatus.js", () => ({
  listCheckRunsForHead: vi.fn(async () => ({ checkRuns: [], truncated: false })),
  listLegacyCommitStatusesForHead: vi.fn(async () => []),
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
  isMissingChecksPermissionError: vi.fn(() => false),
}));
