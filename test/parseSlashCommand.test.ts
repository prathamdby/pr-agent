import { describe, expect, it } from "vitest";
import { isReviewForceCommand, parseSlashCommand } from "../src/commands/parseSlashCommand.js";

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

describe("isReviewForceCommand", () => {
  it("matches /review force on the first non-empty line", () => {
    expect(isReviewForceCommand("/review force")).toBe(true);
    expect(isReviewForceCommand("/review  force")).toBe(true);
    expect(isReviewForceCommand("/review\tforce")).toBe(true);
    expect(isReviewForceCommand("/review force and check auth")).toBe(true);
    expect(isReviewForceCommand(" \n/review force")).toBe(true);
    expect(isReviewForceCommand("/review force\nmore context")).toBe(true);
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
