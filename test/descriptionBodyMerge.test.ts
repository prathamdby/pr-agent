import { describe, expect, it } from "vitest";
import { mergeDescriptionIntoPrBody } from "../src/agent/descriptionBodyMerge.js";
import { DESCRIPTION_AGENT_HEADER } from "../src/settings/index.js";

const agentBlock = `${DESCRIPTION_AGENT_HEADER}\n\n### PR Type\n\nEnhancement`;

describe("mergeDescriptionIntoPrBody", () => {
  it("uses agent block only when body empty", () => {
    expect(mergeDescriptionIntoPrBody({ currentBody: "", agentBlock })).toBe(agentBlock);
  });

  it("prepends user content when header absent", () => {
    const merged = mergeDescriptionIntoPrBody({
      currentBody: "Manual notes from author",
      agentBlock,
    });
    expect(merged.startsWith("Manual notes from author")).toBe(true);
    expect(merged).toContain(agentBlock);
  });

  it("replaces only agent block on re-run", () => {
    const current = `User intro\n\n___\n\n${DESCRIPTION_AGENT_HEADER}\n\nOld agent content`;
    const merged = mergeDescriptionIntoPrBody({ currentBody: current, agentBlock });
    expect(merged.startsWith("User intro")).toBe(true);
    expect(merged).toContain(agentBlock);
    expect(merged).not.toContain("Old agent content");
  });
});
