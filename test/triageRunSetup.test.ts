import { describe, expect, it } from "vitest";
import {
  buildSubmitOnlyTriageSessionTools,
  buildTriageRunSetup,
} from "../src/agent/triage/triageRunSetup.js";
import type { WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import { makeTestConfig } from "./helpers/config.js";

function checkout(): WritablePrCheckout {
  return {
    dir: "/tmp/checkout",
    headRef: "main",
    baseSha: "a".repeat(40),
    commit: async () => ({ sha: "b".repeat(40), diff: "" }),
    push: async () => undefined,
    listCommittedShas: () => [],
    listCommittedDetails: () => [],
  };
}

const inventory = [
  {
    rootCommentId: 1,
    lens: "review" as const,
    path: "src/app.ts",
    line: 1,
    severity: "P2" as const,
    titleSnippet: "P2 · Bug",
    humanReplies: [],
    threadUrl: "https://github.test/thread",
  },
];

describe("buildSubmitOnlyTriageSessionTools", () => {
  it("keeps commitFix and edit tools so pending autofixes can still be committed", () => {
    const setup = buildTriageRunSetup({
      cfg: makeTestConfig(),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(),
      inventory,
    });

    const finalize = buildSubmitOnlyTriageSessionTools(setup);
    const names = finalize.piTools.map((tool) => tool.name).sort();

    expect(names).toEqual(
      [
        "commitFix",
        "createWorkspaceFile",
        "editWorkspaceFile",
        "getWorkspaceDiff",
        "readWorkspaceFile",
        "submitTriage",
      ].sort(),
    );
    expect(finalize.executors.commitFix).toEqual(expect.any(Function));
    expect(finalize.executors.submitTriage).toEqual(expect.any(Function));
    expect(finalize.executors.searchWorkspace).toBeUndefined();
  });

  it("falls back to the full setup when submit or commitFix would be missing", () => {
    const setup = buildTriageRunSetup({
      cfg: makeTestConfig(),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(),
      inventory,
    });
    const stripped = {
      ...setup,
      piTools: setup.piTools.filter((tool) => tool.name !== "submitTriage"),
      executors: Object.fromEntries(
        Object.entries(setup.executors).filter(([name]) => name !== "submitTriage"),
      ),
    };
    const fallback = buildSubmitOnlyTriageSessionTools(stripped);
    expect(fallback.piTools).toBe(stripped.piTools);
    expect(fallback.executors).toBe(stripped.executors);
  });
});
