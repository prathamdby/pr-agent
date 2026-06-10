import { describe, expect, it } from "vitest";
import { bossConstructorOptions } from "../src/agentWork/boss.js";

describe("bossConstructorOptions", () => {
  it("keeps pg-boss maintenance on the worker role", () => {
    expect(
      bossConstructorOptions({ databaseUrl: "postgres://test", role: "worker" }),
    ).toMatchObject({
      schedule: true,
      supervise: true,
    });
  });

  it("disables pg-boss maintenance on the web role", () => {
    expect(bossConstructorOptions({ databaseUrl: "postgres://test", role: "web" })).toMatchObject(
      {
        schedule: false,
        supervise: false,
      },
    );
  });
});
