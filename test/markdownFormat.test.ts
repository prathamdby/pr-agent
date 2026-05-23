import { describe, expect, it } from "vitest";
import {
  escapeAlertBody,
  escapeTableCell,
  escapeTableCellContent,
  renderGitHubAlert,
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
});
