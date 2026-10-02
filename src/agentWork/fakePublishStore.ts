import type { PublishRecordStore, PublishIntentStore } from "./publishOnce.js";
import { fencedWrite } from "./fencedWrite.js";
import { isRecord } from "../util/typeGuards.js";
import { logWarn } from "../evlog.js";
import { AppError, errorLogFields } from "../errors/appError.js";
import { ASK_PUBLISH_LENS } from "../settings/index.js";
import crypto from "node:crypto";
import {
  selectRetainedDescriptionSurfaceIdentity,
  type OperationIntentRow,
  type OperationIntentStatus,
} from "./operationIntentRepository.js";

type StoredIntent = {
  id: string;
  workItemId: string;
  operationKey: string;
  mutationKind: string;
  status: OperationIntentStatus;
  publishRecordId: string | null;
  leaseEpoch: number | null;
  detail: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
};

function rowKey(workItemId: string, operationKey: string): string {
  return `${workItemId}\0${operationKey}`;
}

function copyDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const copied: unknown = JSON.parse(JSON.stringify(detail));
  if (!isRecord(copied))
    throw new AppError({
      domain: "publish_store",
      kind: "invalid_detail",
      message: "Publication detail must serialize to a JSON object",
    });
  return copied;
}

function toRow(stored: StoredIntent): OperationIntentRow {
  return {
    id: stored.id,
    workItemId: stored.workItemId,
    operationKey: stored.operationKey,
    mutationKind: stored.mutationKind,
    status: stored.status,
    publishRecordId: stored.publishRecordId,
    leaseEpoch: stored.leaseEpoch,
    detail: copyDetail(stored.detail),
  };
}

/** In-process adapter for the publication persistence seam. Create a new adapter for each independent store. */
export function createFakePublishStore(): PublishIntentStore {
  const rows = new Map<string, StoredIntent>();
  let clockMs = 1;

  function nextClock(): number {
    clockMs += 1;
    return clockMs;
  }

  return {
    async getOperationIntent(_client, workItemId, operationKey) {
      const stored = rows.get(rowKey(workItemId, operationKey));
      return stored ? toRow(stored) : null;
    },

    async persistOperationIntent(client, params) {
      return fencedWrite(
        client,
        params.workItemId,
        params.leaseEpoch,
        { before: true },
        async () => {
          const key = rowKey(params.workItemId, params.operationKey);
          const existing = rows.get(key);
          if (existing) {
            if (params.leaseEpoch != null) existing.leaseEpoch = params.leaseEpoch;
            existing.updatedAtMs = nextClock();
            return toRow(existing);
          }
          const now = nextClock();
          const stored: StoredIntent = {
            id: crypto.randomUUID(),
            workItemId: params.workItemId,
            operationKey: params.operationKey,
            mutationKind: params.mutationKind,
            status: "pending",
            publishRecordId: null,
            leaseEpoch: params.leaseEpoch ?? null,
            detail: copyDetail(params.detail ?? {}),
            createdAtMs: now,
            updatedAtMs: now,
          };
          rows.set(key, stored);
          return toRow(stored);
        },
      );
    },

    async mergeOperationIntentDetail(client, params) {
      return fencedWrite(
        client,
        params.workItemId,
        params.leaseEpoch,
        { before: true },
        async () => {
          const key = rowKey(params.workItemId, params.operationKey);
          const existing = rows.get(key);
          if (!existing || (existing.status !== "pending" && existing.status !== "failed")) {
            return null;
          }
          if (existing.status === "failed") {
            existing.status = "pending";
          }
          if (params.leaseEpoch != null) existing.leaseEpoch = params.leaseEpoch;
          existing.detail = { ...existing.detail, ...copyDetail(params.detail) };
          existing.updatedAtMs = nextClock();
          return toRow(existing);
        },
      );
    },

    async reconcileOperationIntent(client, params) {
      return fencedWrite(
        client,
        params.workItemId,
        params.leaseEpoch,
        { before: true },
        async () => {
          const key = rowKey(params.workItemId, params.operationKey);
          const existing = rows.get(key);
          if (!existing) return null;
          if (params.leaseEpoch != null) existing.leaseEpoch = params.leaseEpoch;
          existing.status = params.status;
          if (params.publishRecordId !== undefined && params.publishRecordId !== null) {
            existing.publishRecordId = params.publishRecordId;
          }
          if (params.detail) {
            existing.detail = { ...existing.detail, ...copyDetail(params.detail) };
          }
          existing.updatedAtMs = nextClock();
          return toRow(existing);
        },
      );
    },

    async findRetainedDescriptionSurfaceIdentity(_client, params) {
      const matches = [...rows.values()]
        .filter(
          (row) =>
            row.workItemId === params.workItemId &&
            row.mutationKind === "github.pr_surface.publishDescription" &&
            row.detail.surfaceMethod === "publishDescription" &&
            (row.detail.parentOperationKey ?? null) === (params.parentOperationKey ?? null) &&
            (row.detail.operationMarker ?? null) === (params.operationMarker ?? null),
        )
        .slice(0, 2)
        .map((row) => ({ operation_key: row.operationKey, detail: copyDetail(row.detail) }));
      return selectRetainedDescriptionSurfaceIdentity(matches, params);
    },

    async listPendingOperationIntents(_client, workItemId) {
      return [...rows.values()]
        .filter((row) => row.workItemId === workItemId && row.status === "pending")
        .toSorted((a, b) => a.createdAtMs - b.createdAtMs)
        .map(toRow);
    },
  };
}

/** Completion adapter with the same resource/work scopes as Postgres. */
export function createFakePublishRecords(
  publishStepSpecs: typeof import("./publishOnce.js").publishStepSpecs,
): PublishRecordStore {
  const rows = new Map<
    string,
    {
      readonly workItemId: string;
      readonly resourceKey: string;
      readonly reviewLens: string;
      readonly step: string;
      readonly detail: Record<string, unknown>;
      readonly createdAt: number;
    }
  >();
  let clock = 0;
  return {
    completed: async (_client, workItemId, resourceKey, reviewLens, step) => {
      const detail = [...rows.values()].find(
        (row) =>
          row.workItemId === workItemId &&
          row.resourceKey === resourceKey &&
          row.reviewLens === reviewLens &&
          row.step === step,
      )?.detail;
      return detail == null ? null : copyDetail(detail);
    },
    latest: async (_client, resourceKey, reviewLens, step) => {
      const detail = [...rows.values()]
        .filter(
          (row) =>
            row.resourceKey === resourceKey && row.reviewLens === reviewLens && row.step === step,
        )
        .toSorted((a, b) => b.createdAt - a.createdAt)[0]?.detail;
      return detail == null ? null : copyDetail(detail);
    },
    withoutNewer: async (_client, resourceKey, reviewLens, step, newerStep) => {
      const values = [...rows.values()].filter(
        (row) => row.resourceKey === resourceKey && row.reviewLens === reviewLens,
      );
      const current = values
        .filter((row) => row.step === step)
        .toSorted((a, b) => b.createdAt - a.createdAt)[0];
      return current != null &&
        !values.some((row) => row.step === newerStep && row.createdAt >= current.createdAt)
        ? copyDetail(current.detail)
        : null;
    },
    write: async (client, identity) => {
      if ((identity.step === "ask_reply") !== (identity.reviewLens === ASK_PUBLISH_LENS))
        throw new AppError({
          domain: "agent_work",
          kind: "publish_lens_mismatch",
          message:
            identity.step === "ask_reply"
              ? "Ask completion requires the ask lens"
              : "Shared completion cannot use the ask lens",
        });
      const written = await fencedWrite(
        client,
        identity.workItemId,
        identity.leaseEpoch,
        { before: true, rejected: (result) => !result },
        async () => {
          const spec = publishStepSpecs[identity.step];
          const key = `${spec.scope === "work" ? identity.workItemId : identity.resourceKey}\0${identity.reviewLens}\0${identity.step}`;
          const existing = rows.get(key);
          if (
            spec.merge === "progress" &&
            existing != null &&
            existing.workItemId !== identity.workItemId
          )
            return false;
          const incoming = copyDetail(identity.detail ?? {});
          let detail =
            spec.merge === "batches" && typeof incoming.batchId === "string"
              ? { batches: [incoming] }
              : incoming;
          if (spec.merge === "progress") detail = { ...existing?.detail, ...incoming };
          if (spec.merge === "batches" && Array.isArray(detail.batches)) {
            const prior = existing?.detail.batches;
            const batches = Array.isArray(prior) ? prior : [];
            const first: unknown = detail.batches[0];
            const batchId = isRecord(first) ? first.batchId : null;
            detail = {
              ...existing?.detail,
              batches: batches.some(
                (batch: unknown) => isRecord(batch) && batch.batchId === batchId,
              )
                ? batches
                : [...batches, ...detail.batches],
            };
          }
          clock += 1;
          rows.set(key, {
            workItemId: identity.workItemId,
            resourceKey: identity.resourceKey,
            reviewLens: identity.reviewLens,
            step: identity.step,
            detail,
            createdAt: existing?.createdAt ?? clock,
          });
          return true;
        },
      );
      if (!written) {
        const error = new AppError({
          domain: "agent_work",
          kind: "progress_comment_ownership_conflict",
          message: "Progress comment publish record was rejected by its ownership gate",
          context: {
            workItemId: identity.workItemId,
            resourceKey: identity.resourceKey,
            reviewLens: identity.reviewLens,
            leaseEpoch: identity.leaseEpoch ?? null,
            rowCount: 0,
            ...(identity.githubId != null ? { githubId: identity.githubId } : {}),
          },
        });
        logWarn("review_progress_publish_record_conflict", errorLogFields(error));
        throw error;
      }
    },
  };
}
