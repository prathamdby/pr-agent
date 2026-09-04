import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  loadVerificationThreadLedger,
  parseVerificationThreadLedger,
  saveVerificationThreadLedger,
  upsertVerificationThreadState,
} from "../src/agentWork/verificationThreadLedger.js";
import { VERIFICATION_PUBLISH_LENS } from "../src/settings/index.js";

const mocks = vi.hoisted(() => ({
  recordPublishStep: vi.fn(),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  recordPublishStep: (...args: unknown[]) => mocks.recordPublishStep(...args),
}));

describe("verificationThreadLedger", () => {
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
    let stored: unknown;
    mocks.recordPublishStep.mockImplementation(async (_pool, params: { detail: unknown }) => {
      stored = params.detail;
    });
    const query = vi.fn(async () => ({
      rows: stored == null ? [] : [{ detail: stored }],
    }));
    const pool = { query } as unknown as Pool;
    const ledger = {
      threads: { "10": { lastVerdict: "skipped" as const } },
      failureSignal: {
        headSha: "a".repeat(40),
        commentId: 88,
        surface: "ci_cell" as const,
      },
    };

    await saveVerificationThreadLedger(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      ledger,
      leaseEpoch: 1,
    });
    const loaded = await loadVerificationThreadLedger(pool, { resourceKey: "o/r#1" });

    expect(loaded.failureSignal).toEqual(ledger.failureSignal);
    expect(loaded.threads["10"]?.lastVerdict).toBe("skipped");
  });

  it("loads an empty ledger when no publish record exists", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const ledger = await loadVerificationThreadLedger({ query } as unknown as Pool, {
      resourceKey: "o/r#1",
    });
    expect(ledger).toEqual({ threads: {} });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("resource_key"), [
      "o/r#1",
      VERIFICATION_PUBLISH_LENS,
      "verification_thread_actions",
    ]);
  });
});
