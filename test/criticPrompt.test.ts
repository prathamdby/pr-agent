import { describe, expect, it } from "vitest";
import {
  buildCriticSystemPrompt,
  buildCriticUserContent,
  CRITIC_GUIDANCE,
  CRITIC_IDS,
  REQUIRED_CRITIC_IDS,
} from "../src/review/prompts/criticPrompt.js";

describe("criticPrompt", () => {
  describe("CRITIC_IDS and REQUIRED_CRITIC_IDS", () => {
    it("exposes exactly four critic IDs in fixed order", () => {
      expect(CRITIC_IDS).toEqual(["correctness", "security", "reliability", "change-safety"]);
    });

    it("requires correctness, security, and reliability but not change-safety", () => {
      expect(REQUIRED_CRITIC_IDS).toEqual(["correctness", "security", "reliability"]);
      expect(REQUIRED_CRITIC_IDS).not.toContain("change-safety");
    });
  });

  describe("CRITIC_GUIDANCE", () => {
    it("provides domain-specific guidance for every critic", () => {
      for (const critic of CRITIC_IDS) {
        expect(CRITIC_GUIDANCE[critic].length).toBeGreaterThan(20);
      }
    });

    it("correctness owns functional defects and API contracts", () => {
      expect(CRITIC_GUIDANCE.correctness).toContain("functional defects");
      expect(CRITIC_GUIDANCE.correctness).toContain("API contracts");
    });

    it("security owns trust boundaries and injection", () => {
      expect(CRITIC_GUIDANCE.security).toContain("trust boundaries");
      expect(CRITIC_GUIDANCE.security).toContain("injection");
    });

    it("reliability owns concurrency and partial failure", () => {
      expect(CRITIC_GUIDANCE.reliability).toContain("Concurrency");
      expect(CRITIC_GUIDANCE.reliability).toContain("partial failure");
    });

    it("change-safety owns structural defects and excludes taste-only findings", () => {
      expect(CRITIC_GUIDANCE["change-safety"]).toContain("structural defects");
      expect(CRITIC_GUIDANCE["change-safety"]).toContain("taste-only");
    });
  });

  describe("buildCriticSystemPrompt", () => {
    it("includes the critic domain guidance", () => {
      const prompt = buildCriticSystemPrompt("correctness");
      expect(prompt).toContain(CRITIC_GUIDANCE.correctness);
    });

    it("includes adversarial falsification duty", () => {
      const prompt = buildCriticSystemPrompt("security");
      expect(prompt).toContain("adversarial falsification");
    });

    it("includes testing gap duty", () => {
      const prompt = buildCriticSystemPrompt("reliability");
      expect(prompt).toContain("testing gaps");
    });

    it("includes shared evidence reference", () => {
      const prompt = buildCriticSystemPrompt("change-safety");
      expect(prompt).toContain("shared evidence");
    });

    it("includes bounded follow-up budget language", () => {
      const prompt = buildCriticSystemPrompt("correctness");
      expect(prompt).toContain("follow-up budget");
    });

    it("requires submitCriticReport exactly once", () => {
      const prompt = buildCriticSystemPrompt("security");
      expect(prompt).toContain("submitCriticReport exactly once");
    });

    it("marks repository content as untrusted", () => {
      const prompt = buildCriticSystemPrompt("reliability");
      expect(prompt).toContain("untrusted data");
    });
  });

  describe("buildCriticUserContent", () => {
    it("includes repository, PR number, and head SHA", () => {
      const content = buildCriticUserContent({
        owner: "owner",
        repo: "repo",
        prNumber: 42,
        headSha: "abc123",
        evidenceBlock: "evidence here",
      });
      expect(content).toContain("owner/repo");
      expect(content).toContain("42");
      expect(content).toContain("abc123");
    });

    it("includes the evidence block", () => {
      const content = buildCriticUserContent({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        evidenceBlock: "## shared evidence block content",
      });
      expect(content).toContain("## shared evidence block content");
    });

    it("wraps user supplement as untrusted", () => {
      const content = buildCriticUserContent({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        evidenceBlock: "ev",
        userSupplement: "focus on auth",
      });
      expect(content).toContain("user_supplement");
      expect(content).toContain("focus on auth");
    });

    it("omits user supplement block when not provided", () => {
      const content = buildCriticUserContent({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        evidenceBlock: "ev",
      });
      expect(content).not.toContain("user_supplement");
    });
  });
});
