import { afterEach, describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";

describe("evlog wide events", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("recordEvent appends linearly without array-merge duplication", () => {
    evlog.initEvlog("debug", { silent: true, suppressDrainWarning: true, maxWideEvents: 128 });
    const logger = evlog.createOperationLogger({ method: "JOB", path: "/test" });
    for (let i = 0; i < 50; i++) {
      evlog.recordEvent(logger, `evt_${i}`, { i }, "info");
    }
    const events = logger.getContext().events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(50);
    expect(events[49]?.event).toBe("evt_49");
  });

  it("drops debug sub-events when LOG_LEVEL is info", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logger = evlog.createOperationLogger({ method: "JOB", path: "/test" });
    evlog.recordEvent(logger, "debug_evt", {}, "debug");
    evlog.recordEvent(logger, "info_evt", {}, "info");
    vi.spyOn(logger, "emit").mockResolvedValue(null);
    await evlog.emitOperationLogger(logger);
    const names = (logger.getContext().events as Array<Record<string, unknown>>).map(
      (e) => e.event,
    );
    expect(names).toEqual(["info_evt"]);
  });

  it("caps sub-events at LOG_MAX_WIDE_EVENTS", () => {
    evlog.initEvlog("debug", { silent: true, suppressDrainWarning: true, maxWideEvents: 5 });
    const logger = evlog.createOperationLogger({ method: "JOB", path: "/test" });
    for (let i = 0; i < 7; i++) {
      evlog.recordEvent(logger, `evt_${i}`, {}, "info");
    }
    const ctx = logger.getContext();
    expect((ctx.events as unknown[]).length).toBe(5);
    expect(ctx.eventsDropped).toBe(2);
  });

  it("resets maxWideEvents when re-initialized without option", () => {
    evlog.initEvlog("debug", { silent: true, suppressDrainWarning: true, maxWideEvents: 5 });
    evlog.initEvlog("debug", { silent: true, suppressDrainWarning: true });
    const logger = evlog.createOperationLogger({ method: "JOB", path: "/test" });
    for (let i = 0; i < 10; i++) {
      evlog.recordEvent(logger, `evt_${i}`, {}, "info");
    }
    expect((logger.getContext().events as unknown[]).length).toBe(10);
  });

  it("recordEvent accepts undefined fields without throwing", () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logger = evlog.createOperationLogger({ method: "JOB", path: "/test" });
    expect(() => evlog.recordEvent(logger, "no_fields")).not.toThrow();
    expect(() => evlog.recordEvent(logger, "explicit_undefined", undefined)).not.toThrow();
    const events = logger.getContext().events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("no_fields");
    expect(events[1]?.event).toBe("explicit_undefined");
  });

  it("recordEvent skips debug-level entries when LOG_LEVEL is info", () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logger = evlog.createOperationLogger({ method: "JOB", path: "/test" });
    evlog.recordEvent(logger, "skipped", {}, "debug");
    expect((logger.getContext().events as unknown[] | undefined)?.length ?? 0).toBe(0);
    evlog.recordEvent(logger, "kept", {}, "info");
    expect(
      (logger.getContext().events as Array<Record<string, unknown>>).map((e) => e.event),
    ).toEqual(["kept"]);
  });
});

describe("runWithOperationLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("propagates fn error when emit throws", async () => {
    const realCreate = evlog.createOperationLogger;
    vi.spyOn(evlog, "createOperationLogger").mockImplementation((meta) => {
      const logger = realCreate(meta);
      vi.spyOn(logger, "emit").mockRejectedValue(new Error("emit failed"));
      return logger;
    });

    await expect(
      evlog.runWithOperationLogger({ method: "GET", path: "/test" }, async () => {
        throw new Error("original");
      }),
    ).rejects.toThrow("original");
  });
});
