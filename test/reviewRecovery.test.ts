import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrSurface } from "../src/github/prSurface.ts";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.ts";
import { publishFindingBatch } from "../src/review/publish/publishFindingBatch.ts";
import { publishReviewSummaryOnly } from "../src/review/publish/publishSummaryOnly.ts";
import { createReviewPublishSession } from "../src/review/publish/reviewPublishSession.ts";
import {
  createReviewArtifactBinding,
  createReviewArtifactEnvelope,
  parseReviewArtifactEnvelope,
  REVIEW_ARTIFACT_SCHEMA_VERSION,
  REVIEW_CONTRACT_VERSION,
} from "../src/review/recovery/reviewArtifacts.ts";
import { reviewRecoveryInputDigest } from "../src/review/recovery/reviewRecoveryBinding.ts";
import {
  openReviewRecovery,
  snapshotFindingLedger,
} from "../src/review/recovery/reviewRecovery.ts";
import {
  reviewCoverageSchema,
  type CanonicalReviewDecision,
} from "../src/review/recovery/reviewRecoverySchema.ts";
import * as v from "valibot";
import { makeTestConfig } from "./helpers/config.ts";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.ts";
import { completeFindingInventory } from "./helpers/reviewPublishTestHelpers.ts";

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

const summaryInputs: CanonicalReviewDecision = {
  kind: "summary",
  ledger: snapshotFindingLedger(createFindingLedger()),
  coverage: { kind: "full" },
  staleReview: false,
  judgmentDegraded: false,
  briefFallback: false,
};

let rows: Map<string, unknown>;
const store = {
  load: async (key: string) => parseReviewArtifactEnvelope(rows.get(key)),
  save: async (envelope: unknown) => {
    const parsed = parseReviewArtifactEnvelope(envelope);
    if (!parsed) throw new Error("invalid envelope");
    rows.set(parsed.logicalKey, parsed);
    return "stored" as const;
  },
};

function replaySession() {
  const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  const publishThreadBatch = vi.spyOn(fake.surface, "publishThreadBatch");
  const upsertProgressComment = vi.spyOn(fake.surface, "upsertProgressComment");
  const recovery = openReviewRecovery(binding, store);
  const session = createReviewPublishSession({
    cfg: makeTestConfig(),
    ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "head", hasDescriptionReviewMap: false },
    prSurface: fake.surface,
    findingInventory: completeFindingInventory(),
    recovery,
  });
  return { session, recovery, publishThreadBatch, upsertProgressComment };
}

describe("review recovery replay", () => {
  beforeEach(() => {
    rows = new Map();
  });

  it("refuses to replay a saved summary decision through the thread publisher", async () => {
    await openReviewRecovery(binding, store).prepare(
      makeReviewPayload(),
      "review-summary",
      summaryInputs,
    );
    const { session, recovery, publishThreadBatch } = replaySession();
    const [decision] = await recovery.decisions();
    expect(decision?.prepared.artifact.canonical.kind).toBe("summary");

    await expect(
      publishFindingBatch([], session, {
        source: "correctness",
        ledger: createFindingLedger(),
        recoveryDecision: decision,
      }),
    ).rejects.toMatchObject({
      code: "publish_store.invalid_detail",
      context: { reason: "decision_target" },
    });
    expect(publishThreadBatch).not.toHaveBeenCalled();
  });

  it("refuses to publish a saved final summary that fails payload validation", async () => {
    const saved = await openReviewRecovery(binding, store).saveSummary(
      makeReviewPayload({ followUps: ["Check server logs for the failed step."] }),
      summaryInputs,
    );
    expect(saved?.artifact.kind).toBe("final_summary");
    const { session, upsertProgressComment } = replaySession();

    await expect(
      publishReviewSummaryOnly(session, {
        payload: makeReviewPayload(),
        ledger: createFindingLedger(),
      }),
    ).rejects.toMatchObject({
      code: "publish_store.invalid_detail",
      context: { reason: "saved_summary_validation" },
    });
    expect(upsertProgressComment).not.toHaveBeenCalled();
  });
});

describe("review coverage persistence", () => {
  it("rejects a reasonless partial and an empty unread path list", () => {
    expect(
      v.safeParse(reviewCoverageSchema, {
        kind: "partial",
        failed: ["tests"],
        note: "old",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(reviewCoverageSchema, {
        kind: "partial",
        reason: "unread",
        paths: [],
        note: "none",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(reviewCoverageSchema, {
        kind: "partial",
        reason: "unread",
        paths: ["src/a.ts"],
        note: "Unread changed files: src/a.ts.",
      }).success,
    ).toBe(true);
  });

  it("normalizes, redacts, and caps persisted opened paths", () => {
    const envelope = createReviewArtifactEnvelope(binding, {
      kind: "brief",
      brief: {
        prIntent: "Change coverage",
        architectureNotes: "",
        riskAreas: [],
        fileMap: "src/a.ts",
        specialistFocus: {
          correctness: "check close",
          security: "paths",
          quality: "note",
          tests: "schema",
        },
      },
      openedPaths: ["./src/a.ts", "OPENAI_API_KEY=sk-secret-value", "y".repeat(5000)],
    });
    expect(envelope.artifact.kind).toBe("brief");
    if (envelope.artifact.kind !== "brief") return;
    expect(envelope.artifact.openedPaths).toEqual([
      "src/a.ts",
      "OPENAI_[redacted]",
      "y".repeat(4096),
    ]);
  });
});

describe("base policy provenance", () => {
  it("changes the digest when only a policy blob sha changes", () => {
    expect(REVIEW_CONTRACT_VERSION).toBe("review-3");
    expect(REVIEW_ARTIFACT_SCHEMA_VERSION).toBe(6);
    const input = {
      cfg: makeTestConfig(),
      diff: [["src/a.ts", "patch"]],
      trustedInputs: "policy",
      source: "slash",
      prTitle: "Title",
      prBody: null,
      policyProvenance: {
        kind: "ok",
        baseSha: "a".repeat(40),
        reason: null,
        blobs: [{ path: ".pr-agent/ok.mdc", blobSha: "b".repeat(40) }],
      },
    };
    expect(
      reviewRecoveryInputDigest({
        ...input,
        policyProvenance: {
          ...input.policyProvenance,
          blobs: [{ path: ".pr-agent/ok.mdc", blobSha: "c".repeat(40) }],
        },
      }),
    ).not.toBe(reviewRecoveryInputDigest(input));
  });

  it("rejects a review-2 artifact and keeps a stored footer decision", () => {
    const storedBaseSha = "d".repeat(40);
    const envelope = createReviewArtifactEnvelope(binding, {
      kind: "publication_prepared",
      sequence: 0,
      decisionId: "d0",
      operationKey: "local:0",
      payload: makeReviewPayload({ findings: [] }),
      dependencies: [],
      canonical: {
        kind: "threads",
        source: "correctness",
        ledgerBefore: summaryInputs.ledger,
        localDelta: summaryInputs.ledger,
        inline: [],
        footers: [["src/a.ts:1", [".pr-agent/auth.mdc"]]],
        baseSha: storedBaseSha,
        resultKind: "empty",
        evidence: [],
        judgmentDegraded: false,
        counts: { suppressed: 0, capDowngraded: 0 },
      },
    });
    expect(parseReviewArtifactEnvelope(envelope)).toEqual(envelope);
    expect(parseReviewArtifactEnvelope({ ...envelope, contractVersion: "review-2" })).toBeNull();
    const replayed = parseReviewArtifactEnvelope(envelope);
    expect(replayed?.artifact.kind).toBe("publication_prepared");
    if (replayed?.artifact.kind !== "publication_prepared") return;
    expect(replayed.artifact.canonical).toMatchObject({
      footers: [["src/a.ts:1", [".pr-agent/auth.mdc"]]],
      baseSha: storedBaseSha,
    });
  });
});
