import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  appendAgentEvents,
  listAgentEventsByWorkItem,
  safeAppendAgentEvents,
  type AgentEventInsertRow,
} from "../src/agentWork/agentEventsRepository.js";

function sampleRow(overrides: Partial<AgentEventInsertRow> = {}): AgentEventInsertRow {
  return {
    workItemId: "wi-1",
    installationId: 42,
    owner: "acme",
    repo: "app",
    prNumber: 7,
    sessionRole: "orchestrator",
    eventKind: "turn",
    phase: "recon",
    checkpointId: "orchestrator:recon",
    provider: "openai",
    model: "gpt-4o-mini",
    detail: { attempt: 1 },
    ...overrides,
  };
}

describe("appendAgentEvents", () => {
  it("batch inserts rows with metadata detail", async () => {
    const query = vi.fn(async () => ({ rowCount: 2 }));
    const pool = { query } as unknown as Pool;

    await appendAgentEvents(pool, [sampleRow(), sampleRow({ eventKind: "tool", toolName: "readFile" })]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO agent_events");
    expect(values).toHaveLength(30);
    expect(values[6]).toBe("turn");
    expect(values[14]).toBe('{"attempt":1}');
  });

  it("skips empty batches", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    await appendAgentEvents(pool, []);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("safeAppendAgentEvents", () => {
  it("does nothing when disabled", () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    safeAppendAgentEvents(pool, { agentEventsEnabled: false }, [sampleRow()]);
    expect(query).not.toHaveBeenCalled();
  });

  it("logs and swallows writer failures", async () => {
    const query = vi.fn(async () => {
      throw new Error("db down");
    });
    const pool = { query } as unknown as Pool;
    safeAppendAgentEvents(pool, { agentEventsEnabled: true }, [sampleRow()]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("listAgentEventsByWorkItem", () => {
  it("maps rows for a work item", async () => {
    const recordedAt = new Date("2026-07-26T00:00:00.000Z");
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "evt-1",
          work_item_id: "wi-1",
          installation_id: "42",
          owner: "acme",
          repo: "app",
          pr_number: 7,
          session_role: "orchestrator",
          event_kind: "decision",
          phase: "judgment",
          checkpoint_id: null,
          tool_name: null,
          provider: null,
          model: null,
          ok: null,
          failure_code: null,
          detail: { acceptedCount: 2 },
          recorded_at: recordedAt,
        },
      ],
    }));
    const pool = { query } as unknown as Pool;

    const rows = await listAgentEventsByWorkItem(pool, "wi-1");
    expect(rows).toEqual([
      {
        id: "evt-1",
        workItemId: "wi-1",
        installationId: 42,
        owner: "acme",
        repo: "app",
        prNumber: 7,
        sessionRole: "orchestrator",
        eventKind: "decision",
        phase: "judgment",
        checkpointId: null,
        toolName: null,
        provider: null,
        model: null,
        ok: null,
        failureCode: null,
        detail: { acceptedCount: 2 },
        recordedAt,
      },
    ]);
  });
});
