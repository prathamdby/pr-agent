import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { createOperationLogger } from "../src/evlog.js";
import { applySlashCommandIntake } from "../src/agentWork/intake/slashIntake.js";
import { ACK_QUEUE, FIX_QUEUE, FIX_USAGE_HINT } from "../src/settings/index.js";
import type { SlashCommandInput } from "../src/agentWork/intake/applier.js";

function makeInput(overrides: Partial<SlashCommandInput> = {}): SlashCommandInput {
  return {
    headers: {
      event: "pull_request_review_comment",
      delivery: "delivery-1",
      rawBody: Buffer.from("{}"),
    },
    installationId: 42,
    owner: "acme",
    repo: "app",
    repositorySizeKb: 100,
    prNumber: 7,
    commentId: 101,
    commenterId: 9,
    commenterLogin: "dev",
    body: "/fix",
    command: "fix",
    replyTarget: {
      kind: "inlineReviewThread",
      prNumber: 7,
      inReplyToCommentId: 101,
    },
    inlineReplyToCommentId: 55,
    ...overrides,
  };
}

function makeClient() {
  const insertedWorkPayloads: unknown[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-1" }], rowCount: 1 };
      }
      if (sql.includes("FROM agent_work_items")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO agent_work_items")) {
        insertedWorkPayloads.push(JSON.parse(String(params?.at(-1))));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 100)}`);
    }),
  } as unknown as PoolClient;
  return { client, insertedWorkPayloads };
}

describe("slash auto-fix intake", () => {
  it("queues /fix against the original inline review comment id", async () => {
    const sentJobs: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const { client, insertedWorkPayloads } = makeClient();

    await applySlashCommandIntake(
      boss,
      client,
      makeInput(),
      createOperationLogger({ method: "POST", path: "/webhooks" }),
    );

    expect(sentJobs.map((job) => job.queue)).toEqual([ACK_QUEUE, FIX_QUEUE]);
    expect(insertedWorkPayloads).toEqual([
      expect.objectContaining({
        selector: { kind: "inline", inlineReviewCommentId: 55 },
        commenterLogin: "dev",
        commandCommentId: 101,
      }),
    ]);
  });

  it("rejects /fix outside an inline reply before creating work", async () => {
    const sentJobs: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const { client, insertedWorkPayloads } = makeClient();

    await applySlashCommandIntake(
      boss,
      client,
      makeInput({ inlineReplyToCommentId: undefined }),
      createOperationLogger({ method: "POST", path: "/webhooks" }),
    );

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.data.reply).toEqual({
      target: makeInput().replyTarget,
      body: FIX_USAGE_HINT,
    });
    expect(insertedWorkPayloads).toEqual([]);
  });
});
