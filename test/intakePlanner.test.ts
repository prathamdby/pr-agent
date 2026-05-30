import { describe, expect, it } from "vitest";
import { planAutomatedPullRequestIntake } from "../src/agentWork/intake/planner.js";

describe("planAutomatedPullRequestIntake", () => {
  it("schedules review and description on opened", () => {
    expect(planAutomatedPullRequestIntake("opened").kinds).toEqual(["review", "description"]);
  });

  it("schedules review only on synchronize", () => {
    expect(planAutomatedPullRequestIntake("synchronize").kinds).toEqual(["review"]);
  });

  it("schedules nothing on unsupported action", () => {
    expect(planAutomatedPullRequestIntake("labeled").kinds).toEqual([]);
  });

  it("includes review kind when automated review actions apply", () => {
    expect(planAutomatedPullRequestIntake("opened").kinds).toContain("review");
    expect(planAutomatedPullRequestIntake("synchronize").kinds).toContain("review");
    expect(planAutomatedPullRequestIntake("labeled").kinds).not.toContain("review");
  });

  it("includes description kind only on description actions", () => {
    expect(planAutomatedPullRequestIntake("opened").kinds).toContain("description");
    expect(planAutomatedPullRequestIntake("synchronize").kinds).not.toContain("description");
  });
});
