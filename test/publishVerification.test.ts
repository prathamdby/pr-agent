import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";
import type { ReviewThreadResolution } from "../src/github/reviewThreadResolution.js";
import type { VerificationPayload } from "../src/review/triageSchema.js";
import { VERIFICATION_STUB_MARKER } from "../src/settings/index.js";
import {
  publishTestPrSurface,
  resolveThreadIds,
  editReviewCommentEvents,
} from "./helpers/publishPrSurface.js";
import { recordPublishStep } from "../src/agentWork/repository.js";

vi.mock("../src/agentWork/repository.js", () => ({
  recordPublishStep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/agentWork/prActorLease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/prActorLease.js")>();
  return {
    ...actual,
    assertPrActorLeaseHeld: vi.fn().mockResolvedValue(undefined),
    isPrActorLeaseHeld: vi.fn().mockResolvedValue(true),
  };
});

import { publishVerification } from "../src/agent/verification/publishVerification.js";

const thread = {
  rootCommentId: 1,
  lens: "review" as const,
  path: "src/app.ts",
  line: 1,
  severity: "P1" as const,
  titleSnippet: "P1 · Bug",
  humanReplies: [],
  threadUrl: "https://github.test/thread",
} satisfies BotFindingThread;

const secondThread = {
  ...thread,
  rootCommentId: 2,
  titleSnippet: "P2 · Other",
} satisfies BotFindingThread;

const thirdThread = {
  ...thread,
  rootCommentId: 3,
  path: "src/other.ts",
  titleSnippet: "P1 · Unchanged path",
} satisfies BotFindingThread;

function pool(detail?: unknown): Pool {
  return {
    query: vi.fn(async () => ({ rows: detail === undefined ? [] : [{ detail }] })),
  } as unknown as Pool;
}

function resolutionMap(
  entries: readonly [number, ReviewThreadResolution][],
): Map<number, ReviewThreadResolution> {
  return new Map(entries);
}

let controls: import("../src/github/fakePrSurface.js").FakePrSurfaceControls;

function baseParams(overrides: {
  readonly payload: VerificationPayload;
  readonly inventory?: readonly BotFindingThread[];
  readonly resolutionByRootCommentId?: ReadonlyMap<number, ReviewThreadResolution>;
  readonly changedFilePaths?: readonly string[];
  readonly changedFilePathsTruncated?: boolean;
  readonly pool?: Pool;
  readonly workItemId?: string;
  readonly leaseEpoch?: number | null;
  readonly policyResult?: Parameters<typeof publishVerification>[0]["policyResult"];
  readonly threads?: ReadonlyMap<number, ReviewThreadResolution>;
  readonly stubBodies?: Readonly<Record<number, string>>;
}) {
  const fake = publishTestPrSurface(
    overrides.threads ??
      overrides.resolutionByRootCommentId ??
      resolutionMap([
        [1, { threadNodeId: "PRRT_1", isResolved: false }],
        [2, { threadNodeId: "PRRT_2", isResolved: false }],
        [3, { threadNodeId: "PRRT_3", isResolved: false }],
      ]),
  );
  controls = fake.controls;
  for (const inventoryThread of overrides.inventory ?? [thread, secondThread, thirdThread]) {
    const stubId =
      "verificationStubCommentId" in inventoryThread
        ? inventoryThread.verificationStubCommentId
        : undefined;
    if (stubId != null) {
      fake.controls.setReviewCommentBody(stubId, `${VERIFICATION_STUB_MARKER}\nstub`);
    }
  }
  for (const [stubId, body] of Object.entries(overrides.stubBodies ?? {})) {
    fake.controls.setReviewCommentBody(Number(stubId), body);
  }
  return {
    pool: overrides.pool ?? pool(),
    workItemId: overrides.workItemId ?? "wi",
    leaseEpoch: overrides.leaseEpoch ?? 1,
    installationId: 1,
    resourceKey: "o/r#1",
    prSurface: fake.surface,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "a".repeat(40),
    inventory: overrides.inventory ?? [thread, secondThread, thirdThread],
    resolutionByRootCommentId:
      overrides.resolutionByRootCommentId ??
      resolutionMap([
        [1, { threadNodeId: "PRRT_1", isResolved: false }],
        [2, { threadNodeId: "PRRT_2", isResolved: false }],
        [3, { threadNodeId: "PRRT_3", isResolved: false }],
      ]),
    payload: overrides.payload,
    changedFilePaths: overrides.changedFilePaths ?? ["src/app.ts"],
    changedFilePathsTruncated: overrides.changedFilePathsTruncated,
    policyResult: overrides.policyResult ?? ({ kind: "absent" } as const),
  };
}

describe("publishVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("silently resolves fixed and already-resolved threads without replying", async () => {
    const result = await publishVerification(
      baseParams({
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "null check added",
            },
            {
              verdict: "already-resolved",
              threadRootCommentId: 2,
              evidence: "code already guards this path",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degraded: false });
    expect(controls.replies).toHaveLength(0);
    expect(controls.events.filter((e) => e.kind === "editReviewComment")).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(2);
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "verification_thread_actions",
        detail: {
          threads: {
            "1": {
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
      }),
    );
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "verification_thread_actions",
        detail: {
          threads: {
            "1": {
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
            "2": {
              lastVerdict: "already-resolved",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
      }),
    );
  });

  it("skips resolve when the thread is already resolved", async () => {
    await publishVerification(
      baseParams({
        resolutionByRootCommentId: resolutionMap([
          [1, { threadNodeId: "PRRT_1", isResolved: true }],
        ]),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
      }),
    );
  });

  it("edits a prior still-open stub when later marking fixed", async () => {
    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped", lastHeadSha: "b".repeat(40) },
          },
        }),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "tests cover the case",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    const edit = editReviewCommentEvents(controls)[0];
    expect(edit?.commentId).toBe(555);
    expect(edit?.body).toContain("**Verification**: Fixed");
    expect(edit?.body).toContain(VERIFICATION_STUB_MARKER);
    expect(edit?.body).not.toContain("Still open");
    expect(resolveThreadIds(controls)).toContain("PRRT_1");
  });

  it("creates a marked still-open stub only for findings on changed files", async () => {
    await publishVerification(
      baseParams({
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "guard still missing",
            },
            {
              verdict: "skipped",
              threadRootCommentId: 3,
              reason: "still open but file unchanged",
            },
          ],
        },
      }),
    );

    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(controls.replies).toHaveLength(1);
    expect(controls.replies[0]?.target).toEqual(
      expect.objectContaining({ kind: "inlineReviewThread", inReplyToCommentId: 1 }),
    );
    expect(controls.replies[0]?.body).toContain(VERIFICATION_STUB_MARKER);
    expect(controls.replies[0]?.body).toContain("Still open");
  });

  it("does not suppress still-open stubs for omitted paths when compare is truncated", async () => {
    const result = await publishVerification(
      baseParams({
        changedFilePaths: ["src/app.ts"],
        changedFilePathsTruncated: true,
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "still open on listed path",
            },
            {
              verdict: "skipped",
              threadRootCommentId: 3,
              reason: "still open on omitted path",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degraded: true });
    expect(controls.replies).toHaveLength(2);
    expect(
      controls.replies.some(
        (r) => r.target.kind === "inlineReviewThread" && r.target.inReplyToCommentId === 1,
      ),
    ).toBe(true);
    expect(
      controls.replies.some(
        (r) => r.target.kind === "inlineReviewThread" && r.target.inReplyToCommentId === 3,
      ),
    ).toBe(true);
  });

  it("edits an existing stub in place on later still-open publishes", async () => {
    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped", lastHeadSha: "b".repeat(40) },
          },
        }),
        stubBodies: { 555: `${VERIFICATION_STUB_MARKER}\nstub` },
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "still open after push",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    expect(editReviewCommentEvents(controls)).toHaveLength(1);
    expect(editReviewCommentEvents(controls)[0]?.commentId).toBe(555);
    expect(editReviewCommentEvents(controls)[0]?.body).toContain("still open after push");
  });

  it("recovers stub id from inventory marker when ledger lacks stubCommentId", async () => {
    await publishVerification(
      baseParams({
        inventory: [{ ...thread, verificationStubCommentId: 777 }],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "recovered",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    expect(controls.events.some((e) => e.kind === "editReviewComment" && e.commentId === 777)).toBe(
      true,
    );
  });

  it("dismisses by editing stub, grounding policy, and resolving the thread", async () => {
    await publishVerification(
      baseParams({
        inventory: [
          { ...thread, humanReplies: ["false positive"], verificationStubCommentId: 555 },
        ],
        policyResult: {
          kind: "ok",
          policy: {
            rules: [
              {
                filename: "src.mdc",
                relativePath: ".pr-agent/src.mdc",
                alwaysApply: false,
                globs: ["src/**"],
                body: "existing",
              },
            ],
          },
        },
        payload: {
          verdicts: [
            {
              verdict: "dismissed",
              threadRootCommentId: 1,
              evidence: "maintainer marked false positive",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    expect(controls.events.filter((e) => e.kind === "editReviewComment")).toHaveLength(1);
    const body =
      (controls.events.find((e) => e.kind === "editReviewComment") as { body: string } | undefined)
        ?.body ?? "";
    expect(body).toContain("Dismissed");
    expect(body).toContain("Append this to `.pr-agent/src.mdc`:");
    expect(body).not.toContain("pathInstructions");
    expect(body).not.toContain(".pr-agent.yml");
    expect(resolveThreadIds(controls)).toContain("PRRT_1");
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              stubCommentId: 555,
              lastVerdict: "dismissed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
      }),
    );
  });

  it("creates then resolves when dismissing without an existing stub", async () => {
    await publishVerification(
      baseParams({
        inventory: [{ ...thread, humanReplies: ["intentional"] }],
        payload: {
          verdicts: [
            {
              verdict: "dismissed",
              threadRootCommentId: 1,
              evidence: "intentional",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(1);
    expect(resolveThreadIds(controls)).toHaveLength(1);
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": expect.objectContaining({
              stubCommentId: expect.any(Number),
              lastVerdict: "dismissed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            }),
          },
        },
      }),
    );
  });

  it("marks degraded when inventory mapping is missing", async () => {
    const result = await publishVerification(
      baseParams({
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 99,
              reason: "orphan",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degraded: true });
    expect(controls.replies).toHaveLength(0);
  });

  it("marks degraded when fixed thread has no resolution mapping", async () => {
    const result = await publishVerification(
      baseParams({
        inventory: [thread],
        resolutionByRootCommentId: resolutionMap([]),
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degraded: true });
    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(controls.replies).toHaveLength(0);
  });

  it("mixes silent resolve with still-open stub creates in one payload", async () => {
    await publishVerification(
      baseParams({
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
            {
              verdict: "skipped",
              threadRootCommentId: 2,
              reason: "still broken",
            },
          ],
        },
      }),
    );

    expect(resolveThreadIds(controls)).toHaveLength(1);
    expect(resolveThreadIds(controls)).toContain("PRRT_1");
    expect(controls.replies).toHaveLength(1);
    expect(controls.replies[0]?.body).toContain("Still open");
  });

  it("falls back to create when updating a deleted stub returns 404", async () => {
    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped" },
          },
        }),
        stubBodies: {},
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "stub was deleted",
            },
          ],
        },
      }),
    );

    expect(controls.events.some((e) => e.kind === "editReviewComment" && e.commentId === 555)).toBe(
      true,
    );
    expect(controls.replies).toHaveLength(1);
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": expect.objectContaining({
              stubCommentId: expect.any(Number),
              lastVerdict: "skipped",
              lastHeadSha: "a".repeat(40),
            }),
          },
        },
      }),
    );
  });

  it("preserves stubCommentId when a later fixed verdict has no stub id", async () => {
    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped" },
          },
        }),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    const edit = editReviewCommentEvents(controls)[0];
    expect(edit?.commentId).toBe(555);
    expect(edit?.body).toContain("**Verification**: Fixed");
    expect(resolveThreadIds(controls)).toHaveLength(1);
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              stubCommentId: 555,
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
      }),
    );
  });

  it("loads ledger by resource key so prior stubs survive a new work item", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          detail: {
            threads: {
              "1": { stubCommentId: 4242, lastVerdict: "skipped" },
            },
          },
        },
      ],
    }));
    await publishVerification(
      baseParams({
        pool: { query } as unknown as Pool,
        workItemId: "wi-new",
        leaseEpoch: 1,
        stubBodies: { 4242: `${VERIFICATION_STUB_MARKER}\nstub` },
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "cross work item",
            },
          ],
        },
      }),
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("resource_key"),
      expect.arrayContaining(["o/r#1"]),
    );
    expect(
      controls.events.some((e) => e.kind === "editReviewComment" && e.commentId === 4242),
    ).toBe(true);
    expect(controls.replies).toHaveLength(0);
  });
});
