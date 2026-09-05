import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  admitAsk,
  createAskExecutionId,
  defaultAskQuotaConfig,
  recordAskProviderUsage,
  releaseAskQuotaReservation,
  type AskQuotaConfig,
} from "../src/agentWork/askQuota.js";
import { AppError } from "../src/errors/appError.js";

type Bucket = {
  scope: string;
  scope_key: string;
  token_balance: number;
  last_refill_at: Date;
  outstanding_count: number;
  provider_tokens_used: number;
  provider_tokens_reserved: number;
  provider_window_started_at: Date;
};

type Reservation = {
  work_item_id: string;
  actor_scope_key: string;
  repository_scope_key: string;
  installation_scope_key: string;
  reserved_provider_tokens: number;
  provider_usage_known: boolean;
  provider_tokens_used: number;
  unknown_usage_charged: number;
  unknown_usage_window_started_at: Date | null;
  released_at: Date | null;
};

type Receipt = {
  work_item_id: string;
  execution_id: string;
  provider_tokens_used: number;
};

function keyPart(value: unknown): string {
  return String(value);
}

class FakeQuotaClient {
  readonly buckets = new Map<string, Bucket>();
  readonly reservations = new Map<string, Reservation>();
  readonly receipts = new Map<string, Receipt>();

  async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = sql.replaceAll(/\s+/g, " ");
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], rowCount: 0 };

    if (text.includes("INSERT INTO ask_quota_buckets")) {
      const scope = String(values[0]);
      const scopeKey = String(values[1]);
      const key = `${scope}:${scopeKey}`;
      if (!this.buckets.has(key)) {
        this.buckets.set(key, {
          scope,
          scope_key: scopeKey,
          token_balance: Number(values[2]),
          last_refill_at: new Date(),
          outstanding_count: 0,
          provider_tokens_used: 0,
          provider_tokens_reserved: 0,
          provider_window_started_at: new Date(),
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("FROM ask_quota_buckets") && text.includes("FOR UPDATE")) {
      if (text.includes("scope = 'installation'")) {
        const bucket = this.buckets.get(`installation:${keyPart(values[0])}`);
        return { rows: bucket ? [bucket] : [], rowCount: bucket ? 1 : 0 };
      }
      const bucket = this.buckets.get(`${keyPart(values[0])}:${keyPart(values[1])}`);
      return { rows: bucket ? [bucket] : [], rowCount: bucket ? 1 : 0 };
    }

    if (text.includes("UPDATE ask_quota_buckets")) {
      if (text.includes("provider_tokens_used = GREATEST(0, provider_tokens_used + $3)")) {
        const bucket = this.buckets.get(`installation:${keyPart(values[0])}`);
        if (!bucket) return { rows: [], rowCount: 0 };
        bucket.provider_tokens_reserved = Math.max(
          0,
          bucket.provider_tokens_reserved - Number(values[1]),
        );
        bucket.provider_tokens_used = Math.max(0, bucket.provider_tokens_used + Number(values[2]));
        return { rows: [{ scope_key: bucket.scope_key }], rowCount: 1 };
      }

      if (text.includes("provider_tokens_reserved = provider_tokens_reserved + $2")) {
        const bucket = this.buckets.get(`installation:${keyPart(values[0])}`);
        if (!bucket) return { rows: [], rowCount: 0 };
        bucket.provider_tokens_reserved += Number(values[1]);
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("outstanding_count = outstanding_count + 1")) {
        const bucket = this.buckets.get(`${keyPart(values[0])}:${keyPart(values[1])}`);
        if (!bucket) return { rows: [], rowCount: 0 };
        bucket.token_balance = Number(values[2]);
        bucket.outstanding_count += 1;
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("provider_tokens_used = $4")) {
        const bucket = this.buckets.get(`${keyPart(values[0])}:${keyPart(values[1])}`);
        if (!bucket) return { rows: [], rowCount: 0 };
        bucket.token_balance = Number(values[2]);
        bucket.provider_tokens_used = Number(values[3]);
        bucket.provider_window_started_at = values[4] as Date;
        bucket.last_refill_at = new Date();
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("outstanding_count = GREATEST")) {
        const bucket = this.buckets.get(`${keyPart(values[0])}:${keyPart(values[1])}`);
        if (!bucket) return { rows: [], rowCount: 0 };
        bucket.outstanding_count = Math.max(0, bucket.outstanding_count - 1);
        bucket.provider_tokens_reserved = Math.max(
          0,
          bucket.provider_tokens_reserved - Number(values[2]),
        );
        return { rows: [], rowCount: 1 };
      }
    }

    if (text.includes("INSERT INTO ask_quota_reservations")) {
      const [workItemId, actor, repository, installation, reserved] = values;
      this.reservations.set(String(workItemId), {
        work_item_id: String(workItemId),
        actor_scope_key: String(actor),
        repository_scope_key: String(repository),
        installation_scope_key: String(installation),
        reserved_provider_tokens: Number(reserved),
        provider_usage_known: false,
        provider_tokens_used: 0,
        unknown_usage_charged: 0,
        unknown_usage_window_started_at: null,
        released_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("FROM ask_quota_execution_receipts") && text.includes("FOR UPDATE")) {
      const receipt = this.receipts.get(`${keyPart(values[0])}:${keyPart(values[1])}`);
      return { rows: receipt ? [receipt] : [], rowCount: receipt ? 1 : 0 };
    }

    if (text.includes("INSERT INTO ask_quota_execution_receipts")) {
      const [workItemId, executionId, tokens] = values;
      this.receipts.set(`${String(workItemId)}:${String(executionId)}`, {
        work_item_id: String(workItemId),
        execution_id: String(executionId),
        provider_tokens_used: Number(tokens),
      });
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("FROM ask_quota_reservations") && text.includes("FOR UPDATE")) {
      const reservation = this.reservations.get(String(values[0]));
      if (text.includes("SELECT actor_scope_key")) {
        return { rows: reservation ? [reservation] : [], rowCount: reservation ? 1 : 0 };
      }
      return {
        rows: reservation
          ? [
              {
                installation_scope_key: reservation.installation_scope_key,
                reserved_provider_tokens: reservation.reserved_provider_tokens,
                provider_usage_known: reservation.provider_usage_known,
                released_at: reservation.released_at,
                unknown_usage_charged: reservation.unknown_usage_charged,
                unknown_usage_window_started_at: reservation.unknown_usage_window_started_at,
              },
            ]
          : [],
        rowCount: reservation ? 1 : 0,
      };
    }

    if (text.includes("UPDATE ask_quota_reservations")) {
      const reservation = this.reservations.get(String(values[0]));
      if (!reservation) return { rows: [], rowCount: 0 };
      if (text.includes("unknown_usage_charged = 0")) {
        reservation.provider_usage_known = true;
        reservation.provider_tokens_used += Number(values[1]);
        reservation.reserved_provider_tokens = 0;
        reservation.unknown_usage_charged = 0;
      } else if (text.includes("provider_usage_known = true")) {
        reservation.provider_usage_known = true;
        reservation.provider_tokens_used += Number(values[1]);
      } else {
        reservation.released_at = new Date();
      }
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`unexpected quota query: ${text}`);
  }

  pool(): Pool {
    return {
      connect: vi.fn(async () => ({
        query: this.query.bind(this),
        release: vi.fn(),
      })),
    } as unknown as Pool;
  }
}

function config(overrides: Partial<AskQuotaConfig> = {}): AskQuotaConfig {
  return {
    ...defaultAskQuotaConfig(),
    askActorMaxOutstanding: 2,
    askRepositoryMaxOutstanding: 10,
    askInstallationMaxOutstanding: 20,
    askActorBurst: 100,
    askRepositoryBurst: 100,
    askInstallationBurst: 100,
    askActorRefillSeconds: 100_000,
    askRepositoryRefillSeconds: 100_000,
    askInstallationRefillSeconds: 100_000,
    ...overrides,
  };
}

function admission(
  client: FakeQuotaClient,
  workItemId: string,
  commenterId = 7,
  repo = "app",
  quota: AskQuotaConfig = config(),
) {
  return admitAsk(
    client as never,
    {
      workItemId,
      installationId: 9,
      owner: "Acme",
      repo,
      commenterId,
    },
    quota,
  );
}

describe("ask admission quotas", () => {
  it("bounds repeated asks and releases outstanding capacity", async () => {
    const client = new FakeQuotaClient();

    await expect(admission(client, "ask-1")).resolves.toMatchObject({ kind: "admitted" });
    await expect(admission(client, "ask-2")).resolves.toMatchObject({ kind: "admitted" });
    await expect(admission(client, "ask-3")).resolves.toEqual({
      kind: "throttled",
      reason: "actor_outstanding",
    });

    await releaseAskQuotaReservation(client as never, "ask-1");
    await expect(admission(client, "ask-4")).resolves.toMatchObject({ kind: "admitted" });
    expect(client.buckets.get("actor:actor:9:7")?.outstanding_count).toBe(2);
  });

  it("keeps actor, repository, and installation limits isolated and ordered", async () => {
    const client = new FakeQuotaClient();
    const limited = config({
      askActorMaxOutstanding: 1,
      askRepositoryMaxOutstanding: 2,
      askInstallationMaxOutstanding: 3,
    });
    const admit = (id: string, commenterId: number, repo: string) =>
      admitAsk(
        client as never,
        { workItemId: id, installationId: 9, owner: "Acme", repo, commenterId },
        limited,
      );

    await expect(admit("ask-1", 7, "app")).resolves.toMatchObject({ kind: "admitted" });
    await expect(admit("ask-2", 7, "other")).resolves.toEqual({
      kind: "throttled",
      reason: "actor_outstanding",
    });
    await expect(admit("ask-3", 8, "app")).resolves.toMatchObject({ kind: "admitted" });
    await expect(admit("ask-4", 9, "app")).resolves.toEqual({
      kind: "throttled",
      reason: "repository_outstanding",
    });
    await expect(admit("ask-5", 10, "other")).resolves.toMatchObject({ kind: "admitted" });
    await expect(admit("ask-6", 11, "third")).resolves.toEqual({
      kind: "throttled",
      reason: "installation_outstanding",
    });
  });

  it("throttles empty rate buckets, refills them, and clamps at burst", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    try {
      const limited = config({
        askActorBurst: 3,
        askRepositoryBurst: 3,
        askInstallationBurst: 3,
        askActorRefillSeconds: 60,
        askRepositoryRefillSeconds: 60,
        askInstallationRefillSeconds: 60,
      });
      const client = new FakeQuotaClient();
      const emptyBucket = (scope: string, scopeKey: string): Bucket => ({
        scope,
        scope_key: scopeKey,
        token_balance: 0,
        last_refill_at: new Date(Date.now()),
        outstanding_count: 0,
        provider_tokens_used: 0,
        provider_tokens_reserved: 0,
        provider_window_started_at: new Date(Date.now()),
      });

      client.buckets.set("actor:actor:9:7", emptyBucket("actor", "actor:9:7"));
      await expect(admission(client, "ask-rate-actor", 7, "app", limited)).resolves.toEqual({
        kind: "throttled",
        reason: "actor_rate",
      });

      vi.advanceTimersByTime(60_000);
      await expect(
        admitAsk(
          client as never,
          {
            workItemId: "ask-rate-actor-refilled",
            installationId: 9,
            owner: "Acme",
            repo: "app",
            commenterId: 7,
          },
          limited,
        ),
      ).resolves.toMatchObject({ kind: "admitted" });

      client.buckets.set(
        "repository:repository:9:acme/app",
        emptyBucket("repository", "repository:9:acme/app"),
      );
      await expect(
        admitAsk(
          client as never,
          {
            workItemId: "ask-rate-repository",
            installationId: 9,
            owner: "Acme",
            repo: "app",
            commenterId: 8,
          },
          limited,
        ),
      ).resolves.toEqual({ kind: "throttled", reason: "repository_rate" });

      client.buckets.set(
        "installation:installation:9",
        emptyBucket("installation", "installation:9"),
      );
      await expect(
        admitAsk(
          client as never,
          {
            workItemId: "ask-rate-installation",
            installationId: 9,
            owner: "Acme",
            repo: "other",
            commenterId: 9,
          },
          limited,
        ),
      ).resolves.toEqual({ kind: "throttled", reason: "installation_rate" });

      const clampClient = new FakeQuotaClient();
      clampClient.buckets.set("actor:actor:9:7", {
        ...emptyBucket("actor", "actor:9:7"),
        token_balance: 2,
        last_refill_at: new Date(Date.now() - 120_000),
      });
      await expect(
        admission(clampClient, "ask-rate-clamped", 7, "app", limited),
      ).resolves.toMatchObject({
        kind: "admitted",
      });
      expect(clampClient.buckets.get("actor:actor:9:7")?.token_balance).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls an expired provider window on the clock while usage is reserved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    try {
      const client = new FakeQuotaClient();
      const budget = config({
        askProviderBudgetTokens: 10,
        askProviderReservationTokens: 4,
      });
      const straddlerId = "ask-provider-straddler";
      const windowStartedAt = new Date(Date.now());
      client.buckets.set("installation:installation:9", {
        scope: "installation",
        scope_key: "installation:9",
        token_balance: 100,
        last_refill_at: new Date(Date.now()),
        outstanding_count: 1,
        provider_tokens_used: 8,
        provider_tokens_reserved: 4,
        provider_window_started_at: windowStartedAt,
      });
      client.reservations.set(straddlerId, {
        work_item_id: straddlerId,
        actor_scope_key: "actor:9:7",
        repository_scope_key: "repository:9:acme/app",
        installation_scope_key: "installation:9",
        reserved_provider_tokens: 4,
        provider_usage_known: false,
        provider_tokens_used: 0,
        unknown_usage_charged: 0,
        unknown_usage_window_started_at: null,
        released_at: null,
      });

      vi.advanceTimersByTime(budget.askProviderBudgetWindowSeconds * 1000);

      await expect(
        admission(client, "ask-provider-next-window", 8, "app", budget),
      ).resolves.toEqual({ kind: "admitted", providerReservationTokens: 4 });
      expect(client.buckets.get("installation:installation:9")).toMatchObject({
        provider_tokens_used: 0,
        provider_tokens_reserved: 8,
        outstanding_count: 2,
        provider_window_started_at: new Date(Date.now()),
      });
      expect(client.reservations.get(straddlerId)).toMatchObject({
        reserved_provider_tokens: 4,
        provider_usage_known: false,
        released_at: null,
      });

      await recordAskProviderUsage(client.pool(), {
        workItemId: straddlerId,
        executionId: createAskExecutionId(),
        usage: { estimated: false, totalTokens: 3 },
      });
      expect(client.buckets.get("installation:installation:9")).toMatchObject({
        provider_tokens_used: 3,
        provider_tokens_reserved: 4,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles a second same-instant admission after the window rolls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    try {
      const client = new FakeQuotaClient();
      const budget = config({
        askProviderBudgetTokens: 10,
        askProviderReservationTokens: 6,
      });
      client.buckets.set("installation:installation:9", {
        scope: "installation",
        scope_key: "installation:9",
        token_balance: 100,
        last_refill_at: new Date(Date.now()),
        outstanding_count: 1,
        provider_tokens_used: 8,
        provider_tokens_reserved: 4,
        provider_window_started_at: new Date(Date.now()),
      });

      vi.advanceTimersByTime(budget.askProviderBudgetWindowSeconds * 1000);

      await expect(admission(client, "ask-provider-edge-1", 8, "app", budget)).resolves.toEqual({
        kind: "admitted",
        providerReservationTokens: 6,
      });
      await expect(admission(client, "ask-provider-edge-2", 9, "app", budget)).resolves.toEqual({
        kind: "throttled",
        reason: "provider_budget",
      });
      expect(client.buckets.get("installation:installation:9")).toMatchObject({
        provider_tokens_used: 0,
        provider_tokens_reserved: 10,
        provider_window_started_at: new Date(Date.now()),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves provider budget and reconciles exact usage", async () => {
    const client = new FakeQuotaClient();
    const budget = config({
      askProviderBudgetTokens: 10,
      askProviderReservationTokens: 6,
    });

    const first = await admitAsk(
      client as never,
      {
        workItemId: "ask-provider-1",
        installationId: 9,
        owner: "Acme",
        repo: "app",
        commenterId: 7,
      },
      budget,
    );
    expect(first).toEqual({ kind: "admitted", providerReservationTokens: 6 });

    await expect(
      admitAsk(
        client as never,
        {
          workItemId: "ask-provider-2",
          installationId: 9,
          owner: "Acme",
          repo: "app",
          commenterId: 8,
        },
        budget,
      ),
    ).resolves.toEqual({ kind: "throttled", reason: "provider_budget" });

    await recordAskProviderUsage(client.pool(), {
      workItemId: "ask-provider-1",
      executionId: createAskExecutionId(),
      usage: { estimated: false, totalTokens: 4 },
    });
    expect(client.buckets.get("installation:installation:9")).toMatchObject({
      provider_tokens_used: 4,
      provider_tokens_reserved: 0,
    });

    await expect(
      admitAsk(
        client as never,
        {
          workItemId: "ask-provider-3",
          installationId: 9,
          owner: "Acme",
          repo: "app",
          commenterId: 8,
        },
        budget,
      ),
    ).resolves.toEqual({ kind: "admitted", providerReservationTokens: 6 });
  });

  it("floors exact provider usage and ignores unknown usage", async () => {
    const client = new FakeQuotaClient();
    const budget = config({
      askProviderBudgetTokens: 10,
      askProviderReservationTokens: 6,
    });
    const exactId = "ask-provider-floor";
    const executionId = createAskExecutionId();

    await expect(
      admitAsk(
        client as never,
        {
          workItemId: exactId,
          installationId: 9,
          owner: "Acme",
          repo: "app",
          commenterId: 7,
        },
        budget,
      ),
    ).resolves.toMatchObject({ kind: "admitted" });

    await recordAskProviderUsage(client.pool(), {
      workItemId: exactId,
      executionId,
      usage: { estimated: false, totalTokens: 4.7 },
    });
    expect(client.buckets.get("installation:installation:9")).toMatchObject({
      provider_tokens_used: 4,
      provider_tokens_reserved: 0,
    });
    expect(client.reservations.get(exactId)).toMatchObject({
      provider_usage_known: true,
      reserved_provider_tokens: 0,
    });

    await recordAskProviderUsage(client.pool(), {
      workItemId: exactId,
      executionId,
      usage: { estimated: false, totalTokens: 4 },
    });
    expect(client.buckets.get("installation:installation:9")?.provider_tokens_used).toBe(4);

    await expect(
      recordAskProviderUsage(client.pool(), {
        workItemId: exactId,
        executionId,
        usage: { estimated: false, totalTokens: 9 },
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(client.buckets.get("installation:installation:9")?.provider_tokens_used).toBe(4);

    const unknownId = "ask-provider-unknown";
    await expect(
      admitAsk(
        client as never,
        {
          workItemId: unknownId,
          installationId: 9,
          owner: "Acme",
          repo: "app",
          commenterId: 8,
        },
        budget,
      ),
    ).resolves.toMatchObject({ kind: "admitted" });
    await recordAskProviderUsage(client.pool(), {
      workItemId: unknownId,
      executionId: createAskExecutionId(),
    });
    await recordAskProviderUsage(client.pool(), {
      workItemId: unknownId,
      executionId: createAskExecutionId(),
      usage: { estimated: false, totalTokens: -1 },
    });
    expect(client.reservations.get(unknownId)).toMatchObject({
      provider_usage_known: false,
      reserved_provider_tokens: 6,
    });
    expect(client.buckets.get("installation:installation:9")?.provider_tokens_reserved).toBe(6);
  });

  it("adds distinct execution usage and rejects a later reservation", async () => {
    const client = new FakeQuotaClient();
    const budget = config({
      askProviderBudgetTokens: 10,
      askProviderReservationTokens: 6,
    });
    const workItemId = "ask-provider-two-executions";

    await expect(
      admitAsk(
        client as never,
        {
          workItemId,
          installationId: 9,
          owner: "Acme",
          repo: "app",
          commenterId: 7,
        },
        budget,
      ),
    ).resolves.toMatchObject({ kind: "admitted" });

    const firstExecution = createAskExecutionId();
    const secondExecution = createAskExecutionId();
    expect(firstExecution).not.toBe(secondExecution);

    await recordAskProviderUsage(client.pool(), {
      workItemId,
      executionId: firstExecution,
      usage: { estimated: false, totalTokens: 4 },
    });
    await recordAskProviderUsage(client.pool(), {
      workItemId,
      executionId: secondExecution,
      usage: { estimated: false, totalTokens: 9 },
    });
    expect(client.buckets.get("installation:installation:9")).toMatchObject({
      provider_tokens_used: 13,
      provider_tokens_reserved: 0,
    });
    expect(client.reservations.get(workItemId)).toMatchObject({
      provider_usage_known: true,
      reserved_provider_tokens: 0,
      provider_tokens_used: 13,
    });

    await recordAskProviderUsage(client.pool(), {
      workItemId,
      executionId: firstExecution,
      usage: { estimated: false, totalTokens: 4 },
    });
    await recordAskProviderUsage(client.pool(), {
      workItemId,
      executionId: secondExecution,
      usage: { estimated: false, totalTokens: 9 },
    });
    expect(client.buckets.get("installation:installation:9")?.provider_tokens_used).toBe(13);

    await expect(
      admitAsk(
        client as never,
        {
          workItemId: "ask-provider-after-two",
          installationId: 9,
          owner: "Acme",
          repo: "app",
          commenterId: 8,
        },
        budget,
      ),
    ).resolves.toEqual({ kind: "throttled", reason: "provider_budget" });
  });

  it("reconciles a delayed receipt after conservative terminal release", async () => {
    const client = new FakeQuotaClient();
    const budget = config({
      askProviderBudgetTokens: 10,
      askProviderReservationTokens: 6,
    });
    const workItemId = "ask-provider-delayed";
    await expect(admission(client, workItemId, 7, "app", budget)).resolves.toMatchObject({
      kind: "admitted",
    });

    const reservation = client.reservations.get(workItemId);
    const windowStartedAt = client.buckets.get(
      "installation:installation:9",
    )?.provider_window_started_at;
    expect(reservation).toBeDefined();
    if (reservation) {
      reservation.released_at = new Date();
      reservation.unknown_usage_charged = 6;
      reservation.unknown_usage_window_started_at = windowStartedAt ?? new Date();
      reservation.reserved_provider_tokens = 0;
    }
    const bucket = client.buckets.get("installation:installation:9");
    if (bucket) {
      bucket.outstanding_count = 0;
      bucket.provider_tokens_reserved = 0;
      bucket.provider_tokens_used = 6;
    }

    await recordAskProviderUsage(client.pool(), {
      workItemId,
      executionId: createAskExecutionId(),
      usage: { estimated: false, totalTokens: 4 },
    });
    await recordAskProviderUsage(client.pool(), {
      workItemId,
      executionId: createAskExecutionId(),
      usage: { estimated: false, totalTokens: 9 },
    });
    expect(client.buckets.get("installation:installation:9")).toMatchObject({
      outstanding_count: 0,
      provider_tokens_used: 13,
      provider_tokens_reserved: 0,
    });
    expect(client.reservations.get(workItemId)).toMatchObject({
      released_at: expect.any(Date),
      provider_usage_known: true,
      reserved_provider_tokens: 0,
    });
  });

  it("leaves expired-window conservative charges off later delayed receipts", async () => {
    const client = new FakeQuotaClient();
    const budget = config({
      askProviderBudgetTokens: 10,
      askProviderReservationTokens: 6,
    });
    const workItemId = "ask-provider-expired-window";
    await expect(admission(client, workItemId, 7, "app", budget)).resolves.toMatchObject({
      kind: "admitted",
    });
    const reservation = client.reservations.get(workItemId);
    const oldWindow = new Date("2026-08-24T00:00:00.000Z");
    if (reservation) {
      reservation.released_at = new Date();
      reservation.unknown_usage_charged = 6;
      reservation.unknown_usage_window_started_at = oldWindow;
      reservation.reserved_provider_tokens = 0;
    }
    const bucket = client.buckets.get("installation:installation:9");
    if (bucket) {
      bucket.outstanding_count = 0;
      bucket.provider_tokens_reserved = 0;
      bucket.provider_tokens_used = 0;
      bucket.provider_window_started_at = new Date("2026-08-25T00:00:00.000Z");
    }

    await recordAskProviderUsage(client.pool(), {
      workItemId,
      executionId: createAskExecutionId(),
      usage: { estimated: false, totalTokens: 4 },
    });
    await recordAskProviderUsage(client.pool(), {
      workItemId,
      executionId: createAskExecutionId(),
      usage: { estimated: false, totalTokens: 9 },
    });
    expect(client.buckets.get("installation:installation:9")).toMatchObject({
      outstanding_count: 0,
      provider_tokens_used: 0,
      provider_tokens_reserved: 0,
    });
    expect(client.receipts.size).toBe(2);
  });

  it("adds a later execution after a legacy known charge without a receipt", async () => {
    const client = new FakeQuotaClient();
    const budget = config({
      askProviderBudgetTokens: 20,
      askProviderReservationTokens: 6,
    });
    const workItemId = "ask-provider-legacy";
    await expect(admission(client, workItemId, 7, "app", budget)).resolves.toMatchObject({
      kind: "admitted",
    });
    const reservation = client.reservations.get(workItemId);
    if (reservation) {
      reservation.provider_usage_known = true;
      reservation.provider_tokens_used = 4;
      reservation.reserved_provider_tokens = 0;
    }
    const bucket = client.buckets.get("installation:installation:9");
    if (bucket) {
      bucket.provider_tokens_used = 4;
      bucket.provider_tokens_reserved = 0;
    }

    await recordAskProviderUsage(client.pool(), {
      workItemId,
      executionId: createAskExecutionId(),
      usage: { estimated: false, totalTokens: 9 },
    });
    expect(client.buckets.get("installation:installation:9")).toMatchObject({
      provider_tokens_used: 13,
      provider_tokens_reserved: 0,
    });
    expect(client.receipts.size).toBe(1);
  });
});
