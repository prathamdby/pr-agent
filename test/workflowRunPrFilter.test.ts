import { describe, expect, it } from "vitest";
import { prNumbersForWorkflowRunHead } from "../src/webhook/payloads/workflowRunEvent.js";

describe("prNumbersForWorkflowRunHead", () => {
  it("keeps only PRs whose head SHA matches the workflow run head", () => {
    expect(
      prNumbersForWorkflowRunHead("sha-a", [
        { number: 11, head: { sha: "sha-a" } },
        { number: 12, head: { sha: "sha-b" } },
        { number: 13, head: { sha: "sha-a" } },
      ]),
    ).toEqual([11, 13]);
  });

  it("dedupes repeated PR numbers", () => {
    expect(
      prNumbersForWorkflowRunHead("sha-a", [
        { number: 7, head: { sha: "sha-a" } },
        { number: 7, head: { sha: "sha-a" } },
      ]),
    ).toEqual([7]);
  });

  it("returns an empty list when no PR heads match", () => {
    expect(prNumbersForWorkflowRunHead("sha-a", [{ number: 1, head: { sha: "other" } }])).toEqual(
      [],
    );
  });
});
