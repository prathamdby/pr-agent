import { vi } from "vitest";

/** Default stub so publish/ack paths never hit the live Checks API in unit tests. */
vi.mock("../../src/github/ciStatus.js", () => ({
  listCheckRunsForHead: vi.fn(async () => ({ checkRuns: [], truncated: false })),
  listCheckRunAnnotations: vi.fn(async () => []),
  listLegacyCommitStatusesForHead: vi.fn(async () => []),
  isMissingChecksPermissionError: vi.fn(() => false),
}));
