import { describe, expect, it } from "vitest";
import type { EventMessage } from "posthog-node";
import { sanitizePostHogEvent } from "../src/security/sanitizePostHogEvent.js";

const TOKEN = "ghp_1234567890123456789012345678901234";

describe("sanitizePostHogEvent", () => {
  it("returns null unchanged", () => {
    expect(sanitizePostHogEvent(null)).toBeNull();
  });

  it("leaves benign events without error fields unchanged by identity", () => {
    const event: EventMessage = {
      distinctId: "installation:1",
      event: "triage degraded",
      properties: { step: "publish_push", reason: "stale_head" },
    };
    expect(sanitizePostHogEvent(event)).toBe(event);
  });

  it("redacts error_message while preserving other properties", () => {
    const event: EventMessage = {
      distinctId: "installation:1",
      event: "triage failed",
      properties: {
        step: "publish_report",
        error_message: `push failed Bearer ${TOKEN}`,
        owner: "o",
      },
    };
    const sanitized = sanitizePostHogEvent(event);
    expect(sanitized).not.toBe(event);
    expect(sanitized?.properties?.step).toBe("publish_report");
    expect(sanitized?.properties?.owner).toBe("o");
    expect(sanitized?.properties?.error_message).toContain("[redacted]");
    expect(String(sanitized?.properties?.error_message)).not.toContain("ghp_");
  });

  it("redacts exception value and stack-frame string fields", () => {
    const event: EventMessage = {
      distinctId: "installation:1",
      event: "$exception",
      properties: {
        $exception_list: [
          {
            type: "Error",
            value: `failed with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz`,
            stacktrace: {
              type: "raw",
              frames: [
                {
                  platform: "node:javascript",
                  filename: `/tmp/app.ts`,
                  function: "run",
                  context_line: `const auth = "Bearer ${TOKEN}";`,
                  pre_context: [`// token ${TOKEN}`],
                  post_context: ["return;"],
                  lineno: 12,
                },
              ],
            },
          },
        ],
      },
    };

    const sanitized = sanitizePostHogEvent(event);
    const entry = (sanitized?.properties?.$exception_list as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(entry.type).toBe("Error");
    expect(String(entry.value)).toContain("[redacted]");
    expect(String(entry.value)).not.toContain("sk-");

    const frame = (entry.stacktrace as { frames: Array<Record<string, unknown>> }).frames[0];
    expect(frame.filename).toBe("/tmp/app.ts");
    expect(frame.function).toBe("run");
    expect(frame.lineno).toBe(12);
    expect(String(frame.context_line)).toContain("[redacted]");
    expect(String(frame.context_line)).not.toContain("ghp_");
    expect((frame.pre_context as string[])[0]).toContain("[redacted]");
    expect((frame.pre_context as string[])[0]).not.toContain("ghp_");
    expect(frame.post_context).toEqual(["return;"]);
  });
});
