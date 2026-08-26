import { afterEach, describe, expect, it, vi } from "vitest";
import { log as globalLog } from "evlog";
import { AppError } from "../src/errors/appError.js";
import * as evlog from "../src/evlog.js";

const TOKEN = ["ghp", "1234567890123456789012345678901234"].join("_");

describe("evlog wide events", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("recordEvent appends linearly without array-merge duplication", () => {
    evlog.initEvlog("debug", {
      silent: true,
      suppressDrainWarning: true,
      maxWideEvents: 128,
    });
    const logger = evlog.createOperationLogger({
      method: "JOB",
      path: "/test",
    });
    for (let i = 0; i < 50; i++) {
      evlog.recordEvent(logger, `evt_${i}`, { i }, "info");
    }
    const events = logger.getContext().events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(50);
    expect(events[49]?.event).toBe("evt_49");
  });

  it("drops debug sub-events when LOG_LEVEL is info", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logger = evlog.createOperationLogger({
      method: "JOB",
      path: "/test",
    });
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
    evlog.initEvlog("debug", {
      silent: true,
      suppressDrainWarning: true,
      maxWideEvents: 5,
    });
    const logger = evlog.createOperationLogger({
      method: "JOB",
      path: "/test",
    });
    for (let i = 0; i < 7; i++) {
      evlog.recordEvent(logger, `evt_${i}`, {}, "info");
    }
    const ctx = logger.getContext();
    expect((ctx.events as unknown[]).length).toBe(5);
    expect(ctx.eventsDropped).toBe(2);
  });

  it("resets maxWideEvents when re-initialized without option", () => {
    evlog.initEvlog("debug", {
      silent: true,
      suppressDrainWarning: true,
      maxWideEvents: 5,
    });
    evlog.initEvlog("debug", { silent: true, suppressDrainWarning: true });
    const logger = evlog.createOperationLogger({
      method: "JOB",
      path: "/test",
    });
    for (let i = 0; i < 10; i++) {
      evlog.recordEvent(logger, `evt_${i}`, {}, "info");
    }
    expect((logger.getContext().events as unknown[]).length).toBe(10);
  });

  it("recordEvent accepts undefined fields without throwing", () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logger = evlog.createOperationLogger({
      method: "JOB",
      path: "/test",
    });
    expect(() => evlog.recordEvent(logger, "no_fields")).not.toThrow();
    expect(() => evlog.recordEvent(logger, "explicit_undefined", undefined)).not.toThrow();
    const events = logger.getContext().events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("no_fields");
    expect(events[1]?.event).toBe("explicit_undefined");
  });

  it("recursively redacts fields before storing structured log events", () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logger = evlog.createOperationLogger({
      method: "JOB",
      path: "/test",
    });
    const fields: Record<string, unknown> = {
      errorMessage: `failed Bearer ${TOKEN}`,
      errorContext: {
        workItemId: "work-1",
        rawValue: ["DATABASE_URL=postgres://user:pass@db/app"],
      },
    };
    fields.circular = fields;

    evlog.recordEvent(logger, "error", fields, "error");

    const stored = (logger.getContext().events as Array<Record<string, unknown>>)[0];
    expect(stored?.errorMessage).toContain("[redacted]");
    const errorContext = stored?.errorContext as Record<string, unknown> | undefined;
    expect(errorContext?.workItemId).toBe("work-1");
    expect(stored?.circular).toBe("[circular]");
    expect(JSON.stringify(stored)).not.toContain("postgres://");
  });

  it("sanitizes operation context before storing and emitting", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logger = evlog.createOperationLogger({
      method: "JOB",
      path: "/test",
      context: { errorMessage: `Bearer ${TOKEN}`, safeId: "work-1" },
    });
    expect(logger.getContext().errorMessage).toBe("[redacted]");
    expect(logger.getContext().safeId).toBe("work-1");

    logger.set({ password: "opaque-password" });
    const emit = vi.spyOn(logger, "emit").mockResolvedValue(null);
    await evlog.emitOperationLogger(logger);

    expect(logger.getContext().password).toBe("[redacted]");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("sanitizes errors passed to the operation logger", async () => {
    evlog.initEvlog("error", {
      silent: false,
      pretty: false,
      redact: false,
      suppressDrainWarning: true,
    });
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const thrown = new AppError({
      code: "worker.failed",
      message: "worker failed",
      cause: { apiKey: "opaque-provider-key" },
    });

    await expect(
      evlog.runWithOperationLogger({ method: "JOB", path: "/test" }, async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);

    const emitted = JSON.stringify(output.mock.calls);
    expect(output).toHaveBeenCalled();
    expect(emitted).not.toContain("opaque-provider-key");
    expect(emitted).toContain("[redacted]");
  });

  it("sanitizes the global logger fallback", () => {
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
    const error = vi.spyOn(globalLog, "error").mockImplementation(() => undefined);

    evlog.logError("worker_failed", {
      password: "opaque-password",
      safeId: "work-1",
    });

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ password: "[redacted]", safeId: "work-1" }),
    );
  });

  it("recordEvent skips debug-level entries when LOG_LEVEL is info", () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logger = evlog.createOperationLogger({
      method: "JOB",
      path: "/test",
    });
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
