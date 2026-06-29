import { describe, expect, it } from "vitest";
import { planAutomatedPullRequestIntake } from "../src/agentWork/intake/planner.js";

const defaultReviewActions = new Set(["opened"]);
const defaultDescriptionActions = new Set(["opened"]);

describe("planAutomatedPullRequestIntake", () => {
  it("schedules review and description on opened", () => {
    expect(
      planAutomatedPullRequestIntake("opened", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toEqual(["review", "description"]);
  });

  it("schedules nothing on synchronize with default review actions", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toEqual([]);
  });

  it("schedules nothing on unsupported action", () => {
    expect(
      planAutomatedPullRequestIntake("labeled", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toEqual([]);
  });

  it("includes review kind only on configured review actions", () => {
    expect(
      planAutomatedPullRequestIntake("opened", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toContain("review");
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).not.toContain("review");
    expect(
      planAutomatedPullRequestIntake("labeled", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).not.toContain("review");
  });

  it("includes description kind only on description actions", () => {
    expect(
      planAutomatedPullRequestIntake("opened", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toContain("description");
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).not.toContain("description");
  });

  it("plans description on synchronize when description actions include it", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: new Set(["opened", "synchronize"]),
      }).kinds,
    ).toEqual(["description"]);
  });

  it("plans review on synchronize when review actions include it", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: new Set(["opened", "synchronize"]),
        descriptionAutoActions: defaultDescriptionActions,
      }).kinds,
    ).toEqual(["review"]);
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: new Set(["opened", "synchronize"]),
        descriptionAutoActions: new Set(["opened", "synchronize"]),
      }).kinds,
    ).toEqual(["review", "description"]);
  });
});
