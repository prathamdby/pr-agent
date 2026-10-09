import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { AiCapture } from "../src/analytics/posthogSink.js";
import { createSessionTrace } from "../src/agent/runtime/sessionTrace.js";
import { toToolParameters } from "../src/agent/tools/toolParams.js";
import {
  DEFAULT_THINKING_POLICY,
  DEFAULT_TOOL_POLICY,
  type PiSessionCreateParams,
} from "../src/agent/runtime/types.js";
import * as evlog from "../src/evlog.js";
import type { Config } from "../src/settings/index.js";
import {
  initTraces,
  startWorkTrace,
  TRACE_EVENT_BYTES,
  type TraceWork,
} from "../src/traces/recorder.js";
import { makeTestConfig } from "./helpers/config.js";

type PostHogOptions = {
  readonly host?: string;
  readonly enableExceptionAutocapture?: boolean;
  readonly before_send?: (event: unknown) => unknown;
  readonly flushInterval?: number;
  readonly maxQueueSize?: number;
  readonly enableFullAiCapture?: boolean;
};

const mockPostHog = vi.hoisted(() => {
  const instances: Array<{
    readonly apiKey: string;
    readonly options: PostHogOptions;
    readonly shutdown: Mock;
    readonly capture: Mock;
    readonly captureAi: Mock;
    readonly flush: Mock;
    readonly captureException: Mock;
  }> = [];

  return {
    instances,
    PostHog: vi.fn(function MockPostHog(apiKey: string, options: PostHogOptions) {
      const shutdown = vi.fn(async () => undefined);
      const capture = vi.fn();
      const captureAi = vi.fn();
      const flush = vi.fn(async () => undefined);
      const captureException = vi.fn();
      instances.push({ apiKey, options, shutdown, capture, captureAi, flush, captureException });
      return { shutdown, capture, captureAi, flush, captureException };
    }),
  };
});

vi.mock("posthog-node", () => ({ PostHog: mockPostHog.PostHog }));

describe("analytics facade", () => {
  beforeEach(() => {
    vi.resetModules();
    mockPostHog.instances.length = 0;
    mockPostHog.PostHog.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockPostHog.instances.length = 0;
  });

  it("does not load posthog-node when token is empty", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "", host: "" });
    analytics.captureEvent({
      distinctId: "server",
      event: "webhook received",
      properties: { github_event: "ping" },
    });
    analytics.captureException(new Error("boom"), "server", { step: "test" });
    await analytics.shutdownAnalytics();

    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
    expect(mockPostHog.instances).toHaveLength(0);
  });

  it.each([
    { posthog: false, audit: false },
    { posthog: false, audit: true },
    { posthog: true, audit: false },
    { posthog: true, audit: true },
  ])(
    "keeps send identity on the lifecycle trail and off ordinary PostHog (PostHog=$posthog, audit=$audit)",
    async ({ posthog, audit }) => {
      const analytics = await import("../src/analytics/index.js");
      const { createFeaturePiSession } =
        await import("../src/agent/runtime/createFeatureSession.js");
      const { createFakePiSession } = await import("../src/agent/runtime/fakePiSession.js");
      const { makeTestConfig } = await import("./helpers/config.js");
      const { Pool } = await import("pg");
      const pool = new Pool();
      const writes = vi.spyOn(pool, "query").mockImplementation(async () => ({
        rows: [],
        rowCount: 1,
        command: "INSERT",
        oid: 0,
        fields: [],
      }));
      await analytics.initAnalytics({ projectToken: posthog ? "token" : "", host: "" });
      const captureTimes: number[] = [];
      const capture = mockPostHog.instances[0]?.capture;
      capture?.mockImplementation(() => captureTimes.push(Date.now()));
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const events: import("../src/agent/runtime/types.js").AgentLifecycleEvent[] = [];
      const session = await createFeaturePiSession({
        role: "specialist",
        specialistId: "security",
        cfg: makeTestConfig({ agentEvents: { enabled: audit } }),
        attemptModel: { provider: "anthropic", model: "fallback" },
        systemPrompt: "private system",
        tools: [],
        executors: {},
        sessionContext: {
          pool,
          workItemId: "work",
          installationId: 1,
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          executionId: "execution",
          attemptCount: 2,
        },
        createSession: (params) =>
          createFakePiSession(params, ({ prompt }) => {
            if (prompt === "failure") {
              now.mockReturnValue(3_040);
              throw new Error("provider unavailable");
            }
            now.mockReturnValue(prompt === "normal" ? 1_075 : 2_025);
            return "";
          }).session,
        eventSink: (event) => events.push(event),
      });
      try {
        await session.send("normal", { phase: "specialist", checkpointId: "same" });
        now.mockReturnValue(2_000);
        await session.send("repair", { phase: "validation_repair", checkpointId: "same" });
        now.mockReturnValue(3_000);
        await expect(
          session.send("failure", { phase: "specialist", checkpointId: "same" }),
        ).rejects.toThrow("provider unavailable");
        const starts = events.filter((event) => event.kind === "turn");
        const ends = events.filter(
          (event) => event.kind === "completion" || event.kind === "failure",
        );
        expect(new Set(starts.map((event) => event.generationId)).size).toBe(3);
        expect(ends.map((event) => event.generationId)).toEqual(
          starts.map((event) => event.generationId),
        );
        expect(ends.map((event) => event.durationMs)).toEqual([75, 25, 40]);
        expect(new Set(ends.map((event) => event.sessionId)).size).toBe(1);
        expect(ends[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(writes.mock.calls.length).toBe(audit ? 9 : 0);
        if (posthog) {
          expect(captureTimes).toEqual([]);
          expect(JSON.stringify(capture?.mock.calls)).not.toContain("private");
          expect(JSON.stringify(capture?.mock.calls)).not.toContain("normal");
        } else {
          expect(mockPostHog.PostHog).not.toHaveBeenCalled();
        }
      } finally {
        await session.dispose();
        await pool.end();
        await analytics.shutdownAnalytics();
      }
    },
  );

  it("lazy-loads PostHog with autocapture and sanitizer when token is set", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({
      projectToken: "phc_test_token",
      host: "https://posthog.example",
    });

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("phc_test_token", {
      host: "https://posthog.example",
      enableExceptionAutocapture: true,
      before_send: expect.any(Function),
    });

    const beforeSend = mockPostHog.instances[0]?.options.before_send;
    const token = ["ghp", "1234567890123456789012345678901234"].join("_");
    const sanitized = beforeSend?.({
      distinctId: "installation:1",
      event: "triage failed",
      properties: { error_message: `push failed Bearer ${token}` },
    });
    expect(
      String((sanitized as { properties?: { error_message?: string } })?.properties?.error_message),
    ).toContain("[redacted]");
  });

  it("forwards captureEvent and captureException to the PostHog client", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const err = new Error("fail");
    analytics.captureEvent({
      distinctId: "installation:1",
      event: "work completed",
      properties: { type: "review" },
    });
    analytics.captureException(err, "installation:1", { type: "review" });

    const client = mockPostHog.instances[0];
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:1",
      event: "work completed",
      properties: { type: "review" },
    });
    expect(client?.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Error", message: "fail" }),
      "installation:1",
      {
        type: "review",
      },
    );
  });

  it("sanitizes distinct ids before forwarding events and exceptions", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const token = ["ghp", "1234567890123456789012345678901234"].join("_");
    const databaseUrl = ["postgres:", "//user:pass@db/app"].join("");
    const apiKey = ["sk", "-abcdefghijklmnopqrstuvwxyz"].join("");
    const distinctId = `Bearer ${token} ${databaseUrl} ${apiKey}`;

    analytics.captureEvent({ distinctId, event: "work completed" });
    analytics.captureException(new Error("boom"), distinctId);

    const client = mockPostHog.instances[0];
    const eventDistinctId = client?.capture.mock.calls[0]?.[0]?.distinctId as string;
    const exceptionDistinctId = client?.captureException.mock.calls[0]?.[1] as string;
    expect(eventDistinctId).toContain("[redacted]");
    expect(exceptionDistinctId).toContain("[redacted]");
    expect(eventDistinctId).not.toContain(token);
    expect(exceptionDistinctId).not.toContain(token);
    expect(JSON.stringify(client?.capture.mock.calls[0])).not.toContain(databaseUrl);
    expect(JSON.stringify(client?.captureException.mock.calls[0])).not.toContain(apiKey);
  });

  it("shuts down the client and no-ops shutdown when disabled", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "token", host: "" });
    await analytics.shutdownAnalytics();
    expect(mockPostHog.instances[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(mockPostHog.instances[0]?.shutdown).toHaveBeenCalledWith(5_000);

    vi.resetModules();
    mockPostHog.instances.length = 0;
    mockPostHog.PostHog.mockClear();
    const disabled = await import("../src/analytics/index.js");
    await disabled.initAnalytics({ projectToken: "  ", host: "" });
    await expect(disabled.shutdownAnalytics()).resolves.toBeUndefined();
    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
  });

  it("forwards logError to captureException when analytics is enabled", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "token", host: "" });

    const { AppError } = await import("../src/errors/appError.js");
    const { logError } = await import("../src/evlog.js");
    const err = new AppError({
      domain: "review",
      kind: "specialist_failed",
      message: "boom",
      context: { workItemId: "w1" },
    });

    logError(
      "agent_work_failed",
      {
        message: err.message,
        installationId: 42,
        errorCode: err.code,
        errorContext: err.context,
      },
      err,
    );

    const client = mockPostHog.instances[0];
    expect(client?.captureException).toHaveBeenCalledTimes(1);
    const call = client?.captureException.mock.calls[0];
    expect(call?.[0]).not.toBe(err);
    expect(call?.[0]).toMatchObject({ name: "AppError", message: "boom" });
    expect(call?.[1]).toBe("installation:42");
    expect(call?.[2]).toMatchObject({
      event: "agent_work_failed",
      errorCode: "review.specialist_failed",
      errorContext: { workItemId: "w1" },
    });
  });

  it("sanitizes AppError telemetry before both analytics forwarding paths", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "token", host: "" });

    const { AppError, errorLogFields } = await import("../src/errors/appError.js");
    const { logError } = await import("../src/evlog.js");
    const token = ["ghp", "1234567890123456789012345678901234"].join("_");
    const error = new AppError({
      domain: "review",
      kind: "specialist_failed",
      message: `failed Bearer ${token}`,
      context: {
        workItemId: "w1",
        rawValue: { database: "postgres://user:pass@db/app" },
      },
      cause: new Error("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz"),
    });

    logError(
      "agent_work_failed",
      {
        installationId: 42,
        ...errorLogFields(error),
      },
      error,
    );

    const call = mockPostHog.instances[0]?.captureException.mock.calls[0];
    const forwardedError = call?.[0] as Error;
    const properties = call?.[2] as Record<string, unknown>;
    expect(forwardedError).not.toBe(error);
    expect(forwardedError.message).toContain("[redacted]");
    expect(properties.errorCode).toBe("review.specialist_failed");
    expect(properties.errorContext).toMatchObject({ workItemId: "w1" });
    const json = JSON.stringify({ forwardedError, properties });
    expect(json).not.toContain(token);
    expect(json).not.toContain("postgres://");
    expect(json).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("does not forward logError when analytics is disabled", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "", host: "" });

    const { logError } = await import("../src/evlog.js");
    logError("agent_work_failed", { message: "boom", installationId: 1 });

    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
  });

  it("resolves logError distinct ids from analyticsDistinctId and string installationId", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const { logError } = await import("../src/evlog.js");

    logError("agent_work_failed", { analyticsDistinctId: "custom-id", message: "a" });
    logError("agent_work_failed", { installationId: "gh-123", message: "b" });
    logError("agent_work_failed", { message: "c" });

    const calls = mockPostHog.instances[0]?.captureException.mock.calls ?? [];
    expect(calls[0]?.[1]).toBe("custom-id");
    expect(calls[1]?.[1]).toBe("installation:gh-123");
    expect(calls[2]?.[1]).toBe("server");
  });

  it("builds captureException errors from non-Error args and meta fallbacks", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const { logError } = await import("../src/evlog.js");

    logError("agent_work_failed", { installationId: 1 }, "raw string");
    logError("agent_work_failed", { installationId: 1, message: "fallback" });
    logError("agent_work_failed", { installationId: 1 });

    const calls = mockPostHog.instances[0]?.captureException.mock.calls ?? [];
    expect(calls[0]?.[0]).toEqual(expect.objectContaining({ message: "raw string" }));
    expect(calls[1]?.[0]).toEqual(expect.objectContaining({ message: "fallback" }));
    expect(calls[2]?.[0]).toEqual(expect.objectContaining({ message: "agent_work_failed" }));
  });

  it("strips analyticsDistinctId, error, and err from forwarded properties", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const { logError } = await import("../src/evlog.js");

    logError(
      "ev",
      { analyticsDistinctId: "x", error: "skip", err: "skip", kept: 1 },
      new Error("boom"),
    );

    const props = mockPostHog.instances[0]?.captureException.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(props).toMatchObject({ event: "ev", kept: 1 });
    expect(props).not.toHaveProperty("analyticsDistinctId");
    expect(props).not.toHaveProperty("error");
    expect(props).not.toHaveProperty("err");
  });

  it("keeps analytics disabled when PostHog sink construction fails", async () => {
    mockPostHog.PostHog.mockImplementationOnce(function () {
      throw new Error("sdk missing");
    });
    const analytics = await import("../src/analytics/index.js");

    await expect(analytics.initAnalytics({ projectToken: "token", host: "" })).rejects.toThrow(
      /sdk missing/,
    );
    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.captureEvent({ distinctId: "server", event: "webhook received" });
    analytics.captureException(new Error("boom"), "server");
    expect(mockPostHog.instances).toHaveLength(0);
  });

  it("commits a replacement sink only after construction succeeds", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({
      projectToken: "token-1",
      host: "https://a.example",
    });
    const previous = mockPostHog.instances[0];
    expect(analytics.isAnalyticsEnabled()).toBe(true);

    await analytics.initAnalytics({
      projectToken: "token-2",
      host: "https://b.example",
    });
    expect(analytics.isAnalyticsEnabled()).toBe(true);
    expect(mockPostHog.instances).toHaveLength(2);
    expect(mockPostHog.instances[1]?.apiKey).toBe("token-2");
    expect(mockPostHog.instances[1]?.options.host).toBe("https://b.example");

    analytics.captureEvent({ distinctId: "server", event: "webhook received" });
    analytics.captureException(new Error("boom"), "server");
    expect(previous?.capture).not.toHaveBeenCalled();
    expect(previous?.captureException).not.toHaveBeenCalled();
    expect(mockPostHog.instances[1]?.capture).toHaveBeenCalledTimes(1);
    expect(mockPostHog.instances[1]?.captureException).toHaveBeenCalledTimes(1);
  });

  it("restores no-op and disables after a failed reinitialization", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const previous = mockPostHog.instances[0];
    expect(analytics.isAnalyticsEnabled()).toBe(true);

    mockPostHog.PostHog.mockImplementationOnce(function () {
      throw new Error("reinit failed");
    });
    await expect(analytics.initAnalytics({ projectToken: "token-2", host: "" })).rejects.toThrow(
      /reinit failed/,
    );

    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.captureEvent({
      distinctId: "server",
      event: "webhook received",
      properties: { github_event: "ping" },
    });
    analytics.captureException(new Error("boom"), "server", { step: "test" });
    expect(previous?.capture).not.toHaveBeenCalled();
    expect(previous?.captureException).not.toHaveBeenCalled();
    expect(mockPostHog.instances).toHaveLength(1);
    await expect(analytics.shutdownAnalytics()).resolves.toBeUndefined();
  });

  it("disables and drops the previous sink when reinitialized with an empty token", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const previous = mockPostHog.instances[0];
    expect(analytics.isAnalyticsEnabled()).toBe(true);

    await analytics.initAnalytics({ projectToken: "  ", host: "" });
    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.captureEvent({ distinctId: "server", event: "webhook received" });
    analytics.captureException(new Error("boom"), "server");
    expect(previous?.capture).not.toHaveBeenCalled();
    expect(previous?.captureException).not.toHaveBeenCalled();
    expect(mockPostHog.PostHog).toHaveBeenCalledTimes(1);
  });

  it("does not register process signal listeners", async () => {
    const processOn = vi.spyOn(process, "on");

    await import("../src/analytics/index.js");

    expect(processOn).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("initNoOpAnalytics keeps capture paths no-op without constructing PostHog", async () => {
    const { captureEvent, initNoOpAnalytics, isAnalyticsEnabled } =
      await import("../src/analytics/index.js");
    initNoOpAnalytics();
    captureEvent({ distinctId: "server", event: "webhook received" });
    captureEvent({
      distinctId: "installation:1",
      event: "work completed",
      properties: { outcome: "published", work_item_id: "wi-1" },
    });
    expect(isAnalyticsEnabled()).toBe(false);
    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
  });

  it("shutdownAnalytics resolves when no client was initialised", async () => {
    const { shutdownAnalytics } = await import("../src/analytics/index.js");
    await expect(shutdownAnalytics()).resolves.toBeUndefined();
  });

  it("before_send leaves events without error fields unchanged", async () => {
    const { initAnalytics } = await import("../src/analytics/index.js");
    await initAnalytics({ projectToken: "token", host: "" });

    const beforeSend = mockPostHog.instances[0]?.options.before_send;
    const event = { distinctId: "x", event: "y" };
    expect(beforeSend?.(event)).toBe(event);
  });

  it("sends AI traces through a client that does not sanitize tool bodies", async () => {
    const { createPostHogAiCapture } = await import("../src/analytics/posthogSink.js");
    const capture = createPostHogAiCapture({ projectToken: "phc_ai", host: "" });
    expect(mockPostHog.PostHog).toHaveBeenCalledWith("phc_ai", {
      flushInterval: 0,
      maxQueueSize: 1000,
      enableExceptionAutocapture: false,
      enableFullAiCapture: true,
    });
    const created = mockPostHog.instances.at(-1);
    expect(created?.options.before_send).toBeUndefined();
    capture.capture({
      distinctId: "installation:1",
      event: "$ai_generation",
      properties: { $ai_input: "repository text", $process_person_profile: false },
    });
    expect(created?.captureAi).toHaveBeenCalledWith({
      distinctId: "installation:1",
      event: "$ai_generation",
      properties: { $ai_input: "repository text", $process_person_profile: false },
    });
  });
});

const MARKER = "[trace content truncated]";

function tracedConfig(extra: Parameters<typeof makeTestConfig>[0] = {}): Config {
  return makeTestConfig({
    ...extra,
    runtime: { role: "worker", ...extra.runtime },
  });
}

function traceModel(cost: Model<Api>["cost"]): Model<"openai-responses"> {
  return {
    id: "trace-model",
    name: "trace-model",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "http://localhost",
    reasoning: true,
    input: ["text"],
    cost,
    contextWindow: 10000,
    maxTokens: 1000,
  };
}

type Api = "openai-responses";

function assistant(text: string, thinking = "trace-thinking", costTotal = 0): AssistantMessage {
  const model = traceModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function sessionParams(
  cfg: Config,
  tools: PiSessionCreateParams["tools"] = [],
): PiSessionCreateParams {
  return {
    cfg,
    role: "ask",
    primary: { provider: "openai", model: "trace-model" },
    thinkingPolicy: DEFAULT_THINKING_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    compactionPolicy: { enabled: false },
    promptCachePolicy: { retention: "short" },
    systemPrompt: "trace-system",
    tools,
    executors: {},
    eventSink: () => undefined,
  };
}

function work(executionId: string = randomUUID()): TraceWork {
  return {
    executionId,
    workItemId: "work-item-1",
    owner: "acme",
    repo: "app",
    prNumber: 4,
    headSha: "abc123",
    installationId: 7,
    provider: "openai",
    model: "trace-model",
  };
}

describe("posthog ai traces", () => {
  let drain: () => Promise<void> = async () => undefined;

  afterEach(async () => {
    await drain();
    drain = async () => undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function install(capture: AiCapture, cfg = tracedConfig({ posthog: { projectToken: "phc" } })) {
    drain = initTraces(cfg, capture);
  }

  it("keeps text and reasoning when a long transcript exceeds the event budget", async () => {
    const seen: Array<Record<string, unknown>> = [];
    install({
      capture(input) {
        seen.push(input.properties);
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    });
    const model = traceModel({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
    const cfg = tracedConfig();
    const chunk = "r".repeat(128 * 1024);
    await startWorkTrace(work(), async () => {
      const trace = createSessionTrace(sessionParams(cfg), model, "session-1", () => 1);
      trace.beginSend({ phase: "ask", checkpointId: "cp" });
      for (let index = 0; index < 10; index += 1) {
        trace.event({
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId: `call-${index}`,
            toolName: "read_file",
            content: [{ type: "text", text: chunk }],
            isError: false,
            timestamp: 1,
          },
        });
      }
      trace.event({ type: "turn_start" });
      trace.event({
        type: "message_end",
        message: assistant("kept-answer", "kept-thinking", 0.02),
      });
      trace.dispose();
    });
    await drain();
    const generation = seen.find((event) => event.$ai_span_name === "generation");
    expect(generation).toBeDefined();
    expect(JSON.stringify(generation?.$ai_output_choices)).toContain("kept-answer");
    expect(JSON.stringify(generation?.$ai_output_choices)).toContain("kept-thinking");
    expect(JSON.stringify(generation?.$ai_input)).toContain(MARKER);
    expect(Buffer.byteLength(JSON.stringify(generation))).toBeLessThanOrEqual(TRACE_EVENT_BYTES);
    for (const event of seen) {
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(TRACE_EVENT_BYTES);
    }
  });

  it("sends the full transcript on the next generation and omits unknown cost", async () => {
    const seen: Array<Record<string, unknown>> = [];
    install({
      capture(input) {
        seen.push(input.properties);
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    });
    const cfg = tracedConfig();
    const model = traceModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    await startWorkTrace(work("exec-1"), async () => {
      const trace = createSessionTrace(
        sessionParams(cfg, [
          {
            name: "read_file",
            description: "Read a file",
            parameters: toToolParameters(v.object({})),
          },
        ]),
        model,
        "session-1",
        () => 3,
      );
      trace.beginSend({ phase: "ask", checkpointId: "cp-1" });
      trace.event({
        type: "message_start",
        message: { role: "user", content: "question-one", timestamp: 1 },
      });
      trace.event({ type: "turn_start" });
      trace.event({ type: "message_end", message: assistant("answer-one") });
      trace.event({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read_file",
        args: { path: "src/app.ts" },
      });
      trace.event({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read_file",
        isError: false,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                accepted: false,
                file: "src/app.ts",
                startLine: 9,
                endLine: 12,
              }),
            },
          ],
        },
      });
      trace.event({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read_file",
          content: [{ type: "text", text: "tool-body" }],
          isError: false,
          timestamp: 1,
        },
      });
      trace.event({
        type: "message_start",
        message: { role: "user", content: "question-two", timestamp: 2 },
      });
      trace.event({ type: "turn_start" });
      trace.event({ type: "message_end", message: assistant("answer-two") });
      trace.endSend("complete");
      trace.dispose();
    });
    await drain();
    const generations = seen.filter((event) => event.$ai_span_name === "generation");
    expect(generations).toHaveLength(2);
    const second = JSON.stringify(generations[1]?.$ai_input);
    expect(second).toContain("trace-system");
    expect(second).toContain("question-one");
    expect(second).toContain("answer-one");
    expect(second).toContain("tool-body");
    expect(second).toContain("question-two");
    expect(generations[0]).not.toHaveProperty("$ai_total_cost_usd");
    expect(JSON.stringify(generations[0]?.$ai_tools)).toContain("read_file");
    const tool = seen.find((event) => event.$ai_span_name === "tool:read_file");
    expect(tool?.$ai_is_error).toBe(true);
    expect(JSON.stringify(tool?.$ai_output_state)).toContain("src/app.ts");
    expect(JSON.stringify(tool?.$ai_output_state)).toContain("12");
    expect(tool?.$ai_model).toBe("trace-model");
    expect(seen.every((event) => event.$ai_trace_id === "exec-1")).toBe(true);
    expect(seen.every((event) => event.$ai_session_id === "work-item-1")).toBe(true);
    expect(seen.every((event) => event.$process_person_profile === false)).toBe(true);
    expect(seen[0]?.$ai_model).toBe("trace-model");
  });

  it("shares one execution across specialists and starts a new trace per retry", async () => {
    const seen: Array<Record<string, unknown>> = [];
    install({
      capture(input) {
        seen.push({ ...input.properties, distinctId: input.distinctId });
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    });
    const cfg = tracedConfig();
    const model = traceModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const first = work("exec-a");
    await startWorkTrace(first, async () => {
      await Promise.all(
        ["correctness", "security", "quality", "tests"].map(async (specialist) => {
          const trace = createSessionTrace(
            { ...sessionParams(cfg), role: "specialist", specialistId: specialist },
            model,
            `session-${specialist}`,
            () => 1,
          );
          trace.dispose();
        }),
      );
    });
    await startWorkTrace({ ...first, executionId: "exec-b" }, async () => {
      const trace = createSessionTrace(sessionParams(cfg), model, "session-retry", () => 1);
      trace.dispose();
    });
    await drain();
    const firstEvents = seen.filter((event) => event.$ai_trace_id === "exec-a");
    const secondEvents = seen.filter((event) => event.$ai_trace_id === "exec-b");
    expect(new Set(firstEvents.map((event) => event.session_role))).toEqual(
      new Set(["specialist", undefined]),
    );
    expect(firstEvents.every((event) => event.$ai_session_id === "work-item-1")).toBe(true);
    expect(secondEvents.every((event) => event.$ai_session_id === "work-item-1")).toBe(true);
    expect(seen.every((event) => event.distinctId === "installation:7")).toBe(true);
  });

  it("drops a queued span without sending repository text when the buffer is full", async () => {
    const warning = vi.spyOn(evlog, "logWarn");
    const seen: unknown[] = [];
    install({
      capture() {
        seen.push(true);
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    });
    const cfg = tracedConfig();
    const model = traceModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    for (let index = 0; index < 201; index += 1) {
      const trace = createSessionTrace(sessionParams(cfg), model, `session-${index}`, () => 1);
      trace.dispose();
    }
    expect(warning).toHaveBeenCalledWith("agent_trace_span_dropped", { bytes: expect.any(Number) });
    await drain();
    expect(seen).toHaveLength(400);
  });

  it("keeps the queue bounded when a flush never settles", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(evlog, "logWarn");
    let captured = 0;
    install({
      capture() {
        captured += 1;
      },
      flush: () => new Promise(() => undefined),
      shutdown: async () => undefined,
    });
    const cfg = tracedConfig();
    const model = traceModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    createSessionTrace(sessionParams(cfg), model, "session-hung", () => 1).dispose();
    await vi.advanceTimersByTimeAsync(500);
    for (let index = 0; index < 201; index += 1) {
      createSessionTrace(sessionParams(cfg), model, `session-more-${index}`, () => 1).dispose();
    }
    expect(captured).toBe(2);
    expect(warning).toHaveBeenCalledWith("agent_trace_span_dropped", { bytes: expect.any(Number) });
    const pending = drain();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    drain = async () => undefined;
  });

  it("redacts credentials and gives a standalone session a null work item", async () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\ntrace-key\n-----END PRIVATE KEY-----";
    const seen: Array<Record<string, unknown>> = [];
    const cfg = tracedConfig({
      runtime: { databaseUrl: "postgres://user:trace-pass@localhost/db" },
      github: { privateKey },
      webhook: { secret: "trace-hook" },
      posthog: { projectToken: "trace-posthog" },
    });
    install(
      {
        capture(input) {
          seen.push({ ...input.properties, distinctId: input.distinctId });
        },
        flush: async () => undefined,
        shutdown: async () => undefined,
      },
      cfg,
    );
    const model = traceModel({ input: 2, output: 2, cacheRead: 0, cacheWrite: 0 });
    const trace = createSessionTrace(
      {
        ...sessionParams(cfg),
        systemPrompt: `system ${privateKey} ghp_abcdefghijklmnopqrstuvwxyz012345`,
      },
      model,
      "standalone",
      () => 1,
    );
    trace.addSecret("trace-installation-token");
    trace.beginSend({ phase: "ci_summary", checkpointId: "ci" });
    trace.event({ type: "turn_start" });
    trace.event({
      type: "message_end",
      message: assistant(
        "answer sk_live_abcdefghijklmnopqrstuvwxyz trace-installation-token",
        "trace-thinking",
        0.02,
      ),
    });
    trace.dispose();
    await drain();
    const body = JSON.stringify(seen);
    expect(body).not.toContain("trace-key");
    expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(body).not.toContain("sk_live_abcdefghijklmnopqrstuvwxyz");
    expect(body).not.toContain("trace-installation-token");
    expect(body).not.toContain("trace-pass");
    expect(body).toContain("[redacted]");
    expect(seen.every((event) => event.$ai_session_id == null)).toBe(true);
    expect(seen.every((event) => event.distinctId === "pr-agent")).toBe(true);
    const generation = seen.find((event) => event.$ai_span_name === "generation");
    expect(generation?.$ai_total_cost_usd).toBeGreaterThan(0);
  });

  it("records nothing without a token and ignores the web process", async () => {
    const seen: unknown[] = [];
    const capture: AiCapture = {
      capture() {
        seen.push(true);
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    };
    drain = initTraces(tracedConfig({ posthog: { projectToken: "" } }));
    createSessionTrace(
      sessionParams(tracedConfig()),
      traceModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      "silent",
      () => 1,
    ).dispose();
    drain = initTraces(
      makeTestConfig({ runtime: { role: "web" }, posthog: { projectToken: "phc" } }),
      capture,
    );
    createSessionTrace(
      sessionParams(makeTestConfig()),
      traceModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      "web",
      () => 1,
    ).dispose();
    await drain();
    expect(seen).toEqual([]);
  });
});
