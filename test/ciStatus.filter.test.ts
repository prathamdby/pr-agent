import { describe, expect, it, vi } from "vitest";

vi.unmock("../src/github/ciStatus.js");

const { listForRef } = vi.hoisted(() => ({
  listForRef: vi.fn(async () => ({ data: { check_runs: [] } })),
}));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(() => ({
    rest: { checks: { listForRef } },
  })),
}));

import { listCheckRunsForHead } from "../src/github/ciStatus.js";

describe("listCheckRunsForHead", () => {
  it("lists the latest check run per name for CI snapshots", async () => {
    await listCheckRunsForHead("tok", "o", "r", "abc123");
    expect(listForRef).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "o",
        repo: "r",
        ref: "abc123",
        filter: "latest",
      }),
    );
  });
});
