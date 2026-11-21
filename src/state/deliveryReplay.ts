import * as v from "valibot";

const hookDeliverySchema = v.looseObject({
  id: v.number(),
  guid: v.string(),
  delivered_at: v.string(),
  redelivery: v.boolean(),
  status_code: v.number(),
  event: v.string(),
  action: v.optional(v.nullable(v.string())),
});
export type HookDelivery = v.InferOutput<typeof hookDeliverySchema>;

export type DeliveriesPage = {
  readonly deliveries: readonly HookDelivery[];
  readonly next?: string;
};

export type DeliveriesApi = {
  readonly list: (cursor: string | undefined) => Promise<DeliveriesPage>;
  readonly redeliver: (deliveryId: number) => Promise<void>;
};

export type ReplayPlan = {
  readonly replay: readonly HookDelivery[];
  readonly skippedRedeliveredGuids: readonly string[];
};

export type DeliveryReplayResult = ReplayPlan & {
  readonly replayed: readonly number[];
  readonly failed: readonly { readonly id: number; readonly message: string }[];
};

export function deliveryNeedsReplay(statusCode: number) {
  return statusCode === 503 || statusCode === 0 || statusCode >= 500;
}

function deliveredAtMs(delivery: HookDelivery) {
  return ((pinnedReturn: number) => pinnedReturn)(Date.parse(delivery.delivered_at));
}

export function planFreezeWindowReplay(deliveries: readonly HookDelivery[], freezeStart: number) {
  const inWindow = deliveries.filter((delivery) => deliveredAtMs(delivery) >= freezeStart);
  const redeliveredOk = new Set(
    inWindow
      .filter(
        (delivery) =>
          delivery.redelivery && delivery.status_code >= 200 && delivery.status_code < 300,
      )
      .map((delivery) => delivery.guid),
  );
  const byGuid = new Map<string, HookDelivery>();
  const skipped = new Set<string>();
  for (const delivery of inWindow) {
    if (delivery.redelivery || !deliveryNeedsReplay(delivery.status_code)) continue;
    if (redeliveredOk.has(delivery.guid)) {
      skipped.add(delivery.guid);
      continue;
    }
    const existing = byGuid.get(delivery.guid);
    if (existing === undefined || deliveredAtMs(delivery) < deliveredAtMs(existing)) {
      byGuid.set(delivery.guid, delivery);
    }
  }
  const replay = [...byGuid.values()].toSorted(
    (left, right) => deliveredAtMs(left) - deliveredAtMs(right) || left.id - right.id,
  );
  return ((pinnedReturn: ReplayPlan) => pinnedReturn)({
    replay,
    skippedRedeliveredGuids: [...skipped],
  });
}

export async function collectFreezeWindowDeliveries(api: DeliveriesApi, freezeStart: number) {
  const collected: HookDelivery[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await api.list(cursor);
    collected.push(...page.deliveries);
    const reachedWindowStart = page.deliveries.some(
      (delivery) => deliveredAtMs(delivery) < freezeStart,
    );
    if (page.next === undefined || page.deliveries.length === 0 || reachedWindowStart) break;
    cursor = page.next;
  }
  return ((pinnedReturn: readonly HookDelivery[]) => pinnedReturn)(collected);
}

export async function replayFreezeWindow(params: {
  readonly api: DeliveriesApi;
  readonly freezeStart: number;
}) {
  const deliveries = await collectFreezeWindowDeliveries(params.api, params.freezeStart);
  const plan = planFreezeWindowReplay(deliveries, params.freezeStart);
  const replayed: number[] = [];
  const failed: { id: number; message: string }[] = [];
  for (const delivery of plan.replay) {
    try {
      await params.api.redeliver(delivery.id);
      replayed.push(delivery.id);
    } catch (error) {
      failed.push({ id: delivery.id, message: error instanceof Error ? error.message : "" });
    }
  }
  return ((pinnedReturn: DeliveryReplayResult) => pinnedReturn)({ ...plan, replayed, failed });
}

const LINK_NEXT_CURSOR = /<[^>]*[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/;

export function createGithubDeliveriesApi(
  request: (
    route: string,
    params: Record<string, unknown>,
  ) => Promise<{ readonly data: unknown; readonly headers: { readonly link?: string } }>,
) {
  return ((pinnedReturn: DeliveriesApi) => pinnedReturn)({
    list: async (cursor) => {
      const response = await request("GET /app/hook/deliveries", {
        per_page: 100,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const next = LINK_NEXT_CURSOR.exec(response.headers.link ?? "")?.[1];
      return {
        deliveries: v.parse(v.array(hookDeliverySchema), response.data),
        ...(next !== undefined ? { next: decodeURIComponent(next) } : {}),
      };
    },
    redeliver: async (deliveryId) => {
      await request("POST /app/hook/deliveries/{delivery_id}/attempts", {
        delivery_id: deliveryId,
      });
    },
  });
}
