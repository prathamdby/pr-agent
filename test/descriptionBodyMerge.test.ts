import { describe, expect, it } from "vitest";
import {
  extractAgentDescriptionBlock,
  extractUserAuthoredPrBody,
  mergeDescriptionIntoPrBody,
  prBodyHasAgentDescriptionBlock,
  wrapDescriptionAgentBlock,
} from "../src/agent/description/descriptionBodyMerge.js";
import {
  DESCRIPTION_AGENT_BODY_BEGIN,
  DESCRIPTION_AGENT_BODY_END,
  DESCRIPTION_AGENT_HEADER,
} from "../src/settings/index.js";

const agentBlock = `${DESCRIPTION_AGENT_HEADER}\n\n### PR Type\n\nEnhancement`;

describe("wrapDescriptionAgentBlock", () => {
  it("wraps agent markdown in marker comments", () => {
    expect(wrapDescriptionAgentBlock(agentBlock)).toBe(
      `${DESCRIPTION_AGENT_BODY_BEGIN}\n${agentBlock}\n${DESCRIPTION_AGENT_BODY_END}`,
    );
  });
});

describe("extractUserAuthoredPrBody", () => {
  it("returns empty for marker-only bodies", () => {
    expect(extractUserAuthoredPrBody(wrapDescriptionAgentBlock(agentBlock))).toBe("");
  });

  it("keeps content outside marker boundaries", () => {
    const body = `Manual notes\n\n${wrapDescriptionAgentBlock(agentBlock)}`;
    expect(extractUserAuthoredPrBody(body)).toBe("Manual notes");
  });

  it("supports legacy header-only bodies", () => {
    const body = `User intro\n\n___\n\n${DESCRIPTION_AGENT_HEADER}\n\nOld agent content`;
    expect(extractUserAuthoredPrBody(body)).toBe("User intro\n\n___");
  });
});

describe("extractAgentDescriptionBlock", () => {
  it("reads agent content from marker boundaries", () => {
    expect(extractAgentDescriptionBlock(wrapDescriptionAgentBlock(agentBlock))).toBe(agentBlock);
  });

  it("reads legacy header-based agent content", () => {
    const body = `User intro\n\n${DESCRIPTION_AGENT_HEADER}\n\nOld agent content`;
    expect(extractAgentDescriptionBlock(body)).toBe(
      `${DESCRIPTION_AGENT_HEADER}\n\nOld agent content`,
    );
  });
});

describe("prBodyHasAgentDescriptionBlock", () => {
  it("detects marker and legacy agent blocks", () => {
    expect(prBodyHasAgentDescriptionBlock(wrapDescriptionAgentBlock(agentBlock))).toBe(true);
    expect(prBodyHasAgentDescriptionBlock(`${DESCRIPTION_AGENT_HEADER}\n\ncontent`)).toBe(true);
    expect(prBodyHasAgentDescriptionBlock("User notes only")).toBe(false);
  });
});

describe("mergeDescriptionIntoPrBody", () => {
  it("uses wrapped agent block only when body empty", () => {
    expect(mergeDescriptionIntoPrBody({ currentBody: "", agentBlock })).toBe(
      wrapDescriptionAgentBlock(agentBlock),
    );
  });

  it("prepends user content when agent block absent", () => {
    const merged = mergeDescriptionIntoPrBody({
      currentBody: "Manual notes from author",
      agentBlock,
    });
    expect(merged.startsWith("Manual notes from author")).toBe(true);
    expect(merged).toContain(wrapDescriptionAgentBlock(agentBlock));
  });

  it("replaces only marker-wrapped agent block on re-run", () => {
    const current = `User intro\n\n${wrapDescriptionAgentBlock(
      `${DESCRIPTION_AGENT_HEADER}\n\nOld agent content`,
    )}`;
    const merged = mergeDescriptionIntoPrBody({
      currentBody: current,
      agentBlock,
    });
    expect(merged.startsWith("User intro")).toBe(true);
    expect(merged).toContain(agentBlock);
    expect(merged).not.toContain("Old agent content");
  });

  it("migrates legacy header bodies to marker format on re-run", () => {
    const current = `User intro\n\n___\n\n${DESCRIPTION_AGENT_HEADER}\n\nOld agent content`;
    const merged = mergeDescriptionIntoPrBody({
      currentBody: current,
      agentBlock,
    });
    expect(merged.startsWith("User intro\n\n___")).toBe(true);
    expect(merged).toContain(DESCRIPTION_AGENT_BODY_BEGIN);
    expect(merged).toContain(agentBlock);
    expect(merged).not.toContain("Old agent content");
  });
});
