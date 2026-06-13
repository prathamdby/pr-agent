import { describe, expect, it } from "vitest";
import { planAutomatedPullRequestIntake } from "../src/agentWork/intake/planner.js";

const defaultDescriptionActions = new Set(["opened"]);

describe("planAutomatedPullRequestIntake", () => {
  it("schedules review and description on opened", () => {
    expect(
      planAutomatedPullRequestIntake("opened", {
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toEqual(["review", "description"]);
  });

  it("schedules review only on synchronize", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toEqual(["review"]);
  });

  it("schedules nothing on unsupported action", () => {
    expect(
      planAutomatedPullRequestIntake("labeled", {
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toEqual([]);
  });

  it("includes review kind when automated review actions apply", () => {
    expect(
      planAutomatedPullRequestIntake("opened", {
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toContain("review");
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toContain("review");
    expect(
      planAutomatedPullRequestIntake("labeled", {
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).not.toContain("review");
  });

  it("includes description kind only on description actions", () => {
    expect(
      planAutomatedPullRequestIntake("opened", {
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toContain("description");
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).not.toContain("description");
  });

  it("plans description on synchronize when configured", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        descriptionAutoActions: new Set(["opened", "synchronize"]),
      }).kinds,
    ).toEqual(["review", "description"]);
  });
});
