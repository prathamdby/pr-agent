import type { AskRunParams } from "./askRunTypes.js";
import { wrapTrustedContext, wrapUntrustedBlock } from "./promptBlocks.js";

export function buildAskUserContent(params: AskRunParams): string {
  const blocks = [
    wrapTrustedContext([
      `Repository: ${params.owner}/${params.repo}`,
      `Pull request: #${params.prNumber}`,
      `Head commit SHA: ${params.headSha}`,
    ]),
    wrapUntrustedBlock("user_question", params.question),
  ];

  if (params.codeAnchor) {
    const { path, line, startLine, side, diffHunk } = params.codeAnchor;
    const range =
      startLine != null && startLine !== line ? `lines ${startLine}-${line}` : `line ${line}`;
    const anchorLines = [`File: ${path}`, `${range}${side ? ` (${side} side of diff)` : ""}`];
    if (diffHunk?.trim()) {
      anchorLines.push("", "Diff hunk:", "```diff", diffHunk.trim(), "```");
    }
    anchorLines.push(
      "",
      "Start from this anchor, then use tools to trace symbols and surrounding context.",
    );
    blocks.push(wrapUntrustedBlock("code_anchor", anchorLines.join("\n")));
  } else {
    blocks.push(
      "Use the local PR workspace tools to inspect changed files and related code, then answer the question in user_question.",
    );
  }

  return blocks.join("\n\n");
}
