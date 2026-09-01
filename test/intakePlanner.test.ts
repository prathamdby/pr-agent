import { describe, expect, it } from "vitest";
import { planAutomatedPullRequestIntake } from "../src/agentWork/intake/planner.js";

const allAuto = { review: "auto", describe: "auto", verification: "auto" } as const;

describe("planAutomatedPullRequestIntake", () => {
  it("schedules review and description on opened", () => {
    expect(planAutomatedPullRequestIntake("opened", allAuto).kinds).toEqual([
      "review",
      "description",
    ]);
  });

  it("schedules review supersede and verification on synchronize", () => {
    expect(planAutomatedPullRequestIntake("synchronize", allAuto).kinds).toEqual([
      "reviewSupersede",
      "verification",
    ]);
  });

  it("schedules review supersede on synchronize even when verification is off", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", { ...allAuto, verification: "off" }).kinds,
    ).toEqual(["reviewSupersede"]);
  });

  it("schedules nothing on reopened or unsupported actions", () => {
    expect(planAutomatedPullRequestIntake("reopened", allAuto).kinds).toEqual([]);
    expect(planAutomatedPullRequestIntake("labeled", allAuto).kinds).toEqual([]);
  });

  it("manual review mode suppresses the auto review", () => {
    expect(
      planAutomatedPullRequestIntake("opened", { ...allAuto, review: "manual" }).kinds,
    ).toEqual(["description"]);
  });

  it("manual review mode suppresses the push supersede", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", { ...allAuto, review: "manual" }).kinds,
    ).toEqual(["verification"]);
  });

  it("off review mode suppresses the push supersede", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        review: "off",
        describe: "auto",
        verification: "auto",
      }).kinds,
    ).not.toContain("reviewSupersede");
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        review: "off",
        describe: "off",
        verification: "off",
      }).kinds,
    ).toEqual([]);
  });

  it("off and manual describe modes suppress the auto description", () => {
    expect(planAutomatedPullRequestIntake("opened", { ...allAuto, describe: "off" }).kinds).toEqual(
      ["review"],
    );
    expect(
      planAutomatedPullRequestIntake("opened", { ...allAuto, describe: "manual" }).kinds,
    ).toEqual(["review"]);
  });

  it("schedules nothing on opened when review is manual and describe is off", () => {
    expect(
      planAutomatedPullRequestIntake("opened", {
        review: "manual",
        describe: "off",
        verification: "auto",
      }).kinds,
    ).toEqual([]);
  });

  it("schedules nothing on synchronize when review is manual, describe off, verification off", () => {
    expect(
      planAutomatedPullRequestIntake("synchronize", {
        review: "manual",
        describe: "off",
        verification: "off",
      }).kinds,
    ).toEqual([]);
  });
});
