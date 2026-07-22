import { describe, expect, it } from "vitest";
import {
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_NO_FINDINGS,
  STATUS_RUNNING,
  STATUS_WAITING,
  checkRunFindingsSummary,
  statusFindings,
} from "../src/github/statusCopy.js";

describe("statusCopy", () => {
  it("exports sentence-case status phrases", () => {
    expect(STATUS_WAITING).toBe("⏸ Waiting");
    expect(STATUS_RUNNING).toBe("⏳ Running");
    expect(STATUS_DONE).toBe("✅ Done");
    expect(STATUS_NO_FINDINGS).toBe("✅ No findings");
    expect(STATUS_FAILED).toBe("⚠️ Failed");
  });

  it("formats finding counts with singular and plural forms", () => {
    expect(statusFindings(0)).toBe("✅ No findings");
    expect(statusFindings(1)).toBe("✅ 1 finding");
    expect(statusFindings(3)).toBe("✅ 3 findings");
  });

  it("keeps check-run summaries emoji-free", () => {
    expect(checkRunFindingsSummary(0)).toBe("No findings");
    expect(checkRunFindingsSummary(1)).toBe("1 finding");
    expect(checkRunFindingsSummary(4)).toBe("4 findings");
  });
});
