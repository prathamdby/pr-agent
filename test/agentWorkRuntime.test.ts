import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

const runtimeMocks = vi.hoisted(() => {
  const trace: string[] = [];
  const pool = {
    end: vi.fn(async () => undefined),
  };
  const boss = {};

  return {
    trace,
    pool,
    boss,
    createPgPool: vi.fn(() => pool),
    runMigrations: vi.fn(async () => undefined),
    createStartedBoss: vi.fn(async () => boss),
    ensureAgentQueues: vi.fn(async () => undefined),
    stopBoss: vi.fn(async () => {
      trace.push("boss.stop");
    }),
    shutdownPostHog: vi.fn(async () => {
      trace.push("posthog.shutdown");
    }),
  };
});

vi.mock("../src/db/postgres.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/postgres.js")>();
  return { ...actual, createPgPool: runtimeMocks.createPgPool };
});

vi.mock("../src/db/migrations.js", () => ({ runMigrations: runtimeMocks.runMigrations }));

vi.mock("../src/agentWork/boss.js", () => ({
  createStartedBoss: runtimeMocks.createStartedBoss,
  ensureAgentQueues: runtimeMocks.ensureAgentQueues,
  stopBoss: runtimeMocks.stopBoss,
}));

vi.mock("../src/posthog.js", () => ({
  shutdownPostHog: runtimeMocks.shutdownPostHog,
  posthog: { capture: vi.fn(), captureException: vi.fn() },
}));

describe("agent work runtime teardown", () => {
  it("shuts down PostHog after pg-boss drains", async () => {
    const { agentWorkWebLive } = await import("../src/agentWork/runtime.js");
    const cfg = makeTestConfig();

    await Effect.runPromise(Effect.scoped(Layer.build(agentWorkWebLive(cfg))));

    expect(runtimeMocks.stopBoss).toHaveBeenCalledWith(
      runtimeMocks.boss,
      cfg.shutdownDrainTimeoutSeconds * 1000,
    );
    expect(runtimeMocks.trace).toEqual(["boss.stop", "posthog.shutdown"]);
  });
});
