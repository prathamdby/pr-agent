import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  loadVerificationThreadLedger,
  parseVerificationThreadLedger,
  upsertVerificationThreadState,
} from "../src/agentWork/verificationThreadLedger.js";
import { VERIFICATION_PUBLISH_LENS } from "../src/settings/index.js";

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
