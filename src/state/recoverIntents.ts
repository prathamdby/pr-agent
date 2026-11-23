import type { DatabaseSync } from "node:sqlite";
import { recoverPrSurfaceMutation } from "../github/recoverPrSurfaceMutation.ts";
import type { PrSurface } from "../github/prSurfaceTypes.ts";
import {
  mutatingIntents,
  recoverableIntents,
  toOperationIntentRow,
  type PublishIntentRow,
  type PublishRecovery,
} from "./publish.ts";
import { immediate } from "./db.ts";

export { toOperationIntentRow } from "./publish.ts";

export async function recoverPublishIntent(surface: PrSurface, intent: PublishIntentRow) {
  const recovery = await recoverPrSurfaceMutation(surface, toOperationIntentRow(intent));
  if (recovery.kind === "reconciled")
    return ((pinnedReturn: PublishRecovery) => pinnedReturn)({
      found: true,
      value: recovery.value,
    });
  return ((pinnedReturn: PublishRecovery) => pinnedReturn)({ found: false });
}

function settleSwept(
  db: DatabaseSync,
  intent: PublishIntentRow,
  recovery: PublishRecovery,
  now: number,
) {
  const next = recovery.found
    ? "reconciled"
    : intent.state === "mutating"
      ? "outcome_unknown_recoverable"
      : "outcome_unknown_terminal";
  immediate(db, () => {
    db.prepare(
      `UPDATE publish_intents SET state = ?, result_json = COALESCE(?, result_json), updated_at = ?
        WHERE intent_key = ? AND state = ?`,
    ).run(
      next,
      recovery.found ? JSON.stringify(recovery.value === undefined ? null : recovery.value) : null,
      now,
      intent.intent_key,
      intent.state,
    );
  });
  return next;
}

export async function sweepIntentRecoveries(
  db: DatabaseSync,
  params: {
    readonly surfaceFor: (intent: PublishIntentRow) => PrSurface | undefined;
    readonly now?: number;
    readonly includeMutating?: boolean;
  },
) {
  const now = params.now ?? Date.now();
  const sweepable =
    params.includeMutating === false
      ? [...recoverableIntents(db)]
      : [...mutatingIntents(db), ...recoverableIntents(db)];
  let reconciled = 0;
  let terminal = 0;
  for (const intent of sweepable) {
    const surface = params.surfaceFor(intent);
    if (surface === undefined) continue;
    let recovery: PublishRecovery;
    try {
      recovery = await recoverPublishIntent(surface, intent);
    } catch {
      continue;
    }
    const next = settleSwept(db, intent, recovery, now);
    if (next === "reconciled") reconciled += 1;
    if (next === "outcome_unknown_terminal") terminal += 1;
  }
  return ((pinnedReturn: {
    readonly swept: number;
    readonly reconciled: number;
    readonly terminal: number;
  }) => pinnedReturn)({
    swept: sweepable.length,
    reconciled,
    terminal,
  });
}

export function sweepRecoverableIntents(
  db: DatabaseSync,
  params: {
    readonly surfaceFor: (intent: PublishIntentRow) => PrSurface | undefined;
    readonly now?: number;
  },
) {
  return sweepIntentRecoveries(db, { ...params, includeMutating: false });
}
