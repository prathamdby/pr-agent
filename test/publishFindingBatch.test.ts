import { createFakePublishStore } from "../src/agentWork/fakePublishStore.js";
import type { ThreadBatchReview } from "../src/github/prSurface.js";
const publishStoreState = vi.hoisted(() => {
  let store: import("../src/agentWork/publishOnce.js").PublishIntentStore;
  return {
    get store() {
      return store;
    },
    set store(value) {
      store = value;
    },
  };
});
vi.mock("../src/agentWork/operationIntentRepository.js", () => ({
  persistOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.persistOperationIntent>) =>
      publishStoreState.store.persistOperationIntent(...args),
  ),
  mergeOperationIntentDetail: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.mergeOperationIntentDetail>) =>
      publishStoreState.store.mergeOperationIntentDetail(...args),
  ),
  reconcileOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.reconcileOperationIntent>) =>
      publishStoreState.store.reconcileOperationIntent(...args),
  ),
  getOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.getOperationIntent>) =>
      publishStoreState.store.getOperationIntent(...args),
  ),
  listPendingOperationIntents: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.listPendingOperationIntents>) =>
      publishStoreState.store.listPendingOperationIntents(...args),
  ),
}));
beforeEach(() => {
  publishStoreState.store = createFakePublishStore();
});
vi.mock("../src/agentWork/reconcilePendingIntents.js", () => ({
  reconcilePendingIntents: vi.fn(async () => ({ reconciled: 0, stillPending: 0 })),
  findCompletedPublishRecordId: vi.fn(async () => null),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import type { Pool } from "pg";
import {
  deterministicInlineBatchId,
  reviewInlineBatchOperationKey,
} from "../src/agentWork/publishOnce.js";
import {
  applyFindingLedgerDelta,
  createFindingLedger,
  type FindingLedger,
} from "../src/review/orchestrator/orchestratorTypes.js";
import {
  publishFindingBatch,
  reconciledFindingKey,
  type FindingBatchInput,
} from "../src/review/publish/publishFindingBatch.js";
import type { BoundPolicyJudgePair } from "../src/review/publish/boundPolicyJudge.js";
import {
  createReviewPublishSession,
  type ReviewPublishSession,
  type ReviewPublishSessionInput,
} from "../src/review/publish/reviewPublishSession.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  reviewFindingSchema,
  reviewPayloadFromFindings,
  type ReviewFinding,
} from "../src/review/reviewSchema.js";
import { REVIEW_POINTER_BODY } from "../src/settings/index.js";
import {
  createReviewArtifactBinding,
  createReviewArtifactEnvelope,
  parseReviewArtifactEnvelope,
} from "../src/review/recovery/reviewArtifacts.js";
import { openReviewRecovery } from "../src/review/recovery/reviewRecovery.js";
import {
  legacyFindingId,
  renderFindingMarker,
} from "../src/review/findingIdentity/findingMarker.js";
import type { ReconcileOutcome } from "../src/review/findingIdentity/findingReconcile.js";
import { recordDeliveredFileRead } from "../src/review/findings/evidenceLedger.js";
import { reviewRecoveryInputDigest } from "../src/review/recovery/reviewRecoveryBinding.js";
import {
  cachedDiffForLines,
  completeFindingInventory,
} from "./helpers/reviewPublishTestHelpers.js";
import {
  createTestEvidenceLedger,
  seedEvidenceForFindings,
} from "./helpers/evidenceTestHelpers.js";
import {
  createPublishReviewTestHarness,
  type PublishReviewTestHarness,
} from "./helpers/publishReviewTestSetup.js";

const finding: ReviewFinding = {
  severity: "P1",
  file: "src/a.ts",
  startLine: 10,
  endLine: 10,
  title: "Missing null check",
  detail: "The payload can be null on this path.",
  fixPrompt: "Guard the payload before dereferencing it.",
};

function findingAt(line: number): ReviewFinding {
  return {
    ...finding,
    startLine: line,
    endLine: line,
    title: `Finding at line ${line}`,
    detail: `The code at line ${line} fails for the covered input.`,
  };
}

const PROGRESS_COMMENT_URL = "https://github.com/o/r/pull/1#issuecomment-99";

const stubPool = {} as Pool;

function memoryRecovery() {
  const binding = createReviewArtifactBinding(
    {
      workItemId: "00000000-0000-4000-8000-000000000002",
      resourceKey: "o/r#1",
      owner: "o",
      repo: "r",
      prNumber: 1,
      installationId: 1,
      baseSha: "base",
      headSha: "abc1234",
      mode: "review",
    },
    "a".repeat(64),
  );
  const rows = new Map<string, unknown>();
  const store = {
    load: async (key: string) => parseReviewArtifactEnvelope(rows.get(key)),
    save: async (value: unknown) => {
      const envelope = parseReviewArtifactEnvelope(value);
      if (!envelope) throw new Error("invalid envelope");
      rows.set(envelope.logicalKey, envelope);
      return "stored" as const;
    },
  };
  return () => openReviewRecovery(binding, store);
}

function recordLineTenRead(input: FindingBatchInput) {
  if (input.evidenceLedger)
    recordDeliveredFileRead(input.evidenceLedger, {
      path: "src/a.ts",
      headSha: "abc1234",
      tool: "readWorkspaceFile",
      startLine: 10,
      endLine: 10,
      content: "line ten",
    });
}

function postedFindingIds(result: Awaited<ReturnType<typeof publishFindingBatch>>) {
  return result.kind === "stopped"
    ? []
    : result.delta.accepted.flatMap((entry) => (entry.kind === "posted" ? [entry.findingId] : []));
}

function reconciledAs(target: ReviewFinding, outcome: ReconcileOutcome) {
  return {
    inventory: completeFindingInventory(),
    outcomes: new Map([[reconciledFindingKey(target), outcome]]),
  };
}

let harness: PublishReviewTestHarness;

type BatchOverrides = Partial<Omit<ReviewPublishSessionInput, "ctx" | "findingInventory">> &
  Partial<FindingBatchInput> & {
    readonly seedFindings?: readonly ReviewFinding[];
  };

function batchContext(
  ledger: FindingLedger,
  recordPublishStep = vi.fn(async () => undefined),
  overrides: BatchOverrides = {},
): [ReviewPublishSession, FindingBatchInput] {
  const {
    seedFindings,
    source,
    evidenceLedger: evidenceOverride,
    checkoutCoverage,
    isPathInCheckout,
    repoPolicy,
    sameRepo,
    boundPolicyJudge,
    readCheckoutFile,
    reconciled,
    ...sessionOverrides
  } = overrides;
  const evidenceLedger = evidenceOverride ?? createTestEvidenceLedger("abc1234");
  if (evidenceOverride == null) {
    seedEvidenceForFindings(evidenceLedger, seedFindings ?? [finding]);
  }
  const session = createReviewPublishSession({
    cfg: makeTestConfig(),
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "abc1234",
      hasDescriptionReviewMap: false,
    },
    workItemId: "wi-1",
    resolveProgressCommentUrl: async () => PROGRESS_COMMENT_URL,
    prSurface: harness.surface,
    findingInventory: completeFindingInventory(),
    cachedDiffIndex: cachedDiffForLines("src/a.ts", [10]),
    recordPublishStep,
    ...sessionOverrides,
  });
  return [
    session,
    {
      source: source ?? "correctness",
      ledger,
      evidenceLedger,
      checkoutCoverage,
      isPathInCheckout,
      repoPolicy,
      sameRepo,
      boundPolicyJudge,
      readCheckoutFile,
      reconciled,
    },
  ];
}

describe("publishFindingBatch", () => {
  it("binds effective policy and role models without credentials or evolving comments", () => {
    const cfg = makeTestConfig();
    const input = {
      cfg,
      diff: [["src/a.ts", "patch"]],
      trustedInputs: "policy",
      source: "slash",
      userSupplement: "inspect",
      prTitle: "Title",
      prBody: "Body",
      modelApis: { orchestrator: "openai-responses" },
    };
    const digest = reviewRecoveryInputDigest(input);
    const publication = {
      checksWrite: true,
      statusesWrite: false,
      labelsWrite: true,
      reactionsWrite: true,
    };
    expect(
      reviewRecoveryInputDigest({ ...input, effectivePublicationCapabilities: publication }),
    ).not.toBe(digest);
    expect(
      reviewRecoveryInputDigest({
        ...input,
        effectivePublicationCapabilities: { ...publication, checksWrite: false },
      }),
    ).not.toBe(
      reviewRecoveryInputDigest({ ...input, effectivePublicationCapabilities: publication }),
    );
    expect(
      reviewRecoveryInputDigest({
        ...input,
        modelApis: { orchestrator: "anthropic-messages" },
      }),
    ).not.toBe(digest);
    expect(
      reviewRecoveryInputDigest({
        ...input,
        cfg: makeTestConfig({
          models: { providerKeys: { openai: "changed-secret" } },
        }),
      }),
    ).toBe(digest);
    expect(reviewRecoveryInputDigest({ ...input, trustedInputs: "changed-policy" })).not.toBe(
      digest,
    );
    expect(
      reviewRecoveryInputDigest({
        ...input,
        cfg: makeTestConfig({
          models: { orchestratorModel: "other-model" },
        }),
      }),
    ).not.toBe(digest);
    expect(reviewRecoveryInputDigest({ ...input, userSupplement: "changed-input" })).not.toBe(
      digest,
    );
    expect(
      reviewRecoveryInputDigest({
        ...input,
        escalation: {
          attempt: 2,
          kinds: ["fallback_model", "tool_rounds"],
          model: { provider: "openai", model: "fallback" },
        },
      }),
    ).not.toBe(digest);
  });
  it.each([true, false])(
    "retains a local decision only with reproducible evidence (%s)",
    async (reproducible) => {
      const binding = createReviewArtifactBinding(
        {
          workItemId: "00000000-0000-4000-8000-000000000001",
          resourceKey: "o/r#1",
          owner: "o",
          repo: "r",
          prNumber: 1,
          installationId: 1,
          baseSha: "base",
          headSha: "abc1234",
          mode: "review",
        },
        "a".repeat(64),
      );
      const artifacts = new Map<string, unknown>();
      const store = {
        load: async (key: string) => parseReviewArtifactEnvelope(artifacts.get(key)),
        save: vi.fn(async (value: unknown) => {
          const envelope = parseReviewArtifactEnvelope(value);
          if (!envelope) throw new Error("invalid envelope");
          artifacts.set(envelope.logicalKey, envelope);
          return "stored" as const;
        }),
      };
      const recovery = openReviewRecovery(binding, store);
      const ledger = createFindingLedger({ threadCallCount: 8 });
      const [session, input] = batchContext(ledger, undefined, {
        cfg: makeTestConfig({ review: { maxThreadPublishCalls: 8 } }),
      });
      if (input.evidenceLedger && reproducible)
        recordDeliveredFileRead(input.evidenceLedger, {
          path: "src/a.ts",
          headSha: "abc1234",
          tool: "readWorkspaceFile",
          startLine: 10,
          endLine: 10,
          content: "line ten",
        });
      const result = await publishFindingBatch([finding], { ...session, recovery }, input);
      expect(result.kind).toBe("budget_exhausted");
      if (!reproducible) {
        expect(store.save).not.toHaveBeenCalled();
        expect(recovery.canReuseSummary()).toBe(false);
        return;
      }
      const saved = await store.load("decision/0/prepared");
      expect(saved?.artifact).toMatchObject({
        canonical: {
          kind: "threads",
          source: "correctness",
          localDelta: {
            threadCallCount: 1,
            threadBudgetExhausted: true,
            accepted: [expect.objectContaining({ kind: "summary_only", reason: "budget" })],
          },
        },
      });
      expect(
        Buffer.byteLength(JSON.stringify(await store.load("decision/0/settled"))),
      ).toBeLessThan(8192);
      const replay = openReviewRecovery(binding, store);
      const decisions = await replay.decisions();
      expect(decisions).toHaveLength(1);
      const repeated = await publishFindingBatch(
        [],
        { ...session, recovery: replay },
        {
          ...input,
          recoveryDecision: decisions[0],
        },
      );
      expect(repeated).toEqual(result);
      expect(harness.publishThreadBatch).not.toHaveBeenCalled();
      expect(store.save).toHaveBeenCalledTimes(2);
      const missed = await publishFindingBatch(
        [],
        { ...session, recovery: replay },
        {
          ...input,
          recoveryDecision: decisions[0],
          recoveryWithoutEvidence: true,
        },
      );
      expect(missed).toMatchObject({
        kind: "budget_exhausted",
        delta: { accepted: [], threadCallCount: 1, threadBudgetExhausted: true },
      });
    },
  );

  it("redacts canonical findings and rejects unknown journal fields", () => {
    const binding = createReviewArtifactBinding(
      {
        workItemId: "00000000-0000-4000-8000-000000000001",
        resourceKey: "o/r#1",
        owner: "o",
        repo: "r",
        prNumber: 1,
        installationId: 1,
        baseSha: "base",
        headSha: "head",
        mode: "review",
      },
      "a".repeat(64),
    );
    const envelope = createReviewArtifactEnvelope(binding, {
      kind: "publication_prepared",
      sequence: 0,
      decisionId: "d0",
      operationKey: "local:0",
      payload: reviewPayloadFromFindings([]),
      dependencies: [],
      canonical: {
        kind: "threads",
        source: "correctness",
        ledgerBefore: {
          accepted: [],
          reaffirmed: [],
          suppressedDismissedCount: 0,
          inlineReviewIds: [],
          postedInlineCount: 0,
          threadCallCount: 0,
          threadBudgetExhausted: false,
        },
        localDelta: {
          accepted: [],
          reaffirmed: [],
          suppressedDismissedCount: 0,
          inlineReviewIds: [],
          postedInlineCount: 0,
          threadCallCount: 1,
          threadBudgetExhausted: false,
        },
        inline: [],
        footers: [],
        resultKind: "empty",
        evidence: [],
        judgmentDegraded: false,
        counts: { suppressed: 0, capDowngraded: 0 },
      },
    });
    expect(parseReviewArtifactEnvelope(envelope)).toEqual(envelope);
    expect(
      parseReviewArtifactEnvelope({
        ...envelope,
        artifact: { ...envelope.artifact, transcript: "never saved" },
      }),
    ).toBeNull();
  });

  it("replays the authoritative remote fallback result, not the prepared inline plan", async () => {
    const binding = createReviewArtifactBinding(
      {
        workItemId: "00000000-0000-4000-8000-000000000001",
        resourceKey: "o/r#1",
        owner: "o",
        repo: "r",
        prNumber: 1,
        installationId: 1,
        baseSha: "base",
        headSha: "abc1234",
        mode: "review",
      },
      "a".repeat(64),
    );
    const rows = new Map<string, unknown>();
    const store = {
      load: async (key: string) => parseReviewArtifactEnvelope(rows.get(key)),
      save: async (value: unknown) => {
        const envelope = parseReviewArtifactEnvelope(value);
        if (!envelope) throw new Error("invalid");
        rows.set(envelope.logicalKey, envelope);
        return "stored" as const;
      },
    };
    const recovery = openReviewRecovery(binding, store);
    const second = findingAt(11);
    harness.publishThreadBatch.mockRejectedValueOnce(
      Object.assign(new Error("line could not be resolved"), {
        status: 422,
        response: {
          data: {
            message: "Validation Failed",
            errors: [{ resource: "PullRequestReviewComment", field: "line", code: "invalid" }],
          },
        },
      }),
    );
    const [session, input] = batchContext(createFindingLedger(), undefined, {
      workItemId: binding.workItemId,
      operationIntent: {
        client: {} as Pool,
        workItemId: binding.workItemId,
        resourceKey: binding.resourceKey,
      },
      cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 11]),
      seedFindings: [finding, second],
    });
    if (input.evidenceLedger)
      recordDeliveredFileRead(input.evidenceLedger, {
        path: "src/a.ts",
        headSha: "abc1234",
        tool: "readWorkspaceFile",
        startLine: 10,
        endLine: 11,
        content: "line ten\nline eleven",
      });
    const result = await publishFindingBatch([finding, second], { ...session, recovery }, input);
    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    expect(
      result.delta.accepted.some(
        (entry) => entry.kind === "summary_only" && entry.reason === "anchor",
      ),
    ).toBe(true);
    const replay = openReviewRecovery(binding, store);
    const decisions = await replay.decisions();
    harness.publishThreadBatch.mockClear();
    const repeated = await publishFindingBatch(
      [],
      { ...session, recovery: replay },
      {
        ...input,
        recoveryDecision: decisions[0],
      },
    );
    expect(repeated).toEqual(result);
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    harness = createPublishReviewTestHarness();
    vi.clearAllMocks();
  });

  it("returns empty without GitHub writes when the batch has no findings", async () => {
    const recordPublishStep = vi.fn(async () => undefined);
    const result = await publishFindingBatch(
      [],
      ...batchContext(createFindingLedger(), recordPublishStep, { seedFindings: [] }),
    );

    expect(result.kind).toBe("empty");
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
    expect(recordPublishStep).not.toHaveBeenCalled();
    if (result.kind !== "empty") return;
    expect(result.delta.accepted).toEqual([]);
    expect(result.delta.reaffirmed).toEqual([]);
  });

  it("does not create a GitHub review when reconcile reaffirms the whole batch", async () => {
    const recordPublishStep = vi.fn(async () => undefined);
    const id = legacyFindingId("reaffirmed-thread");
    const result = await publishFindingBatch(
      [finding],
      ...batchContext(createFindingLedger(), recordPublishStep, {
        reconciled: reconciledAs(finding, { kind: "reaffirm", id, severity: finding.severity }),
      }),
    );

    expect(result.kind).toBe("empty");
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
    expect(recordPublishStep).not.toHaveBeenCalled();
    if (result.kind !== "empty") return;
    expect(result.delta.accepted).toEqual([]);
    expect(result.delta.reaffirmed).toEqual([
      expect.objectContaining({ id, heldBy: "run", severity: finding.severity }),
    ]);
    expect(result.delta.threadCallCount).toBe(1);
  });

  it("keeps a finding reconciled to an earlier batch out of a second review", async () => {
    const recordPublishStep = vi.fn(async () => undefined);
    const initialLedger = createFindingLedger();
    const first = await publishFindingBatch(
      [finding],
      ...batchContext(initialLedger, recordPublishStep),
    );
    expect(first.kind).toBe("published");
    if (first.kind !== "published") return;
    expect(initialLedger.postedInlineCount).toBe(0);
    expect(recordPublishStep).toHaveBeenCalledWith(
      "inline_review",
      expect.objectContaining({
        githubId: 1,
        meta: expect.objectContaining({
          version: 3,
          workItemId: "wi-1",
          specialist: "correctness",
          reviewId: 1,
          event: "COMMENT",
          findingIds: postedFindingIds(first),
          placements: [
            expect.objectContaining({
              finding,
              resolvedLine: 10,
              findingId: postedFindingIds(first)[0],
            }),
          ],
        }),
      }),
    );
    const ledger = applyFindingLedgerDelta(createFindingLedger(), first.delta);

    const [firstId] = postedFindingIds(first);
    if (firstId == null) throw new Error("first batch posted no finding");

    const second = await publishFindingBatch(
      [finding],
      ...batchContext(ledger, recordPublishStep, {
        reconciled: reconciledAs(finding, {
          kind: "reaffirm",
          id: firstId,
          severity: finding.severity,
        }),
      }),
    );

    expect(second.kind).toBe("empty");
    expect(harness.publishThreadBatch).toHaveBeenCalledTimes(1);
    expect(recordPublishStep).toHaveBeenCalledTimes(1);
    if (second.kind !== "empty") return;
    expect(second.delta.accepted).toEqual([]);
    expect(second.delta.reaffirmed).toEqual([expect.objectContaining({ id: firstId })]);
  });

  it("does not publish findings that lack evidence", async () => {
    const evidenceLedger = createTestEvidenceLedger("abc1234");
    const result = await publishFindingBatch(
      [finding],
      ...batchContext(createFindingLedger(), undefined, { evidenceLedger }),
    );

    expect(result.kind).toBe("empty");
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
    if (result.kind !== "empty") return;
    expect(result.delta.accepted).toEqual([]);
  });

  it("drops leftover violatedRule and posts no Bound footer without policy", async () => {
    const parsed = v.safeParse(reviewFindingSchema, {
      ...finding,
      violatedRule: ".pr-agent/testing.mdc",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.output).not.toHaveProperty("violatedRule");

    const result = await publishFindingBatch(
      [parsed.output],
      ...batchContext(createFindingLedger(), undefined, { seedFindings: [parsed.output] }),
    );

    expect(result.kind).toBe("published");
    const commentBody = harness.publishThreadBatch.mock.calls[0]?.[0]?.comments?.[0]?.body ?? "";
    expect(commentBody).not.toContain("violatedRule");
    expect(commentBody).not.toContain("Rule ·");
    expect(commentBody).not.toContain("Bound ·");
    expect(commentBody).not.toContain(".pr-agent/testing.mdc");
  });

  it("prints Bound only for judged-yes same-repo rules", async () => {
    const findings = Array.from({ length: 10 }, (_, index) => findingAt(10 + index));
    const judge = vi.fn(async (_pairs: readonly BoundPolicyJudgePair[]) => ["p1", "p7"]);
    const result = await publishFindingBatch(
      findings,
      ...batchContext(createFindingLedger(), undefined, {
        seedFindings: findings,
        cachedDiffIndex: cachedDiffForLines(
          "src/a.ts",
          findings.map((item) => item.startLine),
        ),
        sameRepo: true,
        boundPolicyJudge: judge,
        repoPolicy: {
          kind: "ok",
          policy: {
            rules: [
              {
                filename: "always.mdc",
                relativePath: ".pr-agent/always.mdc",
                alwaysApply: true,
                globs: [],
                body: "Always apply.",
              },
              {
                filename: "auth.mdc",
                relativePath: ".pr-agent/auth.mdc",
                alwaysApply: false,
                globs: ["src/auth/**"],
                body: "Auth only.",
              },
            ],
          },
        },
      }),
    );

    expect(result.kind).toBe("published");
    expect(judge).toHaveBeenCalledTimes(1);
    const asked = judge.mock.calls[0]?.[0] ?? [];
    expect(asked).toHaveLength(10);
    expect(asked.every((pair) => pair.relativePath === ".pr-agent/always.mdc")).toBe(true);
    const bodies = (harness.publishThreadBatch.mock.calls[0]?.[0]?.comments ?? []).map(
      (comment) => comment.body,
    );
    const boundBodies = bodies.filter((body) =>
      body.includes("<sub>Bound · .pr-agent/always.mdc</sub>"),
    );
    expect(boundBodies).toHaveLength(2);
    expect(bodies.some((body) => body.includes("auth.mdc"))).toBe(false);
    expect(bodies.some((body) => body.includes("Rule ·"))).toBe(false);
  });

  it("prints no Bound footer when the judge is missing", async () => {
    const result = await publishFindingBatch(
      [finding],
      ...batchContext(createFindingLedger(), undefined, {
        sameRepo: true,
        repoPolicy: {
          kind: "ok",
          policy: {
            rules: [
              {
                filename: "always.mdc",
                relativePath: ".pr-agent/always.mdc",
                alwaysApply: true,
                globs: [],
                body: "Always apply.",
              },
            ],
          },
        },
      }),
    );

    expect(result.kind).toBe("published");
    const commentBody = harness.publishThreadBatch.mock.calls[0]?.[0]?.comments?.[0]?.body ?? "";
    expect(commentBody).not.toContain("Bound ·");
    expect(commentBody).not.toContain(".pr-agent/always.mdc");
  });

  it("redacts secret-shaped finding text before the GitHub write", async () => {
    const secretFinding = {
      ...finding,
      detail: "Leaked key OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
    };
    const result = await publishFindingBatch(
      [secretFinding],
      ...batchContext(createFindingLedger(), undefined, { seedFindings: [secretFinding] }),
    );

    expect(result.kind).toBe("published");
    const commentBody = harness.publishThreadBatch.mock.calls[0]?.[0]?.comments?.[0]?.body ?? "";
    expect(commentBody).toContain("Leaked key");
    expect(commentBody).toContain("[redacted]");
    expect(commentBody).not.toContain("sk-");
  });

  it("posts a reconciled reopen with its marker link and related threads", async () => {
    const id = legacyFindingId("reopened-thread");
    const reopens = legacyFindingId("fixed-thread");
    const related = "https://github.com/o/r/pull/1#discussion_r7";
    const result = await publishFindingBatch(
      [finding],
      ...batchContext(createFindingLedger(), undefined, {
        reconciled: reconciledAs(finding, {
          kind: "post_thread",
          id,
          reopens,
          relatedLinks: [related],
        }),
      }),
    );

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    const commentBody = harness.publishThreadBatch.mock.calls[0]?.[0]?.comments?.[0]?.body ?? "";
    expect(commentBody).toContain(`id=${id}`);
    expect(commentBody).toContain(`reopens=${reopens}`);
    expect(commentBody).toContain(`[thread](${related})`);
    expect(result.delta.accepted).toEqual([
      expect.objectContaining({ kind: "posted", findingId: id, reopens }),
    ]);
  });

  it("downgrades unresolved anchors to summary-only without a GitHub review", async () => {
    const unresolved = findingAt(99);
    const result = await publishFindingBatch(
      [unresolved],
      ...batchContext(createFindingLedger(), undefined, {
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10]),
        seedFindings: [unresolved],
      }),
    );

    expect(result.kind).toBe("empty");
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
    if (result.kind !== "empty") return;
    expect(result.delta.accepted).toEqual([
      expect.objectContaining({
        kind: "summary_only",
        reason: "anchor",
      }),
    ]);
  });

  it("classifies cap downgrades separately from unresolved anchors", async () => {
    const anchoredKeep = findingAt(10);
    const anchoredCapped = { ...findingAt(20), severity: "P2" as const };
    const unresolved = {
      ...findingAt(99),
      title: "Unresolved",
      detail: "No commentable line.",
    };
    const findings = [anchoredKeep, anchoredCapped, unresolved];
    const result = await publishFindingBatch(
      findings,
      ...batchContext(createFindingLedger(), undefined, {
        cfg: makeTestConfig({ review: { maxInlineComments: 1 } }),
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20]),
        seedFindings: findings,
      }),
    );

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    expect(result.delta.postedInlineCount).toBe(1);
    expect(
      result.delta.accepted.filter(
        (placement) => placement.kind === "summary_only" && placement.reason === "cap",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "summary_only",
        reason: "cap",
        placement: expect.objectContaining({ finding: anchoredCapped }),
      }),
    ]);
    expect(
      result.delta.accepted.filter(
        (placement) => placement.kind === "summary_only" && placement.reason === "anchor",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "summary_only",
        reason: "anchor",
        placement: expect.objectContaining({ finding: unresolved }),
      }),
    ]);
  });

  it("retries the inline batch after dropping an unresolved GitHub anchor", async () => {
    const first = findingAt(10);
    const second = findingAt(20);
    let calls = 0;
    harness.publishThreadBatch.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("Line could not be resolved"), {
          response: { data: { errors: [{ path: "src/a.ts", line: 20 }] } },
        });
      }
      return {
        reviewId: 7,
        reviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-7",
      };
    });

    const result = await publishFindingBatch(
      [first, second],
      ...batchContext(createFindingLedger(), undefined, {
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20]),
        seedFindings: [first, second],
      }),
    );

    expect(result.kind).toBe("published");
    expect(harness.publishThreadBatch).toHaveBeenCalledTimes(2);
    if (result.kind !== "published") return;
    expect(result.delta.postedInlineCount).toBe(1);
    expect(result.delta.accepted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "posted",
          placement: expect.objectContaining({ finding: first }),
        }),
        expect.objectContaining({
          kind: "summary_only",
          reason: "anchor",
          placement: expect.objectContaining({ finding: second }),
        }),
      ]),
    );
  });

  it("applies the remaining global inline cap", async () => {
    const findings = [findingAt(10), findingAt(20), findingAt(30), findingAt(40)];
    const result = await publishFindingBatch(
      findings,
      ...batchContext(createFindingLedger({ postedInlineCount: 2 }), undefined, {
        cfg: makeTestConfig({ review: { maxInlineComments: 3 } }),
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20, 30, 40]),
        seedFindings: findings,
      }),
    );

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    const reviewParams = harness.publishThreadBatch.mock.calls[0]?.[0];
    expect(reviewParams?.event).toBe("COMMENT");
    expect(reviewParams?.comments).toHaveLength(1);
    expect(result.delta.postedInlineCount).toBe(1);
    expect(result.delta.accepted).toHaveLength(4);
    expect(
      result.delta.accepted.filter(
        (placement) => placement.kind === "summary_only" && placement.reason === "cap",
      ),
    ).toHaveLength(3);
  });

  it("publishes Note + specialist tagline linked to the progress stub", async () => {
    const result = await publishFindingBatch(
      [finding],
      ...batchContext(createFindingLedger(), undefined, { source: "security" }),
    );

    expect(result.kind).toBe("published");
    const reviewParams = harness.publishThreadBatch.mock.calls[0]?.[0];
    expect(reviewParams?.body).toContain(
      `Track this run on the [progress stub](${PROGRESS_COMMENT_URL}) in the PR conversation.`,
    );
    expect(reviewParams?.body).toContain("Here's what the security found.");
    expect(reviewParams?.body).not.toContain(REVIEW_POINTER_BODY);
    expect(reviewParams?.body).not.toContain("Fix all findings (agent prompt)");
  });

  it("fails clearly when the progress comment URL is missing", async () => {
    await expect(
      publishFindingBatch(
        [finding],
        ...batchContext(createFindingLedger(), undefined, {
          resolveProgressCommentUrl: async () => undefined,
        }),
      ),
    ).rejects.toThrow(/progress comment/i);
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
  });

  it("resolves the progress comment URL when the batch is published", async () => {
    const resolveProgressCommentUrl = vi.fn(async () => PROGRESS_COMMENT_URL);

    const result = await publishFindingBatch(
      [finding],
      ...batchContext(createFindingLedger(), undefined, { resolveProgressCommentUrl }),
    );

    expect(result.kind).toBe("published");
    expect(resolveProgressCommentUrl).toHaveBeenCalledOnce();
  });

  it("stops before the GitHub write when the run was superseded", async () => {
    const result = await publishFindingBatch(
      [finding],
      ...batchContext(createFindingLedger(), undefined, {
        shouldAbortPublish: async () => true,
      }),
    );

    expect(result).toEqual({ kind: "stopped", reason: "superseded" });
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
  });

  it("propagates abort-check failures so the durable job can retry", async () => {
    const abortCheckError = new Error("temporary head lookup failure");

    await expect(
      publishFindingBatch(
        [finding],
        ...batchContext(createFindingLedger(), undefined, {
          shouldAbortPublish: async () => {
            throw abortCheckError;
          },
        }),
      ),
    ).rejects.toBe(abortCheckError);
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
  });

  it("reports a stale head when the publish gate records one", async () => {
    const result = await publishFindingBatch(
      [finding],
      ...batchContext(createFindingLedger(), undefined, {
        shouldAbortPublish: async () => true,
        publishAbortState: { staleHead: true },
      }),
    );

    expect(result).toEqual({ kind: "stopped", reason: "stale_head" });
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
  });

  it("propagates arbitrary GitHub publish failures", async () => {
    harness.publishThreadBatch.mockRejectedValueOnce(new Error("GitHub unavailable"));
    const recordPublishStep = vi.fn(async () => undefined);

    await expect(
      publishFindingBatch([finding], ...batchContext(createFindingLedger(), recordPublishStep)),
    ).rejects.toThrow("GitHub unavailable");
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("downgrades later calls to summary-only after the thread budget", async () => {
    const result = await publishFindingBatch(
      [finding],
      ...batchContext(
        createFindingLedger({
          threadCallCount: 1,
        }),
        undefined,
        { cfg: makeTestConfig({ review: { maxThreadPublishCalls: 1 } }) },
      ),
    );

    expect(result.kind).toBe("budget_exhausted");
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
    if (result.kind !== "budget_exhausted") return;
    expect(result.delta.threadBudgetExhausted).toBe(true);
    expect(result.delta.accepted).toEqual([
      expect.objectContaining({ kind: "summary_only", reason: "budget" }),
    ]);
  });

  it("allows the eighth thread call and downgrades the ninth without losing findings", async () => {
    const ledgerBeforeEighth = createFindingLedger({ threadCallCount: 7 });
    const eighth = await publishFindingBatch(
      [findingAt(10)],
      ...batchContext(ledgerBeforeEighth, undefined, {
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20]),
        seedFindings: [findingAt(10)],
      }),
    );

    expect(eighth.kind).toBe("published");
    if (eighth.kind !== "published") return;
    expect(ledgerBeforeEighth.threadCallCount).toBe(7);
    const ledgerAfterEighth = applyFindingLedgerDelta(ledgerBeforeEighth, eighth.delta);
    const ninthFinding = findingAt(20);
    const ninth = await publishFindingBatch(
      [ninthFinding],
      ...batchContext(ledgerAfterEighth, undefined, {
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20]),
        seedFindings: [ninthFinding],
      }),
    );

    expect(ledgerAfterEighth.threadCallCount).toBe(8);
    expect(ninth.kind).toBe("budget_exhausted");
    expect(harness.publishThreadBatch).toHaveBeenCalledTimes(1);
    if (ninth.kind !== "budget_exhausted") return;
    expect(ninth.delta.accepted).toEqual([
      expect.objectContaining({
        kind: "summary_only",
        reason: "budget",
        placement: expect.objectContaining({ finding: ninthFinding }),
      }),
    ]);
  });

  it("derives the batch id from minted finding ids and reuses it on replay", async () => {
    const pool = stubPool;
    const recordPublishStep = vi.fn(async () => undefined);
    const openRecovery = memoryRecovery();
    const [session, input] = batchContext(createFindingLedger(), recordPublishStep, {
      operationIntent: { client: pool, workItemId: "wi-1", resourceKey: "o/r#1" },
    });
    recordLineTenRead(input);

    const first = await publishFindingBatch(
      [finding],
      { ...session, recovery: openRecovery() },
      input,
    );
    expect(first.kind).toBe("published");
    const [findingId] = postedFindingIds(first);
    expect(findingId).toMatch(/^f_[0-9A-HJKMNP-TV-Z]{26}$/);
    const expectedBatchId = deterministicInlineBatchId({
      workItemId: "wi-1",
      headSha: "abc1234",
      findingIds: postedFindingIds(first),
    });
    const expectedKey = reviewInlineBatchOperationKey(expectedBatchId);
    expect(recordPublishStep).toHaveBeenCalledWith(
      "inline_review",
      expect.objectContaining({
        meta: expect.objectContaining({ batchId: expectedBatchId }),
      }),
    );
    const body = harness.publishThreadBatch.mock.calls[0]?.[0]?.comments?.[0]?.body ?? "";
    expect(body.split("\n").at(-1)).toBe(
      renderFindingMarker({ id: findingId, lens: "correctness", severity: "P1" }),
    );
    expect(
      (await publishStoreState.store.getOperationIntent(pool, "wi-1", expectedKey))?.status,
    ).toBe("reconciled");

    harness.publishThreadBatch.mockClear();
    const replay = openRecovery();
    const [decision] = await replay.decisions();
    const second = await publishFindingBatch(
      [],
      { ...session, recovery: replay },
      { ...input, recoveryDecision: decision },
    );
    expect(second).toEqual(first);
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
    expect(
      (await publishStoreState.store.getOperationIntent(pool, "wi-1", expectedKey))?.status,
    ).toBe("reconciled");
  });

  it("reuses finding ids and the operation key when a retry has no journaled decision", async () => {
    const attempt = () =>
      publishFindingBatch(
        [finding],
        ...batchContext(
          createFindingLedger(),
          vi.fn(async () => undefined),
          {
            operationIntent: { client: stubPool, workItemId: "wi-1", resourceKey: "o/r#1" },
          },
        ),
      );

    const first = await attempt();
    expect(first.kind).toBe("published");
    harness.publishThreadBatch.mockClear();
    const second = await attempt();

    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
    expect(postedFindingIds(second)).toEqual(postedFindingIds(first));
  });

  it("does not emit a key-only marker without a work-item instance", async () => {
    const result = await publishFindingBatch(
      [finding],
      ...batchContext(
        createFindingLedger(),
        vi.fn(async () => undefined),
        {
          workItemId: undefined,
          recordPublishStep: undefined,
        },
      ),
    );

    expect(result.kind).toBe("published");
    expect(harness.publishThreadBatch.mock.calls[0]?.[0]?.body).not.toContain(
      "pr-agent:operation-intent",
    );
  });

  it("reconciles an accepted review after a missing response without creating a second review", async () => {
    const pool = stubPool;
    const recordPublishStep = vi.fn(async () => undefined);
    const openRecovery = memoryRecovery();
    const remoteReview = {
      reviewId: 77,
      reviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-77",
    };
    let recoveryCalls = 0;
    let lostReview: ThreadBatchReview | undefined;
    harness.publishThreadBatch.mockImplementation(async (review) => {
      lostReview = review;
      throw Object.assign(new Error("response lost after GitHub accepted review"), {
        status: 503,
      });
    });
    vi.spyOn(harness.surface, "listPullRequestReviews").mockImplementation(async () => {
      recoveryCalls += 1;
      return recoveryCalls === 1 || lostReview == null
        ? []
        : [
            {
              id: remoteReview.reviewId,
              userId: null,
              authorLogin: "pr-agent[bot]",
              body: lostReview.body,
              commitId: lostReview.commitId ?? null,
              htmlUrl: remoteReview.reviewUrl,
            },
          ];
    });
    harness.listReviewComments.mockImplementation(async () => ({
      comments: (lostReview?.comments ?? []).map((comment, index) => ({
        id: 770 + index,
        inReplyToId: null,
        pullRequestReviewId: remoteReview.reviewId,
        userId: null,
        authorLogin: "pr-agent[bot]",
        body: comment.body,
        path: comment.path,
        line: comment.line,
        originalLine: comment.line,
        htmlUrl: `https://github.com/o/r/pull/1#discussion_r${770 + index}`,
      })),
      truncated: false,
    }));
    const [session, input] = batchContext(createFindingLedger(), recordPublishStep, {
      operationIntent: { client: pool, workItemId: "wi-review-unknown", resourceKey: "o/r#1" },
      workItemId: "wi-review-unknown",
    });
    recordLineTenRead(input);

    await expect(
      publishFindingBatch([finding], { ...session, recovery: openRecovery() }, input),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });

    const replay = openRecovery();
    const [decision] = await replay.decisions();
    const recovered = await publishFindingBatch(
      [],
      { ...session, recovery: replay },
      { ...input, recoveryDecision: decision },
    );

    expect(recovered.kind).toBe("published");
    expect(harness.publishThreadBatch).toHaveBeenCalledOnce();
    expect(recoveryCalls).toBe(2);
    const recoveredIds = postedFindingIds(recovered);
    expect(recoveredIds).toHaveLength(1);
    expect(lostReview?.comments?.[0]?.body).toContain(`id=${recoveredIds[0]} `);
    const expectedBatchId = deterministicInlineBatchId({
      workItemId: "wi-review-unknown",
      headSha: "abc1234",
      findingIds: recoveredIds,
    });
    expect(
      (
        await publishStoreState.store.getOperationIntent(
          pool,
          "wi-review-unknown",
          reviewInlineBatchOperationKey(expectedBatchId),
        )
      )?.status,
    ).toBe("reconciled");
    expect(recordPublishStep).toHaveBeenCalledWith(
      "inline_review",
      expect.objectContaining({ githubId: 77 }),
    );
  });

  it("refuses marker-less recovery evidence as an unknown outcome", async () => {
    const pool = stubPool;
    const openRecovery = memoryRecovery();
    let lostReview: ThreadBatchReview | undefined;
    harness.publishThreadBatch.mockImplementation(async (review) => {
      lostReview = review;
      throw Object.assign(new Error("response lost after GitHub accepted review"), {
        status: 503,
      });
    });
    vi.spyOn(harness.surface, "listPullRequestReviews").mockImplementation(async () =>
      lostReview == null
        ? []
        : [
            {
              id: 78,
              userId: null,
              authorLogin: "pr-agent[bot]",
              body: lostReview.body,
              commitId: lostReview.commitId ?? null,
              htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-78",
            },
          ],
    );
    harness.listReviewComments.mockImplementation(async () => ({
      comments: (lostReview?.comments ?? []).map((comment) => ({
        id: 780,
        inReplyToId: null,
        pullRequestReviewId: 78,
        userId: null,
        authorLogin: "pr-agent[bot]",
        body: comment.body.split("\n").slice(0, -1).join("\n"),
        path: comment.path,
        line: comment.line,
        originalLine: comment.line,
        htmlUrl: "https://github.com/o/r/pull/1#discussion_r780",
      })),
      truncated: false,
    }));
    const [session, input] = batchContext(createFindingLedger(), undefined, {
      operationIntent: { client: pool, workItemId: "wi-review-markerless", resourceKey: "o/r#1" },
      workItemId: "wi-review-markerless",
    });
    recordLineTenRead(input);

    await expect(
      publishFindingBatch([finding], { ...session, recovery: openRecovery() }, input),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });
    expect(harness.publishThreadBatch).toHaveBeenCalledOnce();
  });

  it("retries a review when the provider proves rejection before acceptance", async () => {
    const pool = stubPool;
    const accepted = {
      reviewId: 78,
      reviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-78",
    };
    harness.publishThreadBatch
      .mockRejectedValueOnce(
        Object.assign(new Error("provider rejected before accepting"), {
          status: 503,
          accepted: false,
        }),
      )
      .mockResolvedValueOnce(accepted);

    await expect(
      publishFindingBatch(
        [finding],
        ...batchContext(createFindingLedger(), undefined, {
          operationIntent: { client: pool, workItemId: "wi-review-retry", resourceKey: "o/r#1" },
          workItemId: "wi-review-retry",
        }),
      ),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_failed" });

    const retried = await publishFindingBatch(
      [finding],
      ...batchContext(createFindingLedger(), undefined, {
        operationIntent: { client: pool, workItemId: "wi-review-retry", resourceKey: "o/r#1" },
        workItemId: "wi-review-retry",
      }),
    );

    expect(retried.kind).toBe("published");
    expect(harness.publishThreadBatch).toHaveBeenCalledTimes(2);
  });

  it("does not remutate after crash between GitHub accept and reconcile", async () => {
    const pool = stubPool;
    const openRecovery = memoryRecovery();
    vi.spyOn(publishStoreState.store, "reconcileOperationIntent").mockRejectedValueOnce(
      new Error("crash before reconcile"),
    );
    const [session, input] = batchContext(
      createFindingLedger(),
      vi.fn(async () => undefined),
      {
        workItemId: "wi-crash",
        operationIntent: { client: pool, workItemId: "wi-crash", resourceKey: "o/r#1" },
      },
    );
    recordLineTenRead(input);

    await expect(
      publishFindingBatch([finding], { ...session, recovery: openRecovery() }, input),
    ).rejects.toThrow("crash before reconcile");

    expect(harness.publishThreadBatch).toHaveBeenCalledTimes(1);
    const replay = openRecovery();
    const [decision] = await replay.decisions();
    const savedIds =
      decision?.prepared.artifact.canonical.kind === "threads"
        ? decision.prepared.artifact.canonical.inline.map((placement) => placement.findingId)
        : [];
    expect(savedIds).toHaveLength(1);
    const operationKey = reviewInlineBatchOperationKey(
      deterministicInlineBatchId({
        workItemId: "wi-crash",
        headSha: "abc1234",
        findingIds: savedIds,
      }),
    );
    const pending = await publishStoreState.store.getOperationIntent(
      pool,
      "wi-crash",
      operationKey,
    );
    expect(pending?.status).toBe("pending");
    expect(pending?.detail.__result).toEqual(
      expect.objectContaining({
        review: expect.objectContaining({ id: 1 }),
      }),
    );

    harness.publishThreadBatch.mockClear();
    const recovered = await publishFindingBatch(
      [],
      { ...session, recovery: replay },
      { ...input, recoveryDecision: decision },
    );

    expect(recovered.kind).toBe("published");
    expect(postedFindingIds(recovered)).toEqual(savedIds);
    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
    expect(
      (await publishStoreState.store.getOperationIntent(pool, "wi-crash", operationKey))?.status,
    ).toBe("reconciled");
  });
});
