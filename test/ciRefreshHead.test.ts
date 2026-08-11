import { describe, expect, it } from "vitest";
import {
  prNumbersForCiHead,
  toCiRefreshHeadSource,
} from "../src/webhook/payloads/ciRefreshHead.js";

describe("toCiRefreshHeadSource", () => {
  it("maps installation, repository, head SHA, and pull requests", () => {
    expect(
      toCiRefreshHeadSource({
        installation: { id: 9 },
        repository: { owner: { login: "acme" }, name: "pr-agent" },
        headSha: "sha-a",
        pullRequests: [{ number: 11, head: { sha: "sha-a" } }],
      }),
    ).toEqual({
      installationId: 9,
      owner: "acme",
      repo: "pr-agent",
      headSha: "sha-a",
      pullRequests: [{ number: 11, head: { sha: "sha-a" } }],
    });
  });

  it("defaults missing pull requests to an empty list", () => {
    expect(
      toCiRefreshHeadSource({
        installation: { id: 1 },
        repository: { owner: { login: "o" }, name: "r" },
        headSha: "sha",
      }),
    ).toEqual({
      installationId: 1,
      owner: "o",
      repo: "r",
      headSha: "sha",
      pullRequests: [],
    });
  });
});

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
