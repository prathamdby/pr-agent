import { describe, expect, it } from "vitest";
import {
  escalatedToolRounds,
  escalatedVerificationInventory,
  escalationForAttempt,
  retryDispositionFor,
} from "../src/agentWork/retryPolicy.js";
import { AppError } from "../src/errors/appError.js";
import {
  APP_ERROR_KINDS,
  type AppErrorDomain,
  type AppErrorShape,
} from "../src/errors/appErrorCodes.js";
import {
  classifyFailure,
  classifiedFailureLogFields,
  classifiedFailurePostHogProperties,
  type ClassifiedFailure,
} from "../src/errors/classifiedFailure.js";
import { makeTestConfig } from "./helpers/config.js";

describe("classifyFailure", () => {
  it("classifies provider credit errors as provider/quota with sanitized message", () => {
    const f = classifyFailure(new Error("Insufficient credits"));
    expect(f.failureDomain).toBe("provider");
    expect(f.errorKind).toBe("quota");
    expect(f.errorMessage.toLowerCase()).toContain("credit");
  });

  it("classifies GitHub GraphQL integration errors as github/forbidden", () => {
    const f = classifyFailure(
      Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
        request: { url: "https://api.github.com/repos/acme/widgets/check-runs" },
      }),
    );
    expect(f.failureDomain).toBe("github");
    expect(f.errorKind).toBe("forbidden");
    expect(f.httpStatus).toBe(403);
    expect(f.requestPath).toBe("/repos/acme/widgets/check-runs");
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
        domain: "review",
        kind: "orchestrator_send_failed",
        message: "Insufficient credits for model",
        cause: new Error("Insufficient credits for model"),
      }),
    );
    expect(f.errorCode).toBe("review.orchestrator_send_failed");
    expect(f.errorKind).toBe("quota");
  });

  it("keeps outcome-unknown publish failures internal despite forbidden wording and causes", () => {
    const error = new AppError({
      domain: "operation_intent",
      kind: "mutation_outcome_unknown",
      message: "Mutation outcome unknown; automatic retry is forbidden",
      cause: new AppError({
        domain: "provider",
        kind: "request_failed",
        message: "401 Unauthorized",
      }),
    });
    expect(classifyFailure(error)).toMatchObject({
      failureDomain: "internal",
      errorKind: "publish",
      errorCode: "operation_intent.mutation_outcome_unknown",
    });
    expect(
      classifyFailure(
        new AppError({
          domain: "review",
          kind: "publish_thread_failed",
          message: "Thread publication failed",
          cause: error,
        }),
      ),
    ).toMatchObject({ failureDomain: "internal", errorKind: "publish" });
  });

  it("preserves typed provider causes through transparent review wrappers", () => {
    const provider = new AppError({
      domain: "provider",
      kind: "request_failed",
      message: "Insufficient credits; GitHub API investigation failed",
    });
    for (const kind of ["specialist_failed", "orchestrator_send_failed"] as const) {
      expect(
        classifyFailure(
          new AppError({
            domain: "review",
            kind,
            message: "403 forbidden wrapper",
            cause: provider,
          }),
        ),
      ).toMatchObject({ failureDomain: "provider", errorKind: "quota" });
    }
  });

  it("preserves typed GitHub causes and unknown external kinds", () => {
    for (const message of ["Resource not accessible by integration", "Unexpected response"]) {
      expect(
        classifyFailure(
          new AppError({
            domain: "review",
            kind: "specialist_failed",
            message: "Insufficient credits",
            cause: new AppError({
              domain: "github",
              kind: "review_check_lookup_incomplete",
              message,
            }),
          }),
        ),
      ).toMatchObject({
        failureDomain: "github",
        errorKind: message === "Unexpected response" ? "unknown" : "forbidden",
      });
    }
    expect(
      classifyFailure(
        new AppError({
          domain: "provider",
          kind: "protocol_invalid",
          message: "Unexpected response",
        }),
      ),
    ).toMatchObject({ failureDomain: "provider", errorKind: "unknown" });
  });

  it("does not infer GitHub identity from a provider HTTP status", () => {
    expect(
      classifyFailure(
        Object.assign(new Error("401 Unauthorized"), {
          status: 401,
          request: { url: "https://api.anthropic.com/v1/messages" },
        }),
      ),
    ).toMatchObject({ failureDomain: "provider", errorKind: "auth" });
    expect(classifyFailure({ status: 500, message: "Unexpected response" })).toMatchObject({
      failureDomain: "unknown",
      errorKind: "unknown",
    });
  });

  it("keeps lifecycle and explicit domain hints authoritative", () => {
    const error = new AppError({
      domain: "provider",
      kind: "request_failed",
      message: "401 Unauthorized",
    });
    expect(classifyFailure(error, { lifecycle: "cancelled", domain: "github" })).toMatchObject({
      failureDomain: "internal",
      errorKind: "cancelled",
    });
    expect(classifyFailure(error, { domain: "internal" })).toMatchObject({
      failureDomain: "internal",
      errorKind: "unknown",
    });
    expect(classifyFailure(new Error("401 Unauthorized"), { domain: "github" })).toMatchObject({
      failureDomain: "github",
      errorKind: "auth",
    });
  });

  it("bounds classification of cyclic and deeply wrapped causes", () => {
    const cycle = new Error("boom");
    cycle.cause = cycle;
    expect(classifyFailure(cycle)).toMatchObject({
      failureDomain: "unknown",
      errorKind: "unknown",
    });
    let error: Error = new AppError({
      domain: "provider",
      kind: "request_failed",
      message: "Insufficient credits",
    });
    for (let depth = 0; depth < 6; depth += 1) error = new Error("wrapper", { cause: error });
    expect(classifyFailure(error)).toMatchObject({
      failureDomain: "unknown",
      errorKind: "unknown",
    });
  });

  it("classifies every closed code with deliberate domain and internal-kind mappings", () => {
    const abortCodes = new Set(["agent.session_aborted", "review.specialist_aborted"]);
    const legacyKind = (code: string) =>
      code.startsWith("review.") && /validation/.test(code)
        ? "validation"
        : code.startsWith("review.") && /publish/.test(code)
          ? "publish"
          : "unknown";
    for (const domain of Object.keys(APP_ERROR_KINDS) as AppErrorDomain[]) {
      for (const kind of APP_ERROR_KINDS[domain]) {
        const error = new AppError({ domain, kind, message: "boom" } as AppErrorShape & {
          message: string;
        });
        const classified = classifyFailure(error);
        const expected = abortCodes.has(error.code)
          ? { failureDomain: "internal", errorKind: "cancelled" }
          : error.code === "review.specialist_timeout"
            ? { failureDomain: "internal", errorKind: "timeout" }
            : domain === "provider" || domain === "github"
              ? {
                  failureDomain: domain,
                  errorKind:
                    error.code === "github.review_thread_resolution_denied"
                      ? "forbidden"
                      : "unknown",
                }
              : {
                  failureDomain: "internal",
                  errorKind:
                    error.code === "operation_intent.mutation_outcome_unknown"
                      ? "publish"
                      : legacyKind(error.code),
                };
        expect([error.code, classified.failureDomain, classified.errorKind]).toEqual([
          error.code,
          expected.failureDomain,
          expected.errorKind,
        ]);
        expect(classified.errorCode).toBe(`${domain}.${kind}`);
      }
    }
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
      error_message: "Insufficient credits",
      phase: "synthesis",
      tool_name: "publish_summary",
      provider: "pi",
      model: "m",
    });
    expect(classifiedFailurePostHogProperties(f)).not.toHaveProperty("http_status");
    expect(classifiedFailurePostHogProperties(f)).not.toHaveProperty("request_path");
    expect(classifiedFailurePostHogProperties(f)).not.toHaveProperty("cause_chain");
  });

  it("omits unsafe phase text from PostHog while keeping it on logs", () => {
    const f = classifyFailure(new Error("boom"), { phase: "/tmp/secret.ts" });
    expect(classifiedFailureLogFields(f).phase).toBe("/tmp/secret.ts");
    expect(classifiedFailurePostHogProperties(f)).not.toHaveProperty("phase");
  });
});

describe("classified-failure projections", () => {
  const requiredOnly = classifyFailure(new Error("plain boom"));

  const everyOptional = classifyFailure(
    new AppError({
      domain: "review",
      kind: "orchestrator_send_failed",
      message: "Insufficient credits for model",
      cause: new Error("Insufficient credits", { cause: new Error("ledger miss") }),
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
      causeChain: ["Insufficient credits", "ledger miss"],
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
      error_count: 3,
    });
  });

  it("projects equivalent facts under log and PostHog key conventions", () => {
    const log = classifiedFailureLogFields(everyOptional);
    const posthog = classifiedFailurePostHogProperties(everyOptional);
    expect(posthog.error_message).toBe(log.errorMessage);
    expect(posthog).not.toHaveProperty("cause_chain");
    expect(posthog).not.toHaveProperty("http_status");
    expect(posthog).not.toHaveProperty("request_path");
    expect(log.failureDomain).toBe(posthog.failure_domain);
    expect(log.errorKind).toBe(posthog.error_kind);
    expect(log.errorCode).toBe(posthog.error_code);
    expect(log.phase).toBe(posthog.phase);
    expect(log.toolName).toBe(posthog.tool_name);
    expect(log.provider).toBe(posthog.provider);
    expect(log.model).toBe(posthog.model);
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
    });
  });

  it("projects GitHub 403 status, path, and sanitized message on PostHog", () => {
    const token = ["ghp", "1234567890123456789012345678901234"].join("_");
    const f = classifyFailure(
      Object.assign(new Error(`Resource not accessible by integration Bearer ${token}`), {
        status: 403,
        request: {
          url: "https://api.github.com/repos/acme/widgets/check-runs?access_token=secret",
        },
      }),
    );
    expect(classifiedFailureLogFields(f)).toMatchObject({
      failureDomain: "github",
      errorKind: "forbidden",
      httpStatus: 403,
      requestPath: "/repos/acme/widgets/check-runs",
    });
    expect(classifiedFailurePostHogProperties(f)).toEqual({
      failure_domain: "github",
      error_kind: "forbidden",
      error_message: expect.stringContaining("Resource not accessible by integration"),
      http_status: 403,
      request_path: "/repos/acme/widgets/check-runs",
    });
    const json = JSON.stringify(classifiedFailurePostHogProperties(f));
    expect(json).not.toContain(token);
    expect(json).not.toContain("access_token");
    expect(classifiedFailurePostHogProperties(f)).not.toHaveProperty("cause_chain");
  });

  it("extracts GitHub status and path from a wrapped cause", () => {
    const f = classifyFailure(
      new Error("verification failed", {
        cause: Object.assign(new Error("Resource not accessible by integration"), {
          status: 403,
          request: { url: "https://api.github.com/repos/acme/widgets/check-runs" },
        }),
      }),
    );
    expect(f.failureDomain).toBe("github");
    expect(f.errorKind).toBe("forbidden");
    expect(f.httpStatus).toBe(403);
    expect(f.requestPath).toBe("/repos/acme/widgets/check-runs");
    expect(classifiedFailurePostHogProperties(f)).toMatchObject({
      failure_domain: "github",
      error_kind: "forbidden",
      http_status: 403,
      request_path: "/repos/acme/widgets/check-runs",
    });
  });

  it("omits request_path when a GitHub error has status but no request URL", () => {
    const f = classifyFailure(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    );
    expect(f.httpStatus).toBe(403);
    expect(f.requestPath).toBeUndefined();
    expect(classifiedFailurePostHogProperties(f)).toEqual({
      failure_domain: "github",
      error_kind: "forbidden",
      error_message: "Resource not accessible by integration",
      http_status: 403,
    });
  });
});

describe("retryDispositionFor", () => {
  it("keeps stale-head replacement exhaustion terminal", () => {
    const error = new AppError({
      domain: "review",
      kind: "stale_head_replacement_exhausted",
      message: "Stale-head replacement went stale again. Run /review to retry on the latest head.",
    });
    expect(retryDispositionFor(error)).toBe("terminal");
  });

  it.each([
    [
      { domain: "verification", kind: "missing_submit" },
      "Verification run ended without submitVerification",
    ],
    [{ domain: "triage", kind: "missing_submit" }, "Triage run ended without submitTriage"],
    [
      { domain: "review", kind: "specialist_invalid_report" },
      "Specialist did not submit a valid report",
    ],
  ] as const)("classifies repair-exhausted %j as deterministic", (shape, message) => {
    expect(retryDispositionFor(new AppError({ ...shape, message }))).toBe("deterministic");
  });

  it.each([
    ["provider timeout", new Error("Request timed out")],
    ["provider rate limit", new Error("429 Too Many Requests")],
    ["provider 5xx", new Error("503 Service Unavailable")],
    ["provider transport reset", new Error("fetch failed: ECONNRESET")],
    ["provider quota", new Error("Insufficient credits")],
    [
      "github forbidden",
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    ],
    ["github rate limit", Object.assign(new Error("API rate limit exceeded"), { status: 429 })],
    ["unknown error", new Error("plain boom")],
    ["non-error value", "plain boom"],
  ])("keeps %s transient", (_label, error) => {
    expect(retryDispositionFor(error)).toBe("transient");
  });

  it.each([
    { domain: "agent", kind: "session_aborted" },
    { domain: "review", kind: "specialist_aborted" },
  ] as const)("classifies %j as terminal", (shape) => {
    expect(retryDispositionFor(new AppError({ ...shape, message: "aborted" }))).toBe("terminal");
  });

  it("does not terminalise an unrelated AppError code", () => {
    expect(
      retryDispositionFor(
        new AppError({
          domain: "review",
          kind: "orchestrator_send_failed",
          message: "send failed",
        }),
      ),
    ).toBe("transient");
  });
});

describe("escalationForAttempt", () => {
  const fallbackCfg = makeTestConfig({
    models: {
      provider: "openai",
      model: "gpt-4o-mini",
      fallbackProvider: "anthropic",
      fallbackModel: "claude-sonnet-4",
    },
  });

  it("leaves the first attempt unchanged", () => {
    expect(escalationForAttempt(0, fallbackCfg)).toBeUndefined();
    expect(escalationForAttempt(1, fallbackCfg)).toBeUndefined();
  });

  it("escalates with the configured fallback model from attempt 2", () => {
    expect(escalationForAttempt(2, fallbackCfg)).toEqual({
      attempt: 2,
      kinds: ["tool_rounds", "fallback_model"],
      model: { provider: "anthropic", model: "claude-sonnet-4" },
    });
  });

  it("escalates tool rounds only when no fallback model is configured", () => {
    const plan = escalationForAttempt(2, makeTestConfig());
    expect(plan).toEqual({ attempt: 2, kinds: ["tool_rounds"] });
    expect(plan?.model).toBeUndefined();
  });

  it("is a pure function of the attempt count and config", () => {
    expect(escalationForAttempt(3, fallbackCfg)).toEqual(escalationForAttempt(3, fallbackCfg));
    expect(escalationForAttempt(3, fallbackCfg)?.attempt).toBe(3);

    const twinCfg = makeTestConfig({
      models: {
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackProvider: "anthropic",
        fallbackModel: "claude-sonnet-4",
      },
    });
    expect(escalationForAttempt(3, fallbackCfg)).toEqual(escalationForAttempt(3, twinCfg));
    expect(escalationForAttempt(2, makeTestConfig())).toEqual(
      escalationForAttempt(2, makeTestConfig()),
    );
  });
});

describe("escalatedToolRounds", () => {
  const plan = escalationForAttempt(2, makeTestConfig());

  it("returns the base budget without an escalation plan", () => {
    expect(escalatedToolRounds(24, undefined)).toBe(24);
    expect(escalatedToolRounds(0, undefined)).toBe(0);
  });

  it("doubles the base budget for an escalated attempt", () => {
    expect(escalatedToolRounds(24, plan)).toBe(48);
    expect(escalatedToolRounds(32, plan)).toBe(64);
  });

  it("caps the raised budget", () => {
    expect(escalatedToolRounds(50, plan)).toBe(64);
  });
});

describe("escalatedVerificationInventory", () => {
  const inventory = Array.from({ length: 14 }, (_, index) => `thread-${index}`);
  const plan = escalationForAttempt(2, makeTestConfig());

  it("returns the full inventory without an escalation plan", () => {
    expect(escalatedVerificationInventory(inventory, undefined)).toBe(inventory);
  });

  it("narrows an escalated attempt to the oldest bounded slice", () => {
    expect(escalatedVerificationInventory(inventory, plan)).toEqual(inventory.slice(0, 10));
  });

  it("returns a short inventory unchanged for an escalated attempt", () => {
    const short = ["thread-0", "thread-1"];
    expect(escalatedVerificationInventory(short, plan)).toEqual(short);
  });
});
