import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrSurface } from "../src/github/prSurface.js";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.js";
import { publishFindingBatch } from "../src/review/publish/publishFindingBatch.js";
import { publishReviewSummaryOnly } from "../src/review/publish/publishSummaryOnly.js";
import { createReviewPublishSession } from "../src/review/publish/reviewPublishSession.js";
import {
  createReviewArtifactBinding,
  parseReviewArtifactEnvelope,
} from "../src/review/recovery/reviewArtifacts.js";
import {
  openReviewRecovery,
  snapshotFindingLedger,
} from "../src/review/recovery/reviewRecovery.js";
import type { CanonicalReviewDecision } from "../src/review/recovery/reviewRecoverySchema.js";
import { makeTestConfig } from "./helpers/config.js";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.js";

// Replay failure modes:
// - a saved summary decision replays through the thread publisher and posts threads;
// - a saved final summary that no longer validates is published as the review summary.
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
  dedupedFindingCount: 0,
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
