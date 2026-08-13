import { describe, expect, it, vi } from "vitest";
import {
  applySlashCommandIntake,
  type SlashCommandInput,
} from "../src/agentWork/intake/slashIntake.js";
import type { AckJobData } from "../src/agentWork/types.js";
import { slashDisabledBody } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import { createQueryClient } from "./helpers/fakePool.js";
import { createRecordingBoss, type RecordedBossJob } from "./helpers/recordingBoss.js";

const features = makeTestConfig().features;

function makeInput(command: string): SlashCommandInput {
  return {
    headers: {
      event: "issue_comment",
      delivery: `d-${command}`,
      rawBody: Buffer.from("{}"),
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
  };
}

function makeClient() {
  return createQueryClient(
    vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-1" }] };
      }
      if (sql.includes("INSERT INTO agent_work_items")) {
        return { rows: [{ id: "work-1" }] };
      }
      return { rows: [] };
    }),
  );
}

function ackData(jobs: readonly RecordedBossJob[]): AckJobData {
  const data = jobs[0]?.data;
  expect(data?.kind).toBe("ack");
  if (data?.kind !== "ack") {
    throw new Error("expected ack job");
  }
  return data;
}

describe("slash command feature gating", () => {
  it.each(["ask", "describe", "triage"] as const)(
    "replies with a disabled notice for /%s when its feature is off",
    async (command) => {
      const sent: RecordedBossJob[] = [];
      const boss = createRecordingBoss(sent);
      const offFeatures = {
        ...features,
        ask: "off",
        describe: "off",
        triage: "off",
      } as const;

      const events = await applySlashCommandIntake(
        boss,
        makeClient(),
        makeInput(command),
        offFeatures,
      );

      expect(events.map((event) => event.name)).toContain("ignored_disabled_slash_command");
      const ack = ackData(sent);
      expect(ack.reply?.body).toBe(slashDisabledBody(command));
    },
  );

  it("still enqueues /review when all other features are off", async () => {
    const sent: RecordedBossJob[] = [];
    const boss = createRecordingBoss(sent);

    const events = await applySlashCommandIntake(boss, makeClient(), makeInput("review"), {
      ...features,
      ask: "off",
      describe: "off",
      triage: "off",
    });

    expect(events.map((event) => event.name)).toContain("agent_work_enqueued");
  });

  it("enqueues /describe normally when the feature is manual", async () => {
    const sent: RecordedBossJob[] = [];
    const boss = createRecordingBoss(sent);

    const events = await applySlashCommandIntake(boss, makeClient(), makeInput("describe"), {
      ...features,
      describe: "manual",
    });

    expect(events.map((event) => event.name)).toContain("agent_work_enqueued");
  });
});
