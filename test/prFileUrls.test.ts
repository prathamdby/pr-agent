import { describe, expect, it } from "vitest";
import { renderDescriptionAgentBlock } from "../src/agent/description/descriptionRender.js";
import { DESCRIPTION_PAYLOAD_BASE_EXAMPLE } from "../src/agent/description/descriptionSchema.js";

describe("description review map file URLs", () => {
  // Anchor matches live github.com/weppos/whois/pull/90/files HTML (verified 2026-05).
  it("links the file diff using the full sha256 of its repository path", () => {
    const body = renderDescriptionAgentBlock(
      {
        ...DESCRIPTION_PAYLOAD_BASE_EXAMPLE,
        prFiles: [{ filename: "lib/whois/errors.rb", changesTitle: "Error handling" }],
      },
      { owner: "weppos", repo: "whois", prNumber: 90 },
    );
    expect(body).toContain(
      "https://github.com/weppos/whois/pull/90/files#diff-447a111a507d8046f1ee64817cd197e9c68424b597d85d83afbbc9364f4fe41d",
    );
  });
});
