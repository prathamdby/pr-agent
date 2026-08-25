import { describe, expect, it } from "vitest";
import {
  sanitizeTelemetryRecord,
  sanitizeTelemetryString,
  sanitizeTelemetryValue,
} from "../src/security/sanitizeTelemetryValue.js";

const TOKEN = ["ghp", "1234567890123456789012345678901234"].join("_");

describe("sanitizeTelemetryValue", () => {
  it("redacts secret-shaped strings and sensitive keys without mutating inputs", () => {
    const input: Record<string, unknown> = {
      password: "opaque-password",
      api_key: "opaque-api-key",
      privateKey: "opaque-private-key",
      safeId: "work-1",
      nested: [`Bearer ${TOKEN}`],
    };
    const nested = input.nested;

    const sanitized = sanitizeTelemetryValue(input) as Record<string, unknown>;
    const record = sanitizeTelemetryRecord(input);

    const databaseUrl = ["DATABASE_URL=postgres:", "//user:pass@db/app"].join("");
    expect(sanitizeTelemetryString(databaseUrl)).toContain("[redacted]");
    expect(sanitized).toMatchObject({
      password: "[redacted]",
      api_key: "[redacted]",
      privateKey: "[redacted]",
      safeId: "work-1",
      nested: ["[redacted]"],
    });
    expect(record).toEqual(sanitized);
    expect(input.password).toBe("opaque-password");
    expect(input.api_key).toBe("opaque-api-key");
    expect(input.privateKey).toBe("opaque-private-key");
    expect(input.safeId).toBe("work-1");
    expect(input.nested).toBe(nested);
    expect((input.nested as string[])[0]).toBe(`Bearer ${TOKEN}`);
    expect(sanitizeTelemetryRecord(undefined)).toBeUndefined();
  });

  it("handles circular objects, arrays, and depth overflow", () => {
    const circular: Record<string, unknown> = { safeId: "work-1" };
    circular.self = circular;
    const sanitized = sanitizeTelemetryValue({ values: [circular, "safe"] }) as Record<
      string,
      unknown
    >;
    const sanitizedCircular = (sanitized.values as Array<Record<string, unknown>>)[0];
    expect(sanitizedCircular.self).toBe("[circular]");
    expect(sanitizedCircular.safeId).toBe("work-1");

    let current: Record<string, unknown> = {};
    const deep = current;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {};
      current.child = next;
      current = next;
    }
    expect(JSON.stringify(sanitizeTelemetryValue(deep))).toContain("[unsupported]");
  });

  it("converts special values to safe JSON-compatible values", () => {
    const input = {
      date: new Date("2026-08-25T00:00:00.000Z"),
      invalidDate: new Date(Number.NaN),
      url: new URL(["postgres:", "//user:pass@db/app"].join("")),
      regexp: new RegExp(`Bearer ${TOKEN}`),
      map: new Map([["password", "opaque"]]),
      set: new Set(["opaque"]),
      toJSON: { toJSON: () => ({ password: "opaque" }) },
      functionValue: () => "opaque",
      nan: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
      bigint: 42n,
      symbol: Symbol(`Bearer ${TOKEN}`),
    };

    const sanitized = sanitizeTelemetryValue(input) as Record<string, unknown>;

    expect(sanitized.date).toBe("2026-08-25T00:00:00.000Z");
    expect(sanitized.invalidDate).toBe("[invalid date]");
    expect(sanitized.url).toContain("[redacted]");
    expect(sanitized.regexp).toContain("[redacted]");
    expect(sanitized.map).toBe("[unsupported]");
    expect(sanitized.set).toBe("[unsupported]");
    expect(sanitized.toJSON).toBe("[unsupported]");
    expect(sanitized.functionValue).toBe("[unsupported]");
    expect(sanitized.nan).toBe("NaN");
    expect(sanitized.infinity).toBe("Infinity");
    expect(sanitized.bigint).toBe("42");
    expect(sanitized.symbol).toContain("[redacted]");
    expect(JSON.stringify(sanitized)).not.toContain(TOKEN);
  });

  it("redacts compound sensitive key aliases", () => {
    const sanitized = sanitizeTelemetryRecord({
      userPassword: "opaque",
      auth_token: "opaque",
      openai_api_key: "opaque",
      "x-api-key": "opaque",
      workItemId: "work-1",
    });
    expect(sanitized).toEqual({
      userPassword: "[redacted]",
      auth_token: "[redacted]",
      openai_api_key: "[redacted]",
      "x-api-key": "[redacted]",
      workItemId: "work-1",
    });
  });
});
