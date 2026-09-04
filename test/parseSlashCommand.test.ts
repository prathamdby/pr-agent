import { describe, expect, it } from "vitest";
import {
  isReviewForceCommand,
  parseSlashCommand,
  parseTriageCommand,
} from "../src/commands/parseSlashCommand.js";

describe("parseSlashCommand", () => {
  it("parses first non-empty line command", () => {
    expect(parseSlashCommand("/review please")).toBe("review");
    expect(parseSlashCommand("/review-security")).toBe("review-security");
    expect(parseSlashCommand("/review-quality")).toBe("review-quality");
    expect(parseSlashCommand("/review-tests")).toBe("review-tests");
    expect(parseSlashCommand(" \n/help")).toBe("help");
    expect(parseSlashCommand(" \r\n/ask question\n/review")).toBe("ask");
  });

  it("is case-sensitive for token", () => {
    expect(parseSlashCommand("/Review")).toBe(null);
  });

  it("returns null when no command", () => {
    expect(parseSlashCommand("hello")).toBe(null);
    expect(parseSlashCommand("hello\n/review")).toBe(null);
    expect(parseSlashCommand("")).toBe(null);
  });
});

describe("parseTriageCommand", () => {
  it("returns null when the command is not triage", () => {
    expect(parseTriageCommand("/review")).toBe(null);
    expect(parseTriageCommand("hello")).toBe(null);
  });

  it("parses apply, preview, and bulk", () => {
    expect(parseTriageCommand("/triage")).toEqual({ kind: "apply" });
    expect(parseTriageCommand("/triage   ")).toEqual({ kind: "apply" });
    expect(parseTriageCommand(" \n/triage preview")).toEqual({ kind: "preview" });
    expect(parseTriageCommand("/triage preview and read this")).toEqual({ kind: "preview" });
    expect(parseTriageCommand("/triage all")).toEqual({
      kind: "bulk",
      excludeThreadRootCommentIds: [],
    });
  });

  it("parses exclude lists as thread root comment ids", () => {
    expect(parseTriageCommand("/triage all exclude 11,22")).toEqual({
      kind: "bulk",
      excludeThreadRootCommentIds: [11, 22],
    });
    expect(parseTriageCommand("/triage all exclude 11 22")).toEqual({
      kind: "bulk",
      excludeThreadRootCommentIds: [11, 22],
    });
  });

  it("rejects unknown subcommands and bad exclude lists", () => {
    expect(parseTriageCommand("/triage all extra")).toEqual({
      kind: "invalid",
      reason: "unknown_subcommand",
    });
    expect(parseTriageCommand("/triage all excluded")).toEqual({
      kind: "invalid",
      reason: "unknown_subcommand",
    });
    expect(parseTriageCommand("/triage all exclude")).toEqual({
      kind: "invalid",
      reason: "invalid_exclude",
    });
    expect(parseTriageCommand("/triage all exclude abc")).toEqual({
      kind: "invalid",
      reason: "invalid_exclude",
    });
    expect(parseTriageCommand("/triage all exclude 9007199254740993")).toEqual({
      kind: "invalid",
      reason: "invalid_exclude",
    });
    expect(parseTriageCommand("/triage Preview")).toEqual({
      kind: "invalid",
      reason: "unknown_subcommand",
    });
    expect(parseTriageCommand("/triage please")).toEqual({
      kind: "invalid",
      reason: "unknown_subcommand",
    });
    expect(parseTriageCommand("/triage force")).toEqual({
      kind: "invalid",
      reason: "unknown_subcommand",
    });
  });
});

describe("isReviewForceCommand", () => {
  it("matches /review force on the first non-empty line", () => {
    expect(isReviewForceCommand("/review force")).toBe(true);
    expect(isReviewForceCommand("/review  force")).toBe(true);
    expect(isReviewForceCommand("/review\tforce")).toBe(true);
    expect(isReviewForceCommand("/review force and check auth")).toBe(true);
    expect(isReviewForceCommand(" \n/review force")).toBe(true);
    expect(isReviewForceCommand("/review force\nmore context")).toBe(true);
  });

  it("pins whitespace boundaries around the tokens", () => {
    // Anchored to the start of the first non-empty line: leading whitespace rejects.
    expect(isReviewForceCommand("   /review force")).toBe(false);
    expect(isReviewForceCommand("\t/review force")).toBe(false);
    // Trailing whitespace after `force` still matches.
    expect(isReviewForceCommand("/review force ")).toBe(true);
    expect(isReviewForceCommand("/review force\t")).toBe(true);
    expect(isReviewForceCommand("/review force\n")).toBe(true);
  });

  it("rejects non-force and non-review text", () => {
    expect(isReviewForceCommand("/review")).toBe(false);
    expect(isReviewForceCommand("/review please")).toBe(false);
    expect(isReviewForceCommand("/review forse")).toBe(false);
    expect(isReviewForceCommand("/review forcefully")).toBe(false);
    expect(isReviewForceCommand("/review Force")).toBe(false);
    expect(isReviewForceCommand("/reviewer force")).toBe(false);
    expect(isReviewForceCommand("hello\n/review force")).toBe(false);
    expect(isReviewForceCommand("")).toBe(false);
  });
});
