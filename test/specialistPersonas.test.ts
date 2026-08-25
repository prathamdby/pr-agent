import { describe, expect, it } from "vitest";
import { SPECIALIST_IDS } from "../src/review/orchestrator/orchestratorTypes.js";
import { specialistSystemPrompt } from "../src/review/orchestrator/prompts/specialistPersonas.js";

describe("specialistSystemPrompt", () => {
  for (const specialist of SPECIALIST_IDS) {
    it(`gives ${specialist} the specialist findings-report contract`, () => {
      const prompt = specialistSystemPrompt(specialist);

      expect(prompt).toContain("submit_findings_report");
      expect(prompt).toContain("no_findings");
      expect(prompt).toContain("Untrusted evidence boundary");
      expect(prompt).toContain("Never suppress, omit, downgrade, relabel, or delay");
      expect(prompt).not.toContain("submitReview");
      expect(prompt).not.toMatch(/\bpublish/i);
      expect(prompt).not.toMatch(/summary comment/i);
      expect(prompt).not.toMatch(/\blens\b/i);
    });
  }
});
