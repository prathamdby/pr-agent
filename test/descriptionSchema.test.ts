import { describe, expect, it } from "vitest";
import {
  coerceDescriptionPayloadInput,
  descriptionPayloadSchema,
} from "../src/agent/descriptionSchema.js";

describe("descriptionSchema", () => {
  it("accepts minimal valid payload", () => {
    const parsed = descriptionPayloadSchema.safeParse({
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
    const parsed = descriptionPayloadSchema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.prFiles?.[0]?.filename).toBe("src/metrics.ts");
      expect(parsed.data.type).toContain("Enhancement");
    }
  });
});
