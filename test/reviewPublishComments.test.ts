import { describe, expect, it } from "vitest";
import { enrichPlacementsWithInlineCommentUrls } from "../src/github/reviewPublish.js";
import type { ReviewFinding } from "../src/agent/reviewSchema.js";
import type { InlinePlacement } from "../src/agent/reviewLocationValidation.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "src/x.ts",
    startLine: 4,
    endLine: 4,
    title: "Bug",
    detail: "Bad logic.",
    fixPrompt: "Fix it.",
    ...overrides,
  };
}

function placement(
  f: ReviewFinding,
  opts: { inlinePosted?: boolean; inlineLine?: number | null } = {},
): InlinePlacement {
  const inlinePosted = opts.inlinePosted ?? true;
  return {
    finding: f,
    inlineLine: inlinePosted ? (opts.inlineLine ?? f.startLine) : null,
    inlinePosted,
    inlineCapEligible: inlinePosted,
  };
}

describe("enrichPlacementsWithInlineCommentUrls", () => {
  it("attaches html_url for matching path and posted line", () => {
    const f = finding();
    const [enriched] = enrichPlacementsWithInlineCommentUrls([placement(f)], [
      {
        path: "src/x.ts",
        line: 4,
        id: 99,
        url: "https://github.com/acme/widgets/pull/42#discussion_r99",
      },
    ]);
    expect(enriched?.inlineCommentUrl).toBe(
      "https://github.com/acme/widgets/pull/42#discussion_r99",
    );
  });

  it("leaves summary-only placements unchanged", () => {
    const f = finding({ file: "README.md", startLine: 1, endLine: 1 });
    const [enriched] = enrichPlacementsWithInlineCommentUrls(
      [placement(f, { inlinePosted: false })],
      [
        {
          path: "README.md",
          line: 1,
          id: 1,
          url: "https://github.com/acme/widgets/pull/42#discussion_r1",
        },
      ],
    );
    expect(enriched?.inlineCommentUrl).toBeUndefined();
  });
});
