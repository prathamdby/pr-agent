import { afterEach, describe, expect, it } from "vitest";
import type { AckJobData, SlashCommandInput } from "../src/agentWork/types.ts";
import { runDelivery } from "../src/state/intake.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { openSqliteAppState } from "./integration/db.ts";

const baseCfg = makeTestConfig();
const features = baseCfg.features;

function makeInput(command: string) {
  return ((pinnedReturn: SlashCommandInput) => pinnedReturn)({
    headers: {
      event: "issue_comment",
      delivery: `d-${command}-${Math.random()}`,
      rawBody: Buffer.from(`{"command":"${command}"}`),
    },
    installationId: 42,
    owner: "acme",
    repo: "app",
    prNumber: 7,
    commentId: 1000,
    commenterId: 11,
    body: `/${command}`,
    command,
    replyTarget: { kind: "prConversation", prNumber: 7 },
  });
}

describe("slash command feature gating", () => {
  const handles: Array<{ close: () => void }> = [];

  function openDb() {
    const handle = openSqliteAppState();
    handles.push(handle);
    return handle.db;
  }

  afterEach(() => {
    while (handles.length > 0) handles.pop()?.close();
  });

  it.each(["ask", "describe", "triage", "verify"] as const)(
    "replies with a disabled notice for /%s when its feature is off",
    (command) => {
      const db = openDb();
      const offFeatures = {
        ...features,
        ask: "off",
        describe: "off",
        triage: "off",
        verification: "off",
      } as const;

      const result = runDelivery(
        db,
        { features: offFeatures, ask: baseCfg.ask },
        { kind: "slash", input: makeInput(command) },
        1_700_000_000_000,
      );

      expect(result.events.map((event) => event.name)).toContain("ignored_disabled_slash_command");
      const ackRow = db.prepare(`SELECT payload_json FROM work_runs WHERE kind = 'ack'`).get() as
        | { payload_json: string }
        | undefined;
      expect(ackRow).toBeDefined();
      const ack = JSON.parse(ackRow?.payload_json ?? "{}") as AckJobData;
      expect(ack.reply?.body).toBe(
        `\`/${command}\` is disabled on this deployment (\`FEATURE_*\` settings; see docs/features.md).`,
      );
    },
  );

  it("still enqueues /review when all other features are off", () => {
    const db = openDb();
    const result = runDelivery(
      db,
      {
        features: { ...features, ask: "off", describe: "off", triage: "off" },
        ask: baseCfg.ask,
      },
      { kind: "slash", input: makeInput("review") },
      1_700_000_000_000,
    );

    expect(result.events.map((event) => event.name)).toContain("agent_work_enqueued");
  });

  it("enqueues /describe normally when the feature is manual", () => {
    const db = openDb();
    const result = runDelivery(
      db,
      {
        features: { ...features, describe: "manual" },
        ask: baseCfg.ask,
      },
      { kind: "slash", input: makeInput("describe") },
      1_700_000_000_000,
    );

    expect(result.events.map((event) => event.name)).toContain("agent_work_enqueued");
  });

  it.each(["manual", "auto"] as const)(
    "enqueues /verify normally when verification is %s",
    (mode) => {
      const db = openDb();
      const result = runDelivery(
        db,
        {
          features: { ...features, verification: mode },
          ask: baseCfg.ask,
        },
        { kind: "slash", input: makeInput("verify") },
        1_700_000_000_000,
      );

      expect(result.events.map((event) => event.name)).toContain("agent_work_enqueued");
    },
  );
});
