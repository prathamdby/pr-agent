import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { processWebhookPostRequestEffect } from "../src/effect/programs/processWebhookRequestEffect.js";
import * as evlog from "../src/evlog.js";
import * as appAuth from "../src/github/appAuth.js";
import { makeTestConfig } from "./helpers/config.js";

const settingsOverrides: { timeout?: number } = {};
vi.mock("../src/settings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/index.js")>();
  return {
    ...actual,
    get WEBHOOK_TIMEOUT_MS() {
      return settingsOverrides.timeout ?? actual.WEBHOOK_TIMEOUT_MS;
    },
  };
});
const cfg = makeTestConfig({ webhookSecret: "secret" });
function request(event: string, body: Buffer, signature = true) {
  return {
    headers: {
      "x-github-event": event,
      "x-github-delivery": "d1",
      "x-hub-signature-256": signature
        ? `sha256=${crypto.createHmac("sha256", cfg.webhookSecret).update(body).digest("hex")}`
        : "sha256=bad",
    },
    rawBody: body,
  };
}
function run(
  req: Parameters<typeof processWebhookPostRequestEffect>[1],
  submit: AgentWorkScheduler["Service"]["submit"],
) {
  return Effect.runPromise(
    processWebhookPostRequestEffect(
      cfg,
      req,
      evlog.createOperationLogger({ method: "POST", path: "/webhooks" }),
    ).pipe(
      Effect.provide(
        Layer.succeed(AgentWorkScheduler, { submit, ping: () => Effect.succeed(true) }),
      ),
    ),
  );
}
describe("webhook request admission boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete settingsOverrides.timeout;
  });
  it.each([
    ["ping", "{}", false, 401, "invalid signature"],
    ["ping", "{", false, 401, "invalid signature"],
    ["ping", "{", true, 400, "invalid json"],
    [
      "pull_request",
      JSON.stringify({
        action: "opened",
        installation: { id: 1 },
        repository: { owner: { login: "o" }, name: "r" },
        pull_request: { number: 1.5, head: { sha: "a" } },
      }),
      true,
      422,
      "unprocessable entity",
    ],
    [
      "pull_request",
      JSON.stringify({
        action: "opened",
        installation: { id: 1 },
        repository: { owner: { login: "o" }, name: "r" },
        pull_request: { number: 2147483648, head: { sha: "a" } },
      }),
      true,
      422,
      "unprocessable entity",
    ],
    [
      "pull_request",
      JSON.stringify({
        action: "opened",
        installation: { id: 1 },
        repository: { owner: { login: "o" }, name: "r" },
        pull_request: { number: "bad", head: { sha: "a" } },
      }),
      true,
      422,
      "unprocessable entity",
    ],
  ] as const)(
    "rejects %s before durable submission: status=%s",
    async (event, body, signature, status, responseBody) => {
      const submit = vi.fn(() => Effect.void);
      expect(await run(request(event, Buffer.from(body), signature), submit)).toEqual({
        status,
        body: responseBody,
      });
      expect(submit).not.toHaveBeenCalled();
    },
  );
  it("waits for durable submission before 200", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let responded = false;
    const result = run(request("ping", Buffer.from("{}")), () =>
      Effect.promise(() => {
        entered = true;
        return gate;
      }),
    ).then((value) => {
      responded = true;
      return value;
    });
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(responded).toBe(false);
    } finally {
      release();
    }
    expect(await result).toEqual({ status: 200, body: "ok" });
  });
  it("returns 503 and preserves the scheduler error channel", async () => {
    const record = vi.spyOn(evlog, "recordEvent");
    expect(
      await run(request("ping", Buffer.from("{}")), () =>
        Effect.fail(new Error("scheduler failed")),
      ),
    ).toEqual({ status: 503, body: "service unavailable" });
    expect(
      record.mock.calls.some(
        (call) => call[1] === "webhook_handler_error" && call[2]?.message === "scheduler failed",
      ),
    ).toBe(true);
  });
  it("returns 503 and the existing timeout fields", async () => {
    settingsOverrides.timeout = 1;
    const record = vi.spyOn(evlog, "recordEvent");
    expect(await run(request("ping", Buffer.from("{}")), () => Effect.sleep("20 millis"))).toEqual({
      status: 503,
      body: "service unavailable",
    });
    expect(
      record.mock.calls.find((call) => call[1] === "webhook_timeout_budget_exceeded")?.[2],
    ).toMatchObject({ budgetMs: 1, responseBudgetMs: 1 });
  });
  it("keeps bot authentication failure ahead of association rejection", async () => {
    vi.spyOn(appAuth, "getAppBotIdentity").mockRejectedValue("auth failed");
    const body = Buffer.from(
      JSON.stringify({
        action: "created",
        installation: { id: 1 },
        repository: { owner: { login: "o" }, name: "r" },
        issue: { number: 3, pull_request: {} },
        comment: { id: 99, user: { id: 7 }, author_association: "NONE", body: "/review" },
      }),
    );
    const submit = vi.fn(() => Effect.void);
    expect(await run(request("issue_comment", body), submit)).toEqual({
      status: 503,
      body: "service unavailable",
    });
    expect(submit).not.toHaveBeenCalled();
  });
  it("returns 200 without waiting for successful log emission", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const emit = vi.spyOn(evlog, "emitOperationLogger").mockImplementation(async () => gate);
    try {
      expect(await run(request("ping", Buffer.from("{}")), () => Effect.void)).toEqual({
        status: 200,
        body: "ok",
      });
      expect(emit).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });
});
