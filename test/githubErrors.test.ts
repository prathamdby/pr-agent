import { describe, expect, it } from "vitest";
import {
  classifyGithubError,
  githubRequestPath,
  isDuplicateCheckRunCreationError,
} from "../src/github/githubErrors.js";

describe("isDuplicateCheckRunCreationError", () => {
  it("accepts a structured CheckRun already-exists validation", () => {
    expect(
      isDuplicateCheckRunCreationError({
        status: 422,
        response: {
          data: {
            errors: [{ resource: "CheckRun", code: "already_exists" }],
          },
        },
      }),
    ).toBe(true);
  });

  it("accepts a CheckRun custom duplicate message", () => {
    expect(
      isDuplicateCheckRunCreationError({
        status: 422,
        response: {
          data: {
            errors: [{ resource: "CheckRun", code: "custom", message: "already exists" }],
          },
        },
      }),
    ).toBe(true);
  });

  it("accepts alternate duplicate shapes and rejects unrelated messages", () => {
    expect(
      isDuplicateCheckRunCreationError({
        status: 422,
        errors: [{ resource: "CheckRun", code: "duplicate" }],
      }),
    ).toBe(true);
    expect(
      isDuplicateCheckRunCreationError({
        status: 422,
        data: {
          errors: [{ resource: "CheckRun", code: "custom", message: "DUPLICATE" }],
        },
      }),
    ).toBe(true);
    expect(
      isDuplicateCheckRunCreationError({
        status: 422,
        response: {
          data: {
            errors: [{ resource: "PullRequest", code: "already_exists" }],
          },
        },
      }),
    ).toBe(false);
    expect(
      isDuplicateCheckRunCreationError({
        status: 422,
        response: {
          data: {
            errors: [{ resource: "CheckRun", code: "custom", message: "duplicated" }],
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects bare and unrelated validation failures", () => {
    expect(isDuplicateCheckRunCreationError({ status: 422, message: "already exists" })).toBe(
      false,
    );
    expect(
      isDuplicateCheckRunCreationError({
        status: 422,
        response: {
          data: {
            errors: [{ resource: "CheckRun", code: "invalid", field: "head_sha" }],
          },
        },
      }),
    ).toBe(false);
  });
});

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

describe("githubRequestPath", () => {
  it("takes the pathname from a structured request URL and drops the query", () => {
    expect(
      githubRequestPath({
        status: 403,
        request: {
          url: "https://api.github.com/repos/acme/widgets/check-runs?access_token=secret",
        },
      }),
    ).toBe("/repos/acme/widgets/check-runs");
  });

  it("accepts a relative request.path and ignores free-text blobs", () => {
    expect(githubRequestPath({ request: { path: "/repos/acme/widgets/contents/.env" } })).toBe(
      "/repos/acme/widgets/contents/.env",
    );
    expect(githubRequestPath({ message: "GET /repos/acme/widgets failed" })).toBeUndefined();
    expect(githubRequestPath({ request: { url: "not a url" } })).toBeUndefined();
  });
});
