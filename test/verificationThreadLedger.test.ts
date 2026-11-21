import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseVerificationThreadLedger,
  upsertVerificationThreadState,
} from "../src/agentWork/verificationThreadLedger.ts";
import {
  loadVerificationThreadLedger,
  saveVerificationThreadLedger,
} from "../src/state/verificationThreadLedger.ts";
import {
  openExecutorDurableHarness,
  type ExecutorDurableHarness,
} from "./helpers/executorDurableHarness.ts";

let harness: ExecutorDurableHarness;
beforeEach(() => {
  harness = openExecutorDurableHarness();
});
afterEach(() => {
  harness.close();
});

describe("verificationThreadLedger", () => {
  it("retains exact completion receipts while rejecting malformed ones", () => {
    const completion = {
      workItemId: "wi",
      operationKey: "verification:thread:10",
      headSha: "a".repeat(40),
      verdict: "dismissed",
      stubOutcome: "written",
      stubCommentId: 99,
      resolutionOutcome: "resolved",
    };
    const ledger = parseVerificationThreadLedger({
      threads: {
        "10": { lastVerdict: "dismissed", completion },
        "11": { lastVerdict: "fixed", completion: { ...completion, stubCommentId: undefined } },
      },
    });
    expect(ledger.threads["10"]).toEqual({ lastVerdict: "dismissed", completion });
    expect(ledger.threads["11"]).toEqual({ lastVerdict: "fixed" });
  });
  it("parses the threads map detail shape", () => {
    const ledger = parseVerificationThreadLedger({
      threads: {
        "10": {
          stubCommentId: 99,
          lastVerdict: "skipped",
          lastHeadSha: "a".repeat(40),
        },
      },
    });
    expect(ledger.threads["10"]).toEqual({
      stubCommentId: 99,
      lastVerdict: "skipped",
      lastHeadSha: "a".repeat(40),
    });
  });

  it("parses an optional failure signal without dropping threads", () => {
    const ledger = parseVerificationThreadLedger({
      threads: {
        "10": { lastVerdict: "skipped" },
      },
      failureSignal: {
        headSha: "a".repeat(40),
        commentId: 88,
        surface: "ci_cell",
      },
    });
    expect(ledger.threads["10"]?.lastVerdict).toBe("skipped");
    expect(ledger.failureSignal).toEqual({
      headSha: "a".repeat(40),
      commentId: 88,
      surface: "ci_cell",
    });
  });

  it("ignores a malformed failure signal", () => {
    const ledger = parseVerificationThreadLedger({
      threads: {},
      failureSignal: { headSha: "a".repeat(40), surface: "new_comment" },
    });
    expect(ledger.failureSignal).toBeUndefined();
  });

  it("migrates legacy actedThreadIds into stub-less skipped entries", () => {
    const ledger = parseVerificationThreadLedger({ actedThreadIds: [1, 2, "x"] });
    expect(ledger.threads).toEqual({
      "1": { lastVerdict: "skipped" },
      "2": { lastVerdict: "skipped" },
    });
  });

  it("returns an empty ledger for null, undefined, and non-object detail", () => {
    expect(parseVerificationThreadLedger(null)).toEqual({ threads: {} });
    expect(parseVerificationThreadLedger(undefined)).toEqual({ threads: {} });
    expect(parseVerificationThreadLedger("nope")).toEqual({ threads: {} });
    expect(parseVerificationThreadLedger(12)).toEqual({ threads: {} });
  });

  it("ignores a threads array and thread states missing lastVerdict", () => {
    expect(parseVerificationThreadLedger({ threads: [{ lastVerdict: "skipped" }] })).toEqual({
      threads: {},
    });
    expect(
      parseVerificationThreadLedger({
        threads: {
          "1": { stubCommentId: 9 },
          "2": { lastVerdict: "skipped", stubCommentId: "bad" },
        },
      }),
    ).toEqual({
      threads: {
        "2": { lastVerdict: "skipped" },
      },
    });
  });

  it("merges thread state without dropping siblings", () => {
    const base = parseVerificationThreadLedger({
      threads: {
        "1": { stubCommentId: 1, lastVerdict: "skipped" },
      },
    });
    const next = upsertVerificationThreadState(base, 2, {
      stubCommentId: 2,
      lastVerdict: "dismissed",
      terminal: true,
    });
    expect(next.threads["1"]?.stubCommentId).toBe(1);
    expect(next.threads["2"]?.terminal).toBe(true);
  });

  it("round-trips a failure signal through save and load", async () => {
    const ledger = {
      threads: { "10": { lastVerdict: "skipped" as const } },
      failureSignal: {
        headSha: "a".repeat(40),
        commentId: 88,
        surface: "ci_cell" as const,
      },
    };

    saveVerificationThreadLedger(harness.db, {
      workId: "wi-1",
      resourceKey: "o/r#1",
      ledger,
    });
    const loaded = loadVerificationThreadLedger(harness.db, { resourceKey: "o/r#1" });

    expect(loaded.failureSignal).toEqual(ledger.failureSignal);
    expect(loaded.threads["10"]?.lastVerdict).toBe("skipped");
  });

  it("keeps a thread that has no objections and round-trips one entry", async () => {
    const withoutObjections = parseVerificationThreadLedger({
      threads: {
        "10": { lastVerdict: "skipped", lastHeadSha: "b".repeat(40) },
      },
    });
    expect(withoutObjections.threads["10"]).toEqual({
      lastVerdict: "skipped",
      lastHeadSha: "b".repeat(40),
    });
    expect(withoutObjections.threads["10"]?.objections).toBeUndefined();

    const entry = {
      commentId: 50,
      updatedAt: "2026-01-01T14:32:47Z",
      decision: "concede" as const,
      answerCommentId: 80,
    };
    const loaded = parseVerificationThreadLedger({
      threads: {
        "10": { lastVerdict: "fixed", lastHeadSha: "a".repeat(40), objections: [entry] },
      },
    });
    expect(loaded.threads["10"]).toEqual({
      lastVerdict: "fixed",
      lastHeadSha: "a".repeat(40),
      objections: [entry],
    });
  });

  it("drops a malformed objection entry and keeps the rest of the thread", () => {
    const ledger = parseVerificationThreadLedger({
      threads: {
        "10": {
          stubCommentId: 4,
          lastVerdict: "skipped",
          lastHeadSha: "c".repeat(40),
          objections: [
            { commentId: 50, updatedAt: "2026-01-01T14:32:47Z", decision: "not_objection" },
            { commentId: 51, updatedAt: "yesterday", decision: "concede", answerCommentId: 9 },
            { commentId: 0, updatedAt: "2026-01-01T14:32:47Z", decision: "hold" },
          ],
        },
      },
    });
    expect(ledger.threads["10"]).toEqual({
      stubCommentId: 4,
      lastVerdict: "skipped",
      lastHeadSha: "c".repeat(40),
      objections: [{ commentId: 50, updatedAt: "2026-01-01T14:32:47Z", decision: "not_objection" }],
    });
  });

  it("loads an empty ledger when no publish record exists", () => {
    const ledger = loadVerificationThreadLedger(harness.db, { resourceKey: "o/r#1" });
    expect(ledger).toEqual({ threads: {} });
  });
});
