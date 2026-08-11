import { describe, expect, it } from "vitest";
import { prNumbersForCiHead } from "../src/webhook/payloads/ciRefreshHead.js";

describe("prNumbersForCiHead", () => {
  it("keeps only PRs whose head SHA matches the CI head", () => {
    expect(
      prNumbersForCiHead("sha-a", [
        { number: 11, head: { sha: "sha-a" } },
        { number: 12, head: { sha: "sha-b" } },
        { number: 13, head: { sha: "sha-a" } },
      ]),
    ).toEqual([11, 13]);
  });

  it("dedupes repeated PR numbers", () => {
    expect(
      prNumbersForCiHead("sha-a", [
        { number: 7, head: { sha: "sha-a" } },
        { number: 7, head: { sha: "sha-a" } },
      ]),
    ).toEqual([7]);
  });

  it("returns an empty list when no PR heads match", () => {
    expect(prNumbersForCiHead("sha-a", [{ number: 1, head: { sha: "other" } }])).toEqual([]);
  });
});
