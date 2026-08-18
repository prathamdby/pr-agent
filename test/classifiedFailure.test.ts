import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors/appError.js";
import {
  classifyFailure,
  classifiedFailureLogFields,
  classifiedFailurePostHogProperties,
  type ClassifiedFailure,
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

describe("classified-failure projections", () => {
  const requiredOnly = classifyFailure(new Error("plain boom"));

  const everyOptional = classifyFailure(
    new AppError({
      code: "review.orchestrator_send_failed",
      message: "Insufficient credits for model",
      cause: new Error("wallet empty", { cause: new Error("ledger miss") }),
    }),
    {
      phase: "synthesis",
      toolName: "publish_summary",
      provider: "pi",
      model: "m",
      errorCount: 3,
    },
  );

  it("projects only required keys when optionals are absent", () => {
    expect(classifiedFailureLogFields(requiredOnly)).toEqual({
      failureDomain: "unknown",
      errorKind: "unknown",
      errorMessage: "plain boom",
    });
    expect(classifiedFailurePostHogProperties(requiredOnly)).toEqual({
      failure_domain: "unknown",
      error_kind: "unknown",
      error_message: "plain boom",
    });
  });

  it("projects every optional field under log and PostHog key conventions", () => {
    expect(classifiedFailureLogFields(everyOptional)).toEqual({
      failureDomain: "provider",
      errorKind: "quota",
      errorMessage: "Insufficient credits for model",
      errorCode: "review.orchestrator_send_failed",
      phase: "synthesis",
      toolName: "publish_summary",
      provider: "pi",
      model: "m",
      causeChain: ["wallet empty", "ledger miss"],
      errorCount: 3,
    });
    expect(classifiedFailurePostHogProperties(everyOptional)).toEqual({
      failure_domain: "provider",
      error_kind: "quota",
      error_message: "Insufficient credits for model",
      error_code: "review.orchestrator_send_failed",
      phase: "synthesis",
      tool_name: "publish_summary",
      provider: "pi",
      model: "m",
      cause_chain: ["wallet empty", "ledger miss"],
      error_count: 3,
    });
  });

  it("projects equivalent facts under log and PostHog key conventions", () => {
    const log = classifiedFailureLogFields(everyOptional);
    const posthog = classifiedFailurePostHogProperties(everyOptional);
    expect(Object.keys(log)).toHaveLength(Object.keys(posthog).length);
    expect(log.failureDomain).toBe(posthog.failure_domain);
    expect(log.errorKind).toBe(posthog.error_kind);
    expect(log.errorMessage).toBe(posthog.error_message);
    expect(log.errorCode).toBe(posthog.error_code);
    expect(log.phase).toBe(posthog.phase);
    expect(log.toolName).toBe(posthog.tool_name);
    expect(log.provider).toBe(posthog.provider);
    expect(log.model).toBe(posthog.model);
    expect(log.causeChain).toEqual(posthog.cause_chain);
    expect(log.errorCount).toBe(posthog.error_count);
  });

  it("projects lifecycle-hint classifications without inventing optional keys", () => {
    const superseded = classifyFailure(new Error("whatever"), { lifecycle: "superseded" });
    const cancelled = classifyFailure(new Error("head moved"), { lifecycle: "stale_head" });

    expect(classifiedFailureLogFields(superseded)).toEqual({
      failureDomain: "internal",
      errorKind: "superseded",
      errorMessage: "whatever",
    });
    expect(classifiedFailurePostHogProperties(superseded)).toEqual({
      failure_domain: "internal",
      error_kind: "superseded",
      error_message: "whatever",
    });
    expect(classifiedFailureLogFields(cancelled)).toEqual({
      failureDomain: "internal",
      errorKind: "cancelled",
      errorMessage: "head moved",
    });
    expect(classifiedFailurePostHogProperties(cancelled)).toEqual({
      failure_domain: "internal",
      error_kind: "cancelled",
      error_message: "head moved",
    });
  });

  it("includes errorCount 0 and omits undefined or null-like optionals", () => {
    const zeroCount = classifyFailure(new Error("plain boom"), { errorCount: 0 });
    expect(classifiedFailureLogFields(zeroCount)).toEqual({
      failureDomain: "unknown",
      errorKind: "unknown",
      errorMessage: "plain boom",
      errorCount: 0,
    });
    expect(classifiedFailurePostHogProperties(zeroCount)).toEqual({
      failure_domain: "unknown",
      error_kind: "unknown",
      error_message: "plain boom",
      error_count: 0,
    });

    const nullish: ClassifiedFailure = {
      failureDomain: "unknown",
      errorKind: "unknown",
      errorMessage: "plain boom",
      errorCode: undefined,
      phase: "",
      toolName: undefined,
      provider: null as unknown as string | undefined,
      model: undefined,
      causeChain: undefined,
      errorCount: undefined,
    };
    expect(classifiedFailureLogFields(nullish)).toEqual({
      failureDomain: "unknown",
      errorKind: "unknown",
      errorMessage: "plain boom",
      phase: "",
    });
    expect(classifiedFailurePostHogProperties(nullish)).toEqual({
      failure_domain: "unknown",
      error_kind: "unknown",
      error_message: "plain boom",
      phase: "",
    });
  });
});
