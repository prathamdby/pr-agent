import { describe, expect, it } from "vitest";
import {
  sanitizePostHogEvent,
  type PostHogEventMessage,
} from "../src/security/sanitizePostHogEvent.js";
import {
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from "../src/util/jsonValue.js";

const TOKEN = "ghp_1234567890123456789012345678901234";

function expectJsonObject(value: JsonValue | undefined): JsonObject {
  expect(value !== undefined && isJsonObject(value)).toBe(true);
  if (value === undefined || !isJsonObject(value)) {
    throw new Error("expected a JSON object");
  }
  return value;
}

function expectJsonArray(value: JsonValue | undefined): readonly JsonValue[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) {
    throw new Error("expected a JSON array");
  }
  return value;
}

function expectJsonString(value: JsonValue | undefined): string {
  expect(value !== undefined && isJsonString(value)).toBe(true);
  if (value === undefined || !isJsonString(value)) {
    throw new Error("expected a JSON string");
  }
  return value;
}

function firstExceptionEntry(properties: JsonObject | null | undefined): JsonObject {
  return expectJsonObject(expectJsonArray(properties?.$exception_list)[0]);
}

function firstStackFrame(entry: JsonObject): JsonObject {
  return expectJsonObject(expectJsonArray(expectJsonObject(entry.stacktrace).frames)[0]);
}

describe("sanitizePostHogEvent", () => {
  it("returns null unchanged", () => {
    expect(sanitizePostHogEvent(null)).toBeNull();
  });

  it("leaves benign events without error fields unchanged by identity", () => {
    const event: PostHogEventMessage = {
      distinctId: "installation:1",
      event: "triage degraded",
      properties: { step: "publish_push", reason: "stale_head" },
    };
    expect(sanitizePostHogEvent(event)).toBe(event);
  });

  it("redacts error_message while preserving other properties", () => {
    const event: PostHogEventMessage = {
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
    const event: PostHogEventMessage = {
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
    const entry = firstExceptionEntry(sanitized?.properties);
    expect(entry.type).toBe("Error");
    const value = expectJsonString(entry.value);
    expect(value).toContain("[redacted]");
    expect(value).not.toContain("sk-");

    const frame = firstStackFrame(entry);
    expect(frame.filename).toBe("/tmp/app.ts");
    expect(frame.function).toBe("run");
    expect(frame.lineno).toBe(12);
    const contextLine = expectJsonString(frame.context_line);
    expect(contextLine).toContain("[redacted]");
    expect(contextLine).not.toContain("ghp_");
    const preContext = expectJsonString(expectJsonArray(frame.pre_context)[0]);
    expect(preContext).toContain("[redacted]");
    expect(preContext).not.toContain("ghp_");
    expect(frame.post_context).toEqual(["return;"]);
  });

  it("does not mutate the input event, nested exception structures, or original secret strings", () => {
    const errorMessage = `push failed Bearer ${TOKEN}`;
    const exceptionValue = `failed with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz`;
    const contextLine = `const auth = "Bearer ${TOKEN}";`;
    const preContext = [`// token ${TOKEN}`];
    const postContext = ["return;"];
    const frame = {
      platform: "node:javascript",
      filename: "/tmp/app.ts",
      function: "run",
      context_line: contextLine,
      pre_context: preContext,
      post_context: postContext,
      lineno: 12,
    };
    const frames = [frame];
    const stacktrace = { type: "raw", frames };
    const exceptionEntry = {
      type: "Error",
      value: exceptionValue,
      stacktrace,
    };
    const exceptionList = [exceptionEntry];
    const properties = {
      step: "publish_report",
      error_message: errorMessage,
      $exception_list: exceptionList,
    };
    const event: PostHogEventMessage = {
      distinctId: "installation:1",
      event: "$exception",
      properties,
    };

    const sanitized = sanitizePostHogEvent(event);
    const sanitizedEntry = firstExceptionEntry(sanitized?.properties);
    const sanitizedFrame = firstStackFrame(sanitizedEntry);

    expect(sanitized).not.toBe(event);
    expect(sanitized?.properties).not.toBe(properties);
    expect(sanitized?.properties?.$exception_list).not.toBe(exceptionList);
    expect(sanitizedEntry).not.toBe(exceptionEntry);
    expect(sanitizedEntry.stacktrace).not.toBe(stacktrace);
    expect(expectJsonObject(sanitizedEntry.stacktrace).frames).not.toBe(frames);
    expect(sanitizedFrame).not.toBe(frame);
    expect(sanitizedFrame.pre_context).not.toBe(preContext);

    expect(event.properties).toBe(properties);
    expect(properties.error_message).toBe(errorMessage);
    expect(properties.$exception_list).toBe(exceptionList);
    expect(exceptionEntry.value).toBe(exceptionValue);
    expect(exceptionEntry.stacktrace).toBe(stacktrace);
    expect(stacktrace.frames).toBe(frames);
    expect(frames[0]).toBe(frame);
    expect(frame.context_line).toBe(contextLine);
    expect(frame.pre_context).toBe(preContext);
    expect(preContext[0]).toBe(`// token ${TOKEN}`);
    expect(errorMessage).toContain("ghp_");
    expect(exceptionValue).toContain("sk-");
    expect(contextLine).toContain("ghp_");
    expect(String(sanitized?.properties?.error_message)).toContain("[redacted]");
    expect(String(sanitized?.properties?.error_message)).not.toContain("ghp_");
  });
});
