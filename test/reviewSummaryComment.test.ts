import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.ts";
import { renderReviewFailureNotice } from "../src/review/run/progressComment.ts";
import { createReviewSummaryComment } from "../src/review/publish/reviewSummaryComment.ts";
import {
  availableInstallationCapabilities,
  createReviewCapabilityPolicy,
} from "../src/github/installationCapabilities.ts";
import { sharedPublishRecord, writePublishStep } from "../src/state/publish.ts";
import {
  createPublishReviewTestHarness,
  type PublishReviewTestHarness,
} from "./helpers/publishReviewTestSetup.ts";
import { openSqliteAppState } from "./integration/db.ts";

vi.mock("../src/evlog.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/evlog.ts")>();
  return { ...actual, logWarn: vi.fn() };
});

import { logWarn } from "../src/evlog.ts";

let harness: PublishReviewTestHarness;
const handles: Array<{ close: () => void }> = [];

function openCoordination(workItemId = "wi-1", resourceKey = "o/r#1") {
  const handle = openSqliteAppState();
  handles.push(handle);
  return { db: handle.db, workItemId, resourceKey };
}

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

it("renders one concise optional-capability notice without changing review output", async () => {
  const bundle = createPublishReviewTestHarness();
  const observation = availableInstallationCapabilities({
    appId: 1,
    installationId: 42,
    owner: "o",
    repo: "r",
  });
  Object.assign(bundle.surface, {
    capabilities: createReviewCapabilityPolicy({
      ...observation,
      availability: {
        ...observation.availability,
        checksRead: "denied",
        checksWrite: "denied",
        actionsRead: "unknown",
        labelsWrite: "denied",
      },
    }),
  });
  await createReviewSummaryComment({ prSurface: bundle.surface, reviewLens: "review" }).conclude({
    body: "review output",
  });
  const body = bundle.upsertProgressComment.mock.calls[0]?.[0] ?? "";
  expect(body).toContain("review output");
  expect(body).toContain("<summary>Limited permissions</summary>");
  expect(body).toContain("- Checks read/write\n- Actions logs\n- labels\n");
  expect(body.match(/Unavailable for this review:/g)).toHaveLength(1);
});

describe("createReviewSummaryComment (SQLite coordination)", () => {
  beforeEach(() => {
    harness = createPublishReviewTestHarness();
    vi.clearAllMocks();
    harness.resolveProgressComment.mockResolvedValue(null);
    harness.findProgressComment.mockResolvedValue(null);
    harness.upsertProgressComment.mockResolvedValue({ id: 99, updated: false });
  });

  it("creates when claim won and no stored id", async () => {
    const coordination = openCoordination();
    await createReviewSummaryComment({
      prSurface: harness.surface,
      reviewLens: "review",
      coordination,
    }).tick({ body: "summary body", progressRevision: 2 });

    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      expect.stringContaining("summary body"),
      REVIEW_SUMMARY_SENTINEL,
      null,
    );
    const saved = sharedPublishRecord(coordination.db, "o/r#1", "review", "progress_comment");
    expect(saved?.githubId).toBe(99);
    expect(saved?.detail.progressRevision).toBe(2);
  });

  it("uses stored id without scanning when verified", async () => {
    const coordination = openCoordination();
    writePublishStep(coordination.db, {
      workId: "wi-1",
      prKey: "o/r#1",
      reviewLens: "review",
      step: "summary_comment",
      githubId: 55,
    });
    harness.resolveProgressComment.mockResolvedValue({
      id: 55,
      url: "https://example.com/55",
    });

    await createReviewSummaryComment({
      prSurface: harness.surface,
      reviewLens: "review",
      coordination,
    }).tick({ body: "summary body", progressRevision: 2 });

    expect(harness.findProgressComment).toHaveBeenCalledTimes(1);
    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      expect.stringContaining("summary body"),
      REVIEW_SUMMARY_SENTINEL,
      { id: 55, url: "https://example.com/55" },
    );
  });

  it("writes a failure notice with a terminal revision marker", async () => {
    const coordination = openCoordination();
    writePublishStep(coordination.db, {
      workId: "wi-1",
      prKey: "o/r#1",
      reviewLens: "review",
      step: "progress_comment",
      githubId: 88,
      detail: { progressRevision: 3 },
    });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=3 -->`,
    });
    harness.resolveProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
    });

    await createReviewSummaryComment({
      prSurface: harness.surface,
      reviewLens: "review",
      coordination,
    }).conclude({ body: renderReviewFailureNotice({ mode: "review", retryCommand: "/review" }) });

    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      expect.stringMatching(/Review did not finish[\s\S]*workItemId=wi-1 value=7 -->$/),
      REVIEW_SUMMARY_SENTINEL,
      expect.objectContaining({ id: 88, url: "https://example.com/88" }),
    );
    const saved = sharedPublishRecord(coordination.db, "o/r#1", "review", "progress_comment");
    expect(saved?.detail.progressRevision).toBe(7);
  });

  it("does not let a failure notice replace a newer work item's progress", async () => {
    const coordination = openCoordination("wi-a");
    writePublishStep(coordination.db, {
      workId: "wi-b",
      prKey: "o/r#1",
      reviewLens: "review",
      step: "progress_comment",
      githubId: 88,
      detail: { progressRevision: 1, progressGeneration: 2 },
    });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-b value=1 -->`,
    });

    await expect(
      createReviewSummaryComment({
        prSurface: harness.surface,
        reviewLens: "review",
        coordination,
      }).conclude({ body: renderReviewFailureNotice({ mode: "review", retryCommand: "/review" }) }),
    ).resolves.toMatchObject({ id: 88, skipped: true });

    expect(harness.upsertProgressComment).not.toHaveBeenCalled();
  });

  it("writes straight to the surface when there is no coordination", async () => {
    await createReviewSummaryComment({
      prSurface: harness.surface,
      reviewLens: "review",
    }).conclude({ body: "summary body", knownExisting: { id: 5, url: "https://example.com/5" } });

    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      "summary body",
      REVIEW_SUMMARY_SENTINEL,
      { id: 5, url: "https://example.com/5" },
    );
    expect(harness.findProgressComment).not.toHaveBeenCalled();
  });

  it("does not let a delayed specialist tick overwrite the final summary", async () => {
    const coordination = openCoordination();
    writePublishStep(coordination.db, {
      workId: "wi-1",
      prKey: "o/r#1",
      reviewLens: "review",
      step: "progress_comment",
      githubId: 88,
      detail: { progressRevision: 6 },
    });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n\nfinal\n<!-- pr-agent:progress-revision workItemId=wi-1 value=6 -->`,
    });

    await expect(
      createReviewSummaryComment({
        prSurface: harness.surface,
        reviewLens: "review",
        coordination,
      }).tick({ body: "delayed tick", progressRevision: 1 }),
    ).resolves.toEqual({ id: 88, updated: false, skipped: true });

    expect(harness.upsertProgressComment).not.toHaveBeenCalled();
  });

  it("records stubPostedAtMs on revision 0 and preserves it on later ticks", async () => {
    vi.useFakeTimers();
    try {
      const coordination = openCoordination();
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
      const writer = createReviewSummaryComment({
        prSurface: harness.surface,
        reviewLens: "review",
        coordination,
      });
      await writer.tick({ body: "queued", progressRevision: 0 });
      const firstPosted = sharedPublishRecord(
        coordination.db,
        "o/r#1",
        "review",
        "progress_comment",
      )?.detail.stubPostedAtMs;
      expect(firstPosted).toBe(Date.parse("2026-07-22T12:00:00.000Z"));

      vi.setSystemTime(new Date("2026-07-22T12:05:00.000Z"));
      await writer.tick({ body: "recon done", progressRevision: 1 });
      const secondPosted = sharedPublishRecord(
        coordination.db,
        "o/r#1",
        "review",
        "progress_comment",
      )?.detail.stubPostedAtMs;
      expect(secondPosted).toBe(firstPosted);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not copy a prior CI cell when the next body omits CI", async () => {
    const coordination = openCoordination();
    const priorBody = [
      REVIEW_SUMMARY_SENTINEL,
      "",
      "<table><tbody>",
      "<tr><td><strong>CI</strong></td><td><!-- pr-agent:ci-summary -->⏳ CI is still running<!-- /pr-agent:ci-summary --></td></tr>",
      "<tr><td><strong>Recon</strong></td><td>⏳ Running</td></tr>",
      "</tbody></table>",
      "<!-- pr-agent:progress-revision workItemId=wi-1 value=0 -->",
    ].join("\n");
    const nextBody = [
      REVIEW_SUMMARY_SENTINEL,
      "",
      "<table><tbody>",
      "<tr><td><strong>Recon</strong></td><td>✅ Done</td></tr>",
      "</tbody></table>",
    ].join("\n");

    writePublishStep(coordination.db, {
      workId: "wi-1",
      prKey: "o/r#1",
      reviewLens: "review",
      step: "progress_comment",
      githubId: 88,
      detail: { progressRevision: 0 },
    });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: priorBody,
    });

    await createReviewSummaryComment({
      prSurface: harness.surface,
      reviewLens: "review",
      coordination,
    }).tick({ body: nextBody, progressRevision: 1 });

    const writtenBody = harness.upsertProgressComment.mock.calls[0]?.[0];
    expect(writtenBody).not.toContain("<strong>CI</strong>");
    expect(writtenBody).not.toContain("CI is still running");
    expect(writtenBody).toContain("<strong>Recon</strong>");
  });

  it("recovers from a crash after the GitHub write using the body revision marker", async () => {
    const coordination = openCoordination();
    const writer = createReviewSummaryComment({
      prSurface: harness.surface,
      reviewLens: "review",
      coordination,
    });
    await writer.tick({ body: "tick two", progressRevision: 2 });
    const writtenBody = harness.upsertProgressComment.mock.calls[0]?.[0] ?? "";
    expect(writtenBody).toContain("workItemId=wi-1 value=2");

    harness.findProgressComment.mockResolvedValue({
      id: 99,
      url: "https://example.com/99",
      body: writtenBody,
    });

    await expect(writer.tick({ body: "tick two", progressRevision: 2 })).resolves.toEqual({
      id: 99,
      updated: false,
      skipped: true,
    });
    expect(harness.upsertProgressComment).toHaveBeenCalledOnce();
  });

  it("logs the foreign-owner warning only without a comment or hint on revision 0", async () => {
    const coordination = openCoordination("wi-a");
    writePublishStep(coordination.db, {
      workId: "wi-b",
      prKey: "o/r#1",
      reviewLens: "review",
      step: "progress_comment",
      detail: { progressRevision: 1, progressGeneration: 2 },
    });
    harness.findProgressComment.mockResolvedValue(null);

    await expect(
      createReviewSummaryComment({
        prSurface: harness.surface,
        reviewLens: "review",
        coordination,
      }).tick({ body: "queued", progressRevision: 0 }),
    ).resolves.toEqual({ id: 0, updated: false, skipped: true });

    expect(logWarn).toHaveBeenCalledWith(
      "review_progress_skipped_foreign_owner",
      expect.objectContaining({ ownerWorkItemId: "wi-b" }),
    );

    vi.mocked(logWarn).mockClear();
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-b value=1 -->`,
    });

    await expect(
      createReviewSummaryComment({
        prSurface: harness.surface,
        reviewLens: "review",
        coordination,
      }).tick({ body: "queued", progressRevision: 0 }),
    ).resolves.toMatchObject({ id: 88, updated: false, skipped: true });

    expect(logWarn).not.toHaveBeenCalledWith(
      "review_progress_skipped_foreign_owner",
      expect.anything(),
    );
  });
});
