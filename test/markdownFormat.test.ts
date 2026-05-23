import { describe, expect, it } from "vitest";
import {
  escapeAlertBody,
  escapeTableCell,
  escapeTableCellContent,
  markdownInlineToHtml,
  renderGitHubAlert,
  renderKeyValueTable,
} from "../src/github/markdownFormat.js";

describe("markdownFormat", () => {
  it("escapeTableCell escapes pipes and newlines", () => {
    expect(escapeTableCell("a | b\nc")).toBe("a \\| b c");
  });

  it("escapeTableCellContent applies table then HTML escaping", () => {
    expect(escapeTableCellContent("a | b\n<script>")).toBe("a \\| b &lt;script&gt;");
  });

  it("escapeAlertBody handles blank lines and leading gt", () => {
    expect(escapeAlertBody("line one\n\n> quoted")).toBe("> line one\n> \n> \\> quoted");
  });

  it("renderGitHubAlert wraps body in alert syntax", () => {
    expect(renderGitHubAlert("NOTE", "hello")).toBe("> [!NOTE]\n> hello");
  });

  it("markdownInlineToHtml converts bold, links, emphasis, and code", () => {
    const html = markdownInlineToHtml(
      "**[Bug \\| typo](https://example.com)**<br>_On the diff · `src/x.ts` · lines 1-2_",
    );
    expect(html).toContain('<strong><a href="https://example.com">Bug | typo</a></strong>');
    expect(html).toContain("<em>On the diff · <code>src/x.ts</code> · lines 1-2</em>");
  });

  it("renderKeyValueTable omits GFM header row", () => {
    const table = renderKeyValueTable([
      ["**Effort**", "Moderate · `2/5`"],
      ["**P1**", "plain value"],
    ]);
    expect(table).not.toContain("| | |");
    expect(table).toContain("<table>");
    expect(table).toContain("<strong>Effort</strong>");
    expect(table).toContain("<code>2/5</code>");
  });
});
