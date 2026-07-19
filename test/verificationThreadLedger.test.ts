import { describe, expect, it } from "vitest";
import {
  parseVerificationThreadLedger,
  upsertVerificationThreadState,
} from "../src/agentWork/verificationThreadLedger.js";

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
});
