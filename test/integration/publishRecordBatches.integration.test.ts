import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMutationOctokit } from "../../src/github/mutationOctokit.ts";
import { createFakePrSurface } from "../../src/github/prSurface.ts";
import { REVIEW_SUMMARY_SENTINEL } from "../../src/review/reviewSchema.ts";
import { publishReviewVerdictEvent } from "../../src/review/publish/publishCloseOutcomeReview.ts";
import {
  ensureRediscoveredSummaryComment,
  latestCommentGithubId,
  operationIntentMarker,
  publishIntent,
  publishOnce,
  retainFirstVerdict,
  retainedVerdict,
  sharedPublishRecord,
  type PublishDb,
} from "../../src/state/publish.ts";
import { openSqliteAppState } from "./db.ts";
import { bumpLaneEpoch, cancelWorkRun } from "../../src/state/workRuns.ts";

const PR_KEY = "o/r#1";

function seedRun(db: PublishDb, workId: string, status = "running") {
  db.prepare(
    `INSERT INTO pr_state (pr_key, lifecycle_state, observed_at, updated_at)
     VALUES (?, 'open', 0, 0) ON CONFLICT (pr_key) DO NOTHING`,
  ).run(PR_KEY);
  db.prepare(
    `INSERT INTO work_runs (work_id, pr_key, kind, lane, lane_epoch, status, current_attempt_no, payload_json, created_at, updated_at)
     VALUES (?, ?, 'review', 'review', 0, ?, 1, '{}', 0, 0)`,
  ).run(workId, PR_KEY, status);
}

function ambiguousError() {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

function base(db: PublishDb, workId: string, operationKey: string, resourceTarget = "comment:1") {
  return {
    db,
    workId,
    prKey: PR_KEY,
    resourceTarget,
    operationKey,
    mutationKind: "github.test",
    sleep: async () => undefined,
  };
}

describe("fail-closed publish state machine on app_state.sqlite", () => {
  let state: ReturnType<typeof openSqliteAppState>;
  let server: Server | undefined;
  let hits = 0;

  beforeEach(() => {
    state = openSqliteAppState();
    hits = 0;
  });

  afterEach(async () => {
    state.close();
    if (server !== undefined) {
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  async function listen(status: number) {
    server = createServer((request, response) => {
      hits += 1;
      request.resume();
      response.writeHead(status, {
        "content-type": "application/json",
        ...(status === 429 ? { "retry-after": "0", "x-ratelimit-remaining": "0" } : {}),
      });
      response.end(JSON.stringify({ message: `status ${status}` }));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  it.each([500, 429])(
    "sends a real mutation Octokit write exactly once when GitHub answers %i",
    async (status) => {
      seedRun(state.db, "wi-http");
      const baseUrl = await listen(status);
      const octokit = createMutationOctokit({ token: "t" });
      const mutate = () =>
        octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          baseUrl,
          owner: "o",
          repo: "r",
          issue_number: 1,
          body: "hello",
        });
      await expect(
        publishOnce({ ...base(state.db, "wi-http", "op:http"), mutate }),
      ).rejects.toThrow();
      expect(hits).toBe(1);
      const intent = publishIntent(state.db, "wi-http", "op:http");
      expect(intent?.state).toBe("outcome_unknown_recoverable");
      await expect(
        publishOnce({ ...base(state.db, "wi-http", "op:http"), mutate }),
      ).rejects.toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });
      expect(hits).toBe(1);
    },
  );

  it("blocks a concurrent writer on the same resource target behind the BEGIN IMMEDIATE fence", async () => {
    seedRun(state.db, "wi-a");
    seedRun(state.db, "wi-b");
    let release: (() => void) | undefined;
    const first = publishOnce({
      ...base(state.db, "wi-a", "op:a"),
      mutate: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("a");
        }),
    });
    let secondMutated = false;
    await expect(
      publishOnce({
        ...base(state.db, "wi-b", "op:b"),
        mutate: async () => {
          secondMutated = true;
          return "b";
        },
      }),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_conflict" });
    expect(secondMutated).toBe(false);
    release?.();
    await expect(first).resolves.toBe("a");
    await expect(
      publishOnce({ ...base(state.db, "wi-b", "op:b"), mutate: async () => "b" }),
    ).resolves.toBe("b");
  });

  it("refuses a cancelled sender before the HTTP write", async () => {
    seedRun(state.db, "wi-cancelled", "cancelled");
    let mutated = false;
    await expect(
      publishOnce({
        ...base(state.db, "wi-cancelled", "op:c"),
        mutate: async () => {
          mutated = true;
        },
      }),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_gate_failed" });
    expect(mutated).toBe(false);
    await expect(
      publishOnce({
        ...base(state.db, "wi-cancelled", "op:c"),
        gate: "cleanup",
        allowsUndefinedResult: true,
        mutate: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["superseded epoch", "cancelled run"])(
    "does not reconcile a successful in-flight write after a %s",
    async (reason) => {
      seedRun(state.db, "wi-stale");
      let accept: ((value: string) => void) | undefined;
      const accepted = new Promise<string>((resolve) => {
        accept = resolve;
      });
      let calls = 0;
      const params = {
        ...base(state.db, "wi-stale", "op:stale"),
        laneEpoch: 0,
        publishRecordKeys: [{ recordKey: "stale", step: "test", payloadJson: "{}" }],
        mutate: () => {
          calls += 1;
          return accepted;
        },
      };
      const first = publishOnce(params);
      expect(publishIntent(state.db, "wi-stale", "op:stale")?.state).toBe("mutating");
      if (reason === "superseded epoch") {
        bumpLaneEpoch(state.db, { prKey: PR_KEY, lane: "review", now: 1 });
      } else {
        cancelWorkRun(state.db, { workId: "wi-stale", reason: "test", now: 1 });
      }
      accept?.("posted");
      const terminal = {
        code: "operation_intent.mutation_outcome_unknown",
        context: { unknownResolution: "terminal" },
      };
      await expect(first).rejects.toMatchObject(terminal);
      expect(publishIntent(state.db, "wi-stale", "op:stale")?.state).toBe(
        "outcome_unknown_terminal",
      );
      expect(state.db.prepare("SELECT 1 FROM publish_records").all()).toHaveLength(0);
      await expect(publishOnce(params)).rejects.toMatchObject(terminal);
      expect(calls).toBe(1);
    },
  );

  it("reconciles a recoverable outcome from exact evidence without sending again", async () => {
    seedRun(state.db, "wi-recover");
    let calls = 0;
    const params = {
      ...base(state.db, "wi-recover", "op:recover"),
      laneEpoch: 0,
      mutate: async () => {
        calls += 1;
        throw ambiguousError();
      },
    };
    await expect(publishOnce(params)).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
    });
    expect(publishIntent(state.db, "wi-recover", "op:recover")?.state).toBe(
      "outcome_unknown_recoverable",
    );
    await expect(
      publishOnce({ ...params, recover: async () => ({ found: true, value: { id: 42 } }) }),
    ).resolves.toEqual({ id: 42 });
    expect(publishIntent(state.db, "wi-recover", "op:recover")).toMatchObject({
      state: "reconciled",
      result_json: '{"id":42}',
    });
    await expect(publishOnce(params)).resolves.toEqual({ id: 42 });
    expect(calls).toBe(1);
  });

  it("rejects recovered evidence when the lane changes during lookup", async () => {
    seedRun(state.db, "wi-recover-stale");
    let find: ((value: { found: true; value: string }) => void) | undefined;
    const found = new Promise<{ found: true; value: string }>((resolve) => {
      find = resolve;
    });
    const params = {
      ...base(state.db, "wi-recover-stale", "op:recover-stale"),
      laneEpoch: 0,
      mutate: async () => {
        throw ambiguousError();
      },
    };
    await expect(publishOnce(params)).rejects.toThrow();
    const recovery = publishOnce({ ...params, recover: () => found });
    bumpLaneEpoch(state.db, { prKey: PR_KEY, lane: "review", now: 1 });
    find?.({ found: true, value: "posted" });
    await expect(recovery).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
      context: { unknownResolution: "terminal" },
    });
    expect(publishIntent(state.db, "wi-recover-stale", "op:recover-stale")?.state).toBe(
      "outcome_unknown_terminal",
    );
  });

  it("settles accepted writes during shutdown without admitting new writes", async () => {
    seedRun(state.db, "wi-shutdown");
    let accept: ((value: string) => void) | undefined;
    const accepted = new Promise<string>((resolve) => {
      accept = resolve;
    });
    let shuttingDown = false;
    const params = {
      ...base(state.db, "wi-shutdown", "op:inflight"),
      laneEpoch: 0,
      shutdownRequested: () => shuttingDown,
      mutate: () => accepted,
    };
    const inflight = publishOnce(params);
    shuttingDown = true;
    accept?.("posted");
    await expect(inflight).resolves.toBe("posted");
    expect(publishIntent(state.db, "wi-shutdown", "op:inflight")?.state).toBe("reconciled");
    await expect(publishOnce({ ...params, operationKey: "op:new" })).rejects.toMatchObject({
      code: "operation_intent.mutation_gate_failed",
    });
    expect(publishIntent(state.db, "wi-shutdown", "op:new")).toBeUndefined();
  });

  it("keeps an overwrite-sensitive outcome_unknown_recoverable intent blocking later writes", async () => {
    seedRun(state.db, "wi-old");
    seedRun(state.db, "wi-new");
    await expect(
      publishOnce({
        ...base(state.db, "wi-old", "op:edit", "comment:7"),
        blocksOverwrite: true,
        mutate: async () => {
          throw ambiguousError();
        },
      }),
    ).rejects.toThrow();
    expect(publishIntent(state.db, "wi-old", "op:edit")?.state).toBe("outcome_unknown_recoverable");
    await expect(
      publishOnce({
        ...base(state.db, "wi-new", "op:edit2", "comment:7"),
        mutate: async () => "late",
      }),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_conflict" });
    await expect(
      publishOnce({
        ...base(state.db, "wi-new", "op:other", "comment:8"),
        mutate: async () => "other",
      }),
    ).resolves.toBe("other");
  });

  it("retries a proven no-acceptance failure through mutation_failed", async () => {
    seedRun(state.db, "wi-retry");
    let calls = 0;
    const mutate = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rejected"), { mutationAccepted: false });
      return "posted";
    };
    await expect(publishOnce({ ...base(state.db, "wi-retry", "op:r"), mutate })).rejects.toThrow(
      "rejected",
    );
    expect(publishIntent(state.db, "wi-retry", "op:r")?.state).toBe("mutation_failed");
    await expect(publishOnce({ ...base(state.db, "wi-retry", "op:r"), mutate })).resolves.toBe(
      "posted",
    );
    await expect(publishOnce({ ...base(state.db, "wi-retry", "op:r"), mutate })).resolves.toBe(
      "posted",
    );
    expect(calls).toBe(2);
    expect(publishIntent(state.db, "wi-retry", "op:r")?.state).toBe("reconciled");
  });

  it("fails labels and commit statuses closed on an ambiguous write", async () => {
    seedRun(state.db, "wi-labels");
    let calls = 0;
    const mutate = async () => {
      calls += 1;
      throw ambiguousError();
    };
    await expect(
      publishOnce({
        ...base(state.db, "wi-labels", "review:labels:o/r#1", "labels"),
        failClosed: true,
        recover: async () => ({ found: true as const, value: undefined }),
        mutate,
      }),
    ).rejects.toMatchObject({ context: { unknownResolution: "terminal" } });
    expect(publishIntent(state.db, "wi-labels", "review:labels:o/r#1")?.state).toBe(
      "outcome_unknown_terminal",
    );
    await expect(
      publishOnce({
        ...base(state.db, "wi-labels", "review:labels:o/r#1", "labels"),
        failClosed: true,
        mutate,
      }),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });
    expect(calls).toBe(1);
  });

  it("retains the first selected verdict for a work item independently of later selections", () => {
    seedRun(state.db, "wi-v");
    const first = retainFirstVerdict(state.db, {
      prKey: PR_KEY,
      workId: "wi-v",
      reviewLens: "review",
      verdict: { conclusion: "failure", summary: "first" },
    });
    const second = retainFirstVerdict(state.db, {
      prKey: PR_KEY,
      workId: "wi-v",
      reviewLens: "review",
      verdict: { conclusion: "success", summary: "second" },
    });
    expect(second).toEqual(first);
    expect(
      retainedVerdict(state.db, { prKey: PR_KEY, workId: "wi-v", reviewLens: "review" }),
    ).toMatchObject({ verdict: { summary: "first" } });
    const next = retainFirstVerdict(state.db, {
      prKey: PR_KEY,
      workId: "wi-next",
      reviewLens: "review",
      verdict: { conclusion: "success", summary: "next run" },
    });
    expect(next.verdict).toEqual({ conclusion: "success", summary: "next run" });
  });

  it("rediscovers pre-existing bot summary and standing review artifacts on an empty store", async () => {
    seedRun(state.db, "wi-cutover");
    const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    controls.setConversationComments([
      {
        id: 4242,
        inReplyToId: null,
        authorLogin: "pr-agent[bot]",
        body: `${REVIEW_SUMMARY_SENTINEL}\nold summary\n<!-- pr-agent:progress-revision 7 -->`,
      },
    ]);
    const marker = operationIntentMarker("review:verdict_review:old-work", "old-work");
    controls.setPullRequestReviews([
      {
        id: 9090,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: `No blocking findings remain.\n${marker}`,
        commitId: "head",
        htmlUrl: "",
        state: "APPROVED",
      },
    ]);
    expect(latestCommentGithubId(state.db, PR_KEY, "review")).toBeNull();
    await expect(
      ensureRediscoveredSummaryComment(state.db, surface, {
        workId: "wi-cutover",
        prKey: PR_KEY,
        reviewLens: "review",
        sentinel: REVIEW_SUMMARY_SENTINEL,
      }),
    ).resolves.toBe(4242);
    expect(latestCommentGithubId(state.db, PR_KEY, "review")).toBe(4242);
    await publishReviewVerdictEvent({
      prSurface: surface,
      event: "APPROVE",
      headSha: "head",
      target: { db: state.db, workItemId: "wi-cutover", resourceKey: PR_KEY },
      reviewLens: "review",
    });
    expect(controls.threadBatches).toHaveLength(0);
    expect(sharedPublishRecord(state.db, PR_KEY, "review", "standing_review")?.githubId).toBe(9090);
  });
});
