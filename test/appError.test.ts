import { describe, expect, it } from "vitest";
import {
  AppError,
  errorLogFields,
  errorAnalyticsFields,
  isAppError,
  sanitizeErrorForTelemetry,
  serializeAppError,
  toAppError,
} from "../src/errors/appError.js";

const TOKEN = ["ghp", "1234567890123456789012345678901234"].join("_");

describe("AppError", () => {
  it("stores code, message, context, and cause", () => {
    const cause = new Error("root");
    const err = new AppError({
      domain: "review",
      kind: "publish_summary_failed",
      message: "publish budget exhausted",
      context: { workItemId: "w1" },
      cause,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe("AppError");
    expect(err.code).toBe("review.publish_summary_failed");
    expect(err.message).toBe("publish budget exhausted");
    expect(err.context).toEqual({ workItemId: "w1" });
    expect(err.cause).toBe(cause);
  });

  it("defaults context to an empty object", () => {
    const err = new AppError({ domain: "config", kind: "missing_env", message: "missing X" });
    expect(err.context).toEqual({});
  });

  it("isAppError narrows only AppError instances", () => {
    expect(isAppError(new AppError({ domain: "config", kind: "missing_env", message: "m" }))).toBe(
      true,
    );
    expect(isAppError(new Error("plain"))).toBe(false);
    expect(isAppError("nope")).toBe(false);
  });

  it("toAppError returns the same instance for AppError", () => {
    const err = new AppError({ domain: "config", kind: "invalid_enum", message: "m" });
    expect(toAppError(err, { domain: "github", kind: "missing_app_slug" })).toBe(err);
  });

  it("toAppError wraps plain Error with cause", () => {
    const plain = new Error("boom");
    const wrapped = toAppError(plain, {
      domain: "provider",
      kind: "request_failed",
      context: { step: 1 },
    });
    expect(wrapped.code).toBe("provider.request_failed");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.context).toEqual({ step: 1 });
    expect(wrapped.cause).toBe(plain);
  });

  it("toAppError keeps rawValue for non-Error primitives and objects", () => {
    const fromNumber = toAppError(404, { domain: "provider", kind: "request_failed" });
    expect(fromNumber.message).toBe("404");
    expect(fromNumber.context).toEqual({ rawValue: 404 });

    const fromObject = toAppError(
      { status: 404 },
      { domain: "provider", kind: "request_failed", context: { path: "/x" } },
    );
    expect(fromObject.message).toBe('{"status":404}');
    expect(fromObject.context).toEqual({ path: "/x", rawValue: { status: 404 } });
  });

  it("serializeAppError and errorLogFields expose log fields", () => {
    const cause = new TypeError("git push rejected");
    const err = new AppError({
      domain: "triage",
      kind: "stale_head_push",
      message: "head moved",
      context: { owner: "o", repo: "r" },
      cause,
    });
    expect(serializeAppError(err)).toEqual({
      errorCode: "triage.stale_head_push",
      errorMessage: "head moved",
      errorContext: { owner: "o", repo: "r" },
      errorCause: { errorMessage: "git push rejected", errorName: "TypeError" },
    });
    expect(errorLogFields(err).errorCode).toBe("triage.stale_head_push");
    expect(errorLogFields(new Error("plain"))).toEqual({});
  });

  it("recursively redacts serialized messages, contexts, raw values, and causes", () => {
    const circular: Record<string, unknown> = {
      safeId: "work-1",
      token: TOKEN,
    };
    circular.self = circular;
    const err = new AppError({
      domain: "review",
      kind: "specialist_failed",
      message: `provider failed Bearer ${TOKEN}`,
      context: {
        workItemId: "work-1",
        rawValue: {
          nested: [`DATABASE_URL=postgres://user:pass@db/app`, circular],
        },
      },
      cause: new Error(`OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz`, {
        cause: { provider: "test", bearer: `Bearer ${TOKEN}` },
      }),
    });

    const serialized = serializeAppError(err);
    const json = JSON.stringify(serialized);
    expect(serialized.errorCode).toBe("review.specialist_failed");
    expect(serialized.errorMessage).toContain("[redacted]");
    expect(serialized.errorContext).toMatchObject({ workItemId: "work-1" });
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain("postgres://");
    expect(json).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(json).toContain("[circular]");
  });

  it("sanitizes plain-object errors before forwarding them", () => {
    const thrown = {
      password: "opaque-password",
      apiKey: "opaque-provider-key",
      safeId: "work-1",
    };

    const safe = sanitizeErrorForTelemetry(thrown);

    expect(safe.message).toContain("[redacted]");
    expect(safe.message).not.toContain("opaque-password");
    expect(safe.message).not.toContain("opaque-provider-key");
    expect(safe).toMatchObject({
      rawValue: {
        password: "[redacted]",
        apiKey: "[redacted]",
        safeId: "work-1",
      },
    });
    expect(
      errorAnalyticsFields(new AppError({ domain: "config", kind: "missing_env", message: "m" })),
    ).toEqual(
      errorLogFields(new AppError({ domain: "config", kind: "missing_env", message: "m" })),
    );
  });
});
