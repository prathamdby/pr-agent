import { describe, expect, it } from "vitest";
import { classifyGithubError } from "../src/github/githubErrors.js";

describe("classifyGithubError", () => {
  it("classifies Resource not accessible by integration as forbidden", () => {
    expect(
      classifyGithubError(
        Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
      ),
    ).toBe("forbidden");
  });

  it("classifies 401 as auth", () => {
    expect(classifyGithubError(Object.assign(new Error("Bad credentials"), { status: 401 }))).toBe(
      "auth",
    );
  });

  it("classifies 404 as not_found", () => {
    expect(classifyGithubError(Object.assign(new Error("Not Found"), { status: 404 }))).toBe(
      "not_found",
    );
  });

  it("classifies 422 validation as validation", () => {
    expect(
      classifyGithubError(Object.assign(new Error("Validation Failed"), { status: 422 })),
    ).toBe("validation");
  });

  it("classifies GitHub rate limit as rate_limit", () => {
    expect(
      classifyGithubError(Object.assign(new Error("API rate limit exceeded"), { status: 403 })),
    ).toBe("rate_limit");
  });

  it("returns unknown for unclassified errors", () => {
    expect(classifyGithubError(new Error("something else"))).toBe("unknown");
  });
});
