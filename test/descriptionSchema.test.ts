import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  coerceDescriptionPayloadInput,
  descriptionPayloadSchema,
} from "../src/agent/description/descriptionSchema.js";

describe("descriptionSchema", () => {
  it("accepts minimal valid payload", () => {
    const parsed = v.safeParse(descriptionPayloadSchema, {
      title: "Fix session handling",
      type: ["Bug fix"],
      description: "- Validate cookie\n- Reject expired tokens",
    });
    expect(parsed.success).toBe(true);
  });

  it("coerces snake_case and pr_files envelope", () => {
    const coerced = coerceDescriptionPayloadInput({
      description: {
        title: "Add metrics",
        type: ["enhancement"],
        description: "- Export counters",
        pr_files: [
          {
            filename: "src/metrics.ts",
            changes_title: "Metrics export",
            label: "enhancement",
          },
        ],
      },
    });
    const parsed = v.safeParse(descriptionPayloadSchema, coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.prFiles?.[0]?.filename).toBe("src/metrics.ts");
      expect(parsed.output.type).toContain("Enhancement");
    }
  });

  it("accepts read-first entries with only filename and changesTitle", () => {
    const parsed = v.safeParse(descriptionPayloadSchema, {
      title: "Auth hardening",
      type: ["Enhancement"],
      description: "- Tighten session checks",
      prFiles: [
        {
          filename: "src/auth/session.ts",
          changesTitle: "Auth boundary is the risk surface",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("coerces reason alias into changesTitle", () => {
    const coerced = coerceDescriptionPayloadInput({
      title: "t",
      type: ["Enhancement"],
      description: "- d",
      prFiles: [{ filename: "src/a.ts", reason: "Open this first for the data path" }],
    });
    const parsed = v.safeParse(descriptionPayloadSchema, coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.prFiles?.[0]?.changesTitle).toBe("Open this first for the data path");
    }
  });

  it("accepts optional visuals array", () => {
    const parsed = v.safeParse(descriptionPayloadSchema, {
      title: "Add cache",
      type: ["Enhancement"],
      description: "- Add cache layer",
      visuals: [
        {
          kind: "call_tree",
          content: "handler\n  loadCache\n  return value",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("does not coerce legacy changes_diagram field", () => {
    const coerced = coerceDescriptionPayloadInput({
      title: "t",
      type: ["Enhancement"],
      description: "- d",
      changes_diagram: "```mermaid\nflowchart LR\n  A --> B\n```",
    });
    expect(coerced.changesDiagram).toBeUndefined();
    expect(coerced.changes_diagram).toBeDefined();
  });
});
