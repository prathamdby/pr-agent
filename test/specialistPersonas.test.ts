import { describe, expect, it } from "vitest";
import { SPECIALIST_IDS } from "../src/review/orchestrator/specialistReport.js";
import { specialistSystemPrompt } from "../src/review/orchestrator/prompts/specialistPersonas.js";

describe("specialistSystemPrompt", () => {
  for (const id of SPECIALIST_IDS) {
    describe(`${id} persona`, () => {
      const prompt = specialistSystemPrompt(id);

      it("submits via submit_findings_report and never submitReview", () => {
        expect(prompt).toContain("submit_findings_report");
        expect(prompt).not.toContain("submitReview");
      });

      it("treats no_findings as a first-class successful report", () => {
        expect(prompt).toContain("no_findings");
      });

      it("does not instruct the specialist to publish or write a summary", () => {
        expect(prompt).not.toContain("publish_thread");
        expect(prompt).not.toContain("review summary comment");
      });

      it("does not recommend removed lens slash commands", () => {
        expect(prompt).not.toContain("/review-security");
        expect(prompt).not.toContain("/review-quality");
        expect(prompt).not.toContain("/review-tests");
      });

      it("keeps the shared investigation protocol", () => {
        expect(prompt).toContain("Investigation protocol (local workspace tools)");
      });
    });
  }

  it("keeps each persona's distinct investigation methodology", () => {
    expect(specialistSystemPrompt("correctness")).toContain(
      "you report problems, not prescriptions",
    );
    expect(specialistSystemPrompt("security")).toContain("Known vulnerability categories");
    expect(specialistSystemPrompt("quality")).toContain("code-judo");
    expect(specialistSystemPrompt("tests")).toContain("proposed test case");
  });

  it("maps every specialist id to a distinct prompt", () => {
    const prompts = SPECIALIST_IDS.map((id) => specialistSystemPrompt(id));
    expect(new Set(prompts).size).toBe(SPECIALIST_IDS.length);
  });
});
