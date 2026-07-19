import { describe, expect, it } from "vitest";
import {
  botMentionLogins,
  commentMentionsBot,
  stripBotMentions,
} from "../src/commands/parseBotMention.js";

const BOT_LOGIN = "pr-agent[bot]";

describe("botMentionLogins", () => {
  it("includes full login and slug without [bot] suffix", () => {
    expect(botMentionLogins(BOT_LOGIN)).toEqual(["pr-agent[bot]", "pr-agent"]);
  });
});

describe("commentMentionsBot", () => {
  it("detects full bot login mention", () => {
    expect(commentMentionsBot("@pr-agent[bot] why?", BOT_LOGIN)).toBe(true);
  });

  it("detects slug mention without [bot] suffix", () => {
    expect(commentMentionsBot("@pr-agent explain", BOT_LOGIN)).toBe(true);
  });

  it("does not match bare text without @mention", () => {
    expect(commentMentionsBot("why is this P1?", BOT_LOGIN)).toBe(false);
  });

  it("does not match similar but distinct login prefixes", () => {
    expect(commentMentionsBot("@pr-agent-extra hello", BOT_LOGIN)).toBe(false);
  });

  it("returns false when botLogin is empty", () => {
    expect(commentMentionsBot("@anything hello", "")).toBe(false);
    expect(commentMentionsBot("@anything hello", "   ")).toBe(false);
  });
});

describe("stripBotMentions", () => {
  it("removes full login mention and trims question text", () => {
    expect(stripBotMentions("@pr-agent[bot] why?", BOT_LOGIN)).toBe("why?");
  });

  it("removes slug mention", () => {
    expect(stripBotMentions("@pr-agent explain", BOT_LOGIN)).toBe("explain");
  });

  it("collapses extra whitespace after stripping", () => {
    expect(stripBotMentions("@pr-agent[bot]   why   is   this?", BOT_LOGIN)).toBe("why is this?");
  });

  it("returns body unchanged when no mention is present", () => {
    expect(stripBotMentions("plain question", BOT_LOGIN)).toBe("plain question");
  });

  it("strips multiple mentions in the same body", () => {
    expect(stripBotMentions("@pr-agent[bot] hey @pr-agent explain", BOT_LOGIN)).toBe("hey explain");
  });
});
