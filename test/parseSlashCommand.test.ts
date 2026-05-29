import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../src/commands/parseSlashCommand.js";

describe("parseSlashCommand", () => {
  it("parses first non-empty line command", () => {
    expect(parseSlashCommand("/review please")).toBe("review");
    expect(parseSlashCommand("/review-security")).toBe("review-security");
    expect(parseSlashCommand("/review-quality")).toBe("review-quality");
    expect(parseSlashCommand(" \n/help")).toBe("help");
  });

  it("is case-sensitive for token", () => {
    expect(parseSlashCommand("/Review")).toBe(null);
  });

  it("returns null when no command", () => {
    expect(parseSlashCommand("hello")).toBe(null);
    expect(parseSlashCommand("")).toBe(null);
  });
});
