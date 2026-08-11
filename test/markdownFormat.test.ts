import { describe, expect, it } from "vitest";
import {
  escapeAlertBody,
  escapeTableCell,
  escapeTableCellContent,
  renderGitHubAlert,
  renderKeyValueTable,
  renderTableLink,
  renderTableStrong,
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

  it("renderTableLink escapes title and href for HTML", () => {
    const html = renderTableLink("Bug <x>", 'https://example.com?q="1"');
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&quot;");
    expect(html).not.toContain('href="https://example.com?q="1""');
  });

  it("renderKeyValueTable omits GFM header row", () => {
    const table = renderKeyValueTable([
      [renderTableStrong("Size"), "<code>M</code>"],
      [renderTableStrong("P1"), "plain value"],
    ]);
    expect(table).not.toContain("| | |");
    expect(table).toContain("<table>");
    expect(table).toContain("<strong>Size</strong>");
    expect(table).toContain("<code>M</code>");
  });
});
