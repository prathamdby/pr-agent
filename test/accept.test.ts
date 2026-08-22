import { describe, expect, it } from "vitest";
import { negotiateType, parseAccept } from "../site/lib/accept.js";

const MD = "text/markdown";
const HTML = "text/html";

/** Server preference order for a page: HTML unless the client asks for markdown. */
const PAGE = [HTML, MD] as const;
/** Reverse order, used by machine-facing responses that default to markdown. */
const AGENT = [MD, HTML] as const;

describe("parseAccept", () => {
  it("reads types, q-values, and specificity in header order", () => {
    expect(parseAccept("text/markdown, text/html;q=0.8, */*;q=0.1")).toEqual([
      { type: "text/markdown", q: 1, specificity: 2, index: 0 },
      { type: "text/html", q: 0.8, specificity: 2, index: 1 },
      { type: "*/*", q: 0.1, specificity: 0, index: 2 },
    ]);
  });

  it("lowercases ranges and tolerates whitespace", () => {
    expect(parseAccept("  TEXT/Markdown ;  Q=0.5 ")[0]).toEqual({
      type: "text/markdown",
      q: 0.5,
      specificity: 2,
      index: 0,
    });
  });

  it("scores a subtype wildcard between a full type and the catch-all", () => {
    const [full, subtype, catchAll] = parseAccept("text/markdown, text/*, */*");
    expect(full?.specificity).toBe(2);
    expect(subtype?.specificity).toBe(1);
    expect(catchAll?.specificity).toBe(0);
  });

  it("clamps out-of-range q and defaults unparseable q to 1", () => {
    expect(parseAccept("text/html;q=9")[0]?.q).toBe(1);
    expect(parseAccept("text/html;q=-2")[0]?.q).toBe(0);
    expect(parseAccept("text/html;q=abc")[0]?.q).toBe(1);
    expect(parseAccept("text/html;level=1")[0]?.q).toBe(1);
  });

  it("drops entries that are not media ranges", () => {
    expect(parseAccept("nonsense, , text/html")).toEqual([
      { type: "text/html", q: 1, specificity: 2, index: 0 },
    ]);
  });
});

describe("negotiateType", () => {
  // The published vectors from acceptmarkdown.com/guides/accept-parsing.
  it.each([
    ["text/markdown", MD],
    ["text/markdown, text/html;q=0.8", MD],
    ["text/html", HTML],
    ["text/markdown;q=0, text/html", HTML],
  ])("serves %s as %s", (header, expected) => {
    expect(negotiateType(header, PAGE)).toBe(expected);
  });

  it("returns null when the only representation is refused with q=0", () => {
    expect(negotiateType("text/markdown;q=0", [MD])).toBeNull();
  });

  it("serves the server default when the client sets no constraint", () => {
    expect(negotiateType(null, PAGE)).toBe(HTML);
    expect(negotiateType(undefined, PAGE)).toBe(HTML);
    expect(negotiateType("*/*", PAGE)).toBe(HTML);
  });

  it("lets preference order pick the default for machine-facing responses", () => {
    expect(negotiateType(null, AGENT)).toBe(MD);
    expect(negotiateType("*/*", AGENT)).toBe(MD);
    expect(negotiateType("text/plain, */*", AGENT)).toBe(MD);
  });

  it("keeps a real browser header on HTML even when markdown is preferred by the server", () => {
    const chrome =
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
    expect(negotiateType(chrome, AGENT)).toBe(HTML);
    expect(negotiateType(chrome, PAGE)).toBe(HTML);
  });

  it("prefers the more specific range when q-values tie", () => {
    expect(negotiateType("*/*, text/markdown", PAGE)).toBe(MD);
    expect(negotiateType("text/*;q=0.4, text/markdown;q=0.9", PAGE)).toBe(MD);
  });

  it("scores each representation by its most specific range, then picks the highest q", () => {
    // text/markdown;q=0.1 overrides text/*;q=0.9 for markdown alone, so HTML wins at 0.9.
    expect(negotiateType("text/*;q=0.9, text/markdown;q=0.1", PAGE)).toBe(HTML);
  });

  it("lets the higher-q duplicate of a range speak for it", () => {
    expect(negotiateType("text/markdown;q=0, text/markdown;q=0.9", PAGE)).toBe(MD);
    expect(negotiateType("text/markdown;q=0.9, text/markdown;q=0", PAGE)).toBe(MD);
  });

  it("still refuses when every duplicate of the only representation is q=0", () => {
    expect(negotiateType("text/markdown;q=0, text/markdown;q=0", [MD])).toBeNull();
  });

  it("returns null when nothing the server produces is acceptable", () => {
    expect(negotiateType("application/pdf", PAGE)).toBeNull();
    expect(negotiateType("image/png, application/json;q=0.5", PAGE)).toBeNull();
  });

  it("treats an empty header as a constraint nothing satisfies", () => {
    expect(negotiateType("", PAGE)).toBeNull();
    expect(negotiateType("   ", PAGE)).toBeNull();
  });

  it("falls back to the default when the header is present but unparseable", () => {
    expect(negotiateType("nonsense", PAGE)).toBe(HTML);
  });

  it("ignores a q=0 refusal that only covers the non-default representation", () => {
    expect(negotiateType("text/html;q=0, text/markdown", PAGE)).toBe(MD);
    expect(negotiateType("*/*;q=0, text/html", PAGE)).toBe(HTML);
  });
});
