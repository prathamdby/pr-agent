import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors/appError.js";
import {
  classifyFailure,
  classifiedFailureLogFields,
  classifiedFailurePostHogProperties,
} from "../src/errors/classifiedFailure.js";

describe("classifyFailure", () => {
  it("classifies provider credit errors as provider/quota with sanitized message", () => {
    const f = classifyFailure(new Error("Insufficient credits"));
    expect(f.failureDomain).toBe("provider");
    expect(f.errorKind).toBe("quota");
    expect(f.errorMessage.toLowerCase()).toContain("credit");
  });

  it("classifies GitHub GraphQL integration errors as github/forbidden", () => {
    const f = classifyFailure(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    );
    expect(f.failureDomain).toBe("github");
    expect(f.errorKind).toBe("forbidden");
  });

  it("does not label superseded as provider", () => {
    const f = classifyFailure(new Error("whatever"), { lifecycle: "superseded" });
    expect(f.failureDomain).toBe("internal");
    expect(f.errorKind).toBe("superseded");
  });

  it("maps stale_head lifecycle to internal/cancelled", () => {
    const f = classifyFailure(new Error("head moved"), { lifecycle: "stale_head" });
    expect(f.failureDomain).toBe("internal");
    expect(f.errorKind).toBe("cancelled");
  });

  it("prefers GitHub-shaped cause over provider phase hint", () => {
    const f = classifyFailure(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
      { phase: "synthesis" },
    );
    expect(f.failureDomain).toBe("github");
    expect(f.errorKind).toBe("forbidden");
  });

  it("includes AppError code when present", () => {
    const f = classifyFailure(
      new AppError({
        code: "review.orchestrator_send_failed",
        message: "Insufficient credits for model",
      }),
    );
    expect(f.errorCode).toBe("review.orchestrator_send_failed");
    expect(f.errorKind).toBe("quota");
  });

  it("maps log fields camelCase and PostHog snake_case", () => {
    const f = classifyFailure(new Error("Insufficient credits"), {
      phase: "synthesis",
      toolName: "publish_summary",
      provider: "pi",
      model: "m",
    });
    expect(classifiedFailureLogFields(f)).toMatchObject({
      failureDomain: "provider",
      errorKind: "quota",
      phase: "synthesis",
      toolName: "publish_summary",
    });
    expect(classifiedFailurePostHogProperties(f)).toMatchObject({
      failure_domain: "provider",
      error_kind: "quota",
      error_message: expect.stringMatching(/credit/i),
      phase: "synthesis",
      tool_name: "publish_summary",
      provider: "pi",
      model: "m",
    });
  });
});
