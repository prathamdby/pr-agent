import { describe, expect, it } from "vitest";
import {
  AppError,
  errorLogFields,
  isAppError,
  serializeAppError,
  toAppError,
} from "../src/errors/appError.js";

describe("AppError", () => {
  it("stores code, message, context, and cause", () => {
    const cause = new Error("root");
    const err = new AppError({
      code: "review.publish_exhausted",
      message: "publish budget exhausted",
      context: { workItemId: "w1" },
      cause,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe("AppError");
    expect(err.code).toBe("review.publish_exhausted");
    expect(err.message).toBe("publish budget exhausted");
    expect(err.context).toEqual({ workItemId: "w1" });
    expect(err.cause).toBe(cause);
  });

  it("defaults context to an empty object", () => {
    const err = new AppError({ code: "config.missing_env", message: "missing X" });
    expect(err.context).toEqual({});
  });

  it("isAppError narrows only AppError instances", () => {
    expect(isAppError(new AppError({ code: "x.y", message: "m" }))).toBe(true);
    expect(isAppError(new Error("plain"))).toBe(false);
    expect(isAppError("nope")).toBe(false);
  });

  it("toAppError returns the same instance for AppError", () => {
    const err = new AppError({ code: "a.b", message: "m" });
    expect(toAppError(err, { code: "other.x" })).toBe(err);
  });

  it("toAppError wraps plain Error with cause", () => {
    const plain = new Error("boom");
    const wrapped = toAppError(plain, { code: "agent.unknown", context: { step: 1 } });
    expect(wrapped.code).toBe("agent.unknown");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.context).toEqual({ step: 1 });
    expect(wrapped.cause).toBe(plain);
  });

  it("toAppError keeps rawValue for non-Error primitives and objects", () => {
    const fromNumber = toAppError(404, { code: "http.status" });
    expect(fromNumber.message).toBe("404");
    expect(fromNumber.context).toEqual({ rawValue: 404 });

    const fromObject = toAppError(
      { status: 404 },
      { code: "http.status", context: { path: "/x" } },
    );
    expect(fromObject.message).toBe('{"status":404}');
    expect(fromObject.context).toEqual({ path: "/x", rawValue: { status: 404 } });
  });

  it("serializeAppError and errorLogFields expose log fields", () => {
    const cause = new TypeError("git push rejected");
    const err = new AppError({
      code: "triage.stale_head",
      message: "head moved",
      context: { owner: "o", repo: "r" },
      cause,
    });
    expect(serializeAppError(err)).toEqual({
      errorCode: "triage.stale_head",
      errorMessage: "head moved",
      errorContext: { owner: "o", repo: "r" },
      errorCause: { errorMessage: "git push rejected", errorName: "TypeError" },
    });
    expect(errorLogFields(err).errorCode).toBe("triage.stale_head");
    expect(errorLogFields(new Error("plain"))).toEqual({});
  });
});
