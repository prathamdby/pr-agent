import { describe, expect, it } from "vitest";
import {
  classifyTriageBulkOutcome,
  classifyTriageBulkOutcomes,
  renderTriagePreview,
  renderTriageReport,
} from "../src/agent/triage/triageRender.js";
import {
  pathsFromUnifiedDiff,
  previewApprovalSets,
  remapBulkPayload,
} from "../src/agent/triage/previewApproval.js";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";
import type { TriagePayload } from "../src/review/triageSchema.js";
import {
  TRIAGE_PREVIEW_SENTINEL,
  TRIAGE_STALE_HEAD_NOTICE,
  TRIAGE_THREAD_RESOLUTION_NOTICE,
} from "../src/settings/index.js";

function thread(
  rootCommentId: number,
  overrides: Partial<BotFindingThread> = {},
): BotFindingThread {
  return {
    rootCommentId,
    lens: "review",
    path: "src/app.ts",
    line: 1,
    severity: "P1",
    titleSnippet: "P1 · Bug",
    humanReplies: [],
    threadUrl: "https://github.test/thread",
    ...overrides,
  };
}

describe("renderTriageReport policy suggestion footer", () => {
  it("does not add a policy suggestion footer when there are no dismissed verdicts", () => {
    const result = renderTriageReport({
      headSha: "a".repeat(40),
      inventory: [thread(1)],
      payload: {
        verdicts: [
          { verdict: "fixed", threadRootCommentId: 1, commitSha: "b".repeat(40), evidence: "done" },
        ],
      } as TriagePayload,
      commits: [],
      previouslyResolvedCount: 0,
    });

    expect(result).not.toContain("Policy suggestions");
  });

  it("adds a policy suggestion footer for dismissed verdicts", () => {
    const result = renderTriageReport({
      headSha: "a".repeat(40),
      inventory: [thread(1, { path: "src/auth/login.ts" }), thread(2, { path: "src/other.ts" })],
      payload: {
        verdicts: [
          {
            verdict: "dismissed",
            threadRootCommentId: 1,
            evidence: "False positive: input is sanitized upstream.",
          },
          {
            verdict: "fixed",
            threadRootCommentId: 2,
            commitSha: "b".repeat(40),
            evidence: "fixed",
          },
        ],
      } as TriagePayload,
      commits: [],
      previouslyResolvedCount: 0,
    });

    expect(result).toContain("Policy suggestions for dismissed findings");
    expect(result).toContain("Commit these to `.pr-agent/*.mdc` to steer future reviews:");
    expect(result).toContain("Create `.pr-agent/src-auth-login.mdc` with:");
    expect(result).toContain("False positive: input is sanitized upstream.");
    expect(result).not.toContain(".pr-agent.yml");
    const suggestionSection = result.split("Policy suggestions")[1];
    expect(suggestionSection).not.toContain("src/other.ts");
  });

  it("keeps stale-head and missing-thread notices independent of verdict counts", () => {
    const result = renderTriageReport({
      headSha: "a".repeat(40),
      inventory: [thread(1)],
      payload: {
        verdicts: [
          {
            verdict: "already-resolved",
            threadRootCommentId: 1,
            evidence: "current code already handles this",
          },
        ],
      } as TriagePayload,
      commits: [],
      previouslyResolvedCount: 0,
      notice: `${TRIAGE_STALE_HEAD_NOTICE}\n\n${TRIAGE_THREAD_RESOLUTION_NOTICE}`,
    });

    expect(result).toContain(TRIAGE_STALE_HEAD_NOTICE);
    expect(result).toContain(TRIAGE_THREAD_RESOLUTION_NOTICE);
    expect(result).toContain("1 Already resolved");
    expect(result).not.toContain("Pushed commits:");
  });
});

describe("renderTriagePreview", () => {
  it("renders per-finding unified diffs and the next /triage all command", () => {
    const result = renderTriagePreview({
      headSha: "a".repeat(40),
      inventory: [thread(11), thread(22, { titleSnippet: "P2 · Other", path: "src/b.ts" })],
      hunks: [
        {
          threadRootCommentId: 11,
          subject: "fix: guard user",
          diff: "diff --git a/src/app.ts b/src/app.ts\n+ok\n",
        },
      ],
    });

    expect(result).toContain(TRIAGE_PREVIEW_SENTINEL);
    expect(result).toContain("Thread root: `11`");
    expect(result).toContain("Thread root: `22`");
    expect(result).toContain("```diff");
    expect(result).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(result).toContain("No would-be diff for this finding.");
    expect(result).toContain("`/triage all`");
    expect(result).toContain("exclude <thread ids>");
    expect(result).toContain("Nothing was committed or pushed");
  });
});

describe("classifyTriageBulkOutcomes", () => {
  it("classifies applied, skipped, and failed findings for a partial bulk report", () => {
    const inventory = [thread(1), thread(2), thread(3), thread(4)];
    const outcomes = classifyTriageBulkOutcomes({
      inventory,
      payload: {
        verdicts: [
          { verdict: "fixed", threadRootCommentId: 1, commitSha: "b".repeat(40), evidence: "done" },
          { verdict: "skipped", threadRootCommentId: 2, reason: "later" },
          { verdict: "fixed", threadRootCommentId: 3, commitSha: "c".repeat(40), evidence: "done" },
        ],
      } as TriagePayload,
      commitByThreadRootCommentId: new Map([[1, "b".repeat(40)]]),
      commitErrors: [{ threadRootCommentId: 3 }],
      excludedIds: new Set([2]),
      notInPreviewIds: new Set([4]),
      pushed: true,
    });

    expect(outcomes.get(1)).toBe("applied");
    expect(outcomes.get(2)).toBe("skipped");
    expect(outcomes.get(3)).toBe("failed");
    expect(outcomes.get(4)).toBe("skipped");

    const report = renderTriageReport({
      headSha: "a".repeat(40),
      inventory,
      payload: {
        verdicts: [
          { verdict: "fixed", threadRootCommentId: 1, commitSha: "b".repeat(40), evidence: "done" },
          { verdict: "skipped", threadRootCommentId: 2, reason: "later" },
          { verdict: "fixed", threadRootCommentId: 3, commitSha: "c".repeat(40), evidence: "done" },
        ],
      } as TriagePayload,
      commits: [{ sha: "b".repeat(40), subject: "fix: one", diff: "+ok\n" }],
      previouslyResolvedCount: 0,
      bulkOutcomes: outcomes,
    });
    expect(report).toContain("| Outcome |");
    expect(report).toContain("applied");
    expect(report).toContain("skipped");
    expect(report).toContain("failed");
  });
});

describe("classifyTriageBulkOutcome", () => {
  it("skips excluded or not-in-preview findings and fails approved misses", () => {
    expect(
      classifyTriageBulkOutcome({
        excluded: true,
        notInPreview: false,
        hasCommit: false,
        commitError: false,
        pushed: false,
      }),
    ).toBe("skipped");
    expect(
      classifyTriageBulkOutcome({
        excluded: false,
        notInPreview: true,
        hasCommit: false,
        commitError: false,
        pushed: false,
      }),
    ).toBe("skipped");
    expect(
      classifyTriageBulkOutcome({
        excluded: false,
        notInPreview: false,
        hasCommit: false,
        commitError: false,
        pushed: false,
      }),
    ).toBe("failed");
    expect(
      classifyTriageBulkOutcome({
        verdict: {
          verdict: "fixed",
          threadRootCommentId: 1,
          commitSha: "b".repeat(40),
          evidence: "done",
        },
        excluded: false,
        notInPreview: false,
        hasCommit: true,
        commitError: false,
        pushed: true,
      }),
    ).toBe("applied");
  });
});

describe("renderTriageReport bulk outcomes", () => {
  it("adds an Outcome column for bulk runs", () => {
    const result = renderTriageReport({
      headSha: "a".repeat(40),
      inventory: [thread(1), thread(2, { titleSnippet: "P2 · Other" })],
      payload: {
        verdicts: [
          { verdict: "fixed", threadRootCommentId: 1, commitSha: "b".repeat(40), evidence: "done" },
        ],
      } as TriagePayload,
      commits: [],
      previouslyResolvedCount: 0,
      bulkOutcomes: new Map<number, "applied" | "skipped" | "failed">([
        [1, "applied"],
        [2, "skipped"],
      ]),
    });

    expect(result).toContain("| Severity | Finding | Location | Verdict | Outcome | Thread |");
    expect(result).toContain("applied");
    expect(result).toContain("skipped");
  });
});

describe("preview approval", () => {
  it("approves only displayed hunks that remain in inventory and are not excluded", () => {
    const approval = previewApprovalSets({
      inventory: [thread(1), thread(2), thread(3)],
      preview: {
        threadRootCommentIds: [1, 2],
        hunks: [
          {
            threadRootCommentId: 1,
            subject: "fix: one",
            diff: "diff --git a/src/app.ts b/src/app.ts\n+ok\n",
          },
          { threadRootCommentId: 2, subject: "fix: two", diff: "   " },
        ],
      },
      excludeIds: new Set([2]),
    });
    expect(approval.approvedInventory.map((item) => item.rootCommentId)).toEqual([1]);
    expect([...approval.approvedIds]).toEqual([1]);
    expect(approval.approvedHunks.map((hunk) => hunk.threadRootCommentId)).toEqual([1]);
    expect([...approval.notInPreviewIds]).toEqual([3]);
    expect([...approval.excludedIds]).toEqual([2]);
  });

  it("rewrites applied commit SHAs and drops excluded or unapplied fixed verdicts", () => {
    expect(
      remapBulkPayload({
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "c".repeat(40),
              evidence: "done",
            },
            {
              verdict: "fixed",
              threadRootCommentId: 2,
              commitSha: "c".repeat(40),
              evidence: "done",
            },
            { verdict: "skipped", threadRootCommentId: 3, reason: "later" },
          ],
        },
        approvedIds: new Set([1, 3]),
        appliedCommits: new Map([[1, "d".repeat(40)]]),
      }),
    ).toEqual({
      verdicts: [
        { verdict: "fixed", threadRootCommentId: 1, commitSha: "d".repeat(40), evidence: "done" },
        { verdict: "skipped", threadRootCommentId: 3, reason: "later" },
      ],
    });
  });

  it("reads b/ paths from a unified diff", () => {
    expect(pathsFromUnifiedDiff("diff --git a/src/old.ts b/src/app.ts\n+ok\n")).toEqual([
      "src/app.ts",
    ]);
  });
});
