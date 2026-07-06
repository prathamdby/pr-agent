import { describe, expect, it } from "vitest";
import { planAutomatedPullRequestIntake } from "../src/agentWork/intake/planner.js";

const defaultReviewActions = new Set(["opened"]);
const defaultDescriptionActions = new Set(["opened"]);
const defaultVerificationActions = new Set(["synchronize"]);
const noVerificationActions = new Set<string>();

describe("planAutomatedPullRequestIntake", () => {
  it("schedules review and description on opened", () => {
    expect(
      planAutomatedPullRequestIntake("opened", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: defaultVerificationActions,
      }).kinds,
    ).toEqual(["review", "description"]);
  });

  it("schedules verification on synchronize with default verification actions", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: defaultVerificationActions,
      }).kinds,
    ).toEqual(["verification"]);
  });

  it("schedules nothing on synchronize when verification is disabled", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: noVerificationActions,
      }).kinds,
    ).toEqual([]);
  });

  it("schedules nothing on reopened with default actions", () => {
    // reopened previously triggered an automatic review via AUTOMATED_PR_ACTIONS;
    // it no longer does under REVIEW_AUTO_ACTIONS=opened and needs a manual /review.
    expect(
      planAutomatedPullRequestIntake("reopened", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: defaultVerificationActions,
      }).kinds,
    ).toEqual([]);
  });

  it("schedules nothing on unsupported action", () => {
    expect(
      planAutomatedPullRequestIntake("labeled", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: defaultVerificationActions,
      }).kinds,
    ).toEqual([]);
  });

  it("includes review kind only on configured review actions", () => {
    expect(
      planAutomatedPullRequestIntake("opened", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: defaultVerificationActions,
      }).kinds,
    ).toContain("review");
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: noVerificationActions,
      }).kinds,
    ).not.toContain("review");
    expect(
      planAutomatedPullRequestIntake("labeled", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: defaultVerificationActions,
      }).kinds,
    ).not.toContain("review");
  });

  it("includes description kind only on description actions", () => {
    expect(
      planAutomatedPullRequestIntake("opened", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: defaultVerificationActions,
      }).kinds,
    ).toContain("description");
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: noVerificationActions,
      }).kinds,
    ).not.toContain("description");
  });

  it("includes verification kind only on verification actions", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: defaultVerificationActions,
      }).kinds,
    ).toContain("verification");
    expect(
      planAutomatedPullRequestIntake("opened", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: defaultVerificationActions,
      }).kinds,
    ).not.toContain("verification");
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: noVerificationActions,
      }).kinds,
    ).not.toContain("verification");
  });

  it("plans description on synchronize when description actions include it", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: defaultReviewActions,
        descriptionAutoActions: new Set(["opened", "synchronize"]),
        verificationAutoActions: noVerificationActions,
      }).kinds,
    ).toEqual(["description"]);
  });

  it("plans review on synchronize when review actions include it", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: new Set(["opened", "synchronize"]),
        descriptionAutoActions: defaultDescriptionActions,
        verificationAutoActions: noVerificationActions,
      }).kinds,
    ).toEqual(["review"]);
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: new Set(["opened", "synchronize"]),
        descriptionAutoActions: new Set(["opened", "synchronize"]),
        verificationAutoActions: noVerificationActions,
      }).kinds,
    ).toEqual(["review", "description"]);
  });

  it("plans verification alongside review and description when all include synchronize", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        reviewAutoActions: new Set(["opened", "synchronize"]),
        descriptionAutoActions: new Set(["opened", "synchronize"]),
        verificationAutoActions: defaultVerificationActions,
      }).kinds,
    ).toEqual(["review", "description", "verification"]);
  });
});
