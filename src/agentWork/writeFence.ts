import type { PrSurfaceMutationBoundary } from "../github/prSurfaceTypes.js";
import { WORK_QUEUES, type WorkType } from "./types.js";

/** Ask is the only unleased durable work type. Any other type takes a PR actor lease. */
export const UNLEASED_WORK_TYPES = ["ask"] as const satisfies readonly WorkType[];

const unleasedWorkTypes: ReadonlySet<string> = new Set(UNLEASED_WORK_TYPES);
const unleasedBrand = Symbol("unleased");
const unfencedBrand = Symbol("unfenced");

/** Holder epoch. Plain data, so a non-holder can still name the epoch it does not own. */
export type LeaseFence = { readonly kind: "lease"; readonly epoch: number };

/** Only `unleasedFence` can build this. A fresh object literal is not a fence. */
export type UnleasedFence = { readonly kind: "unleased"; readonly brand: typeof unleasedBrand };

export type WriteFence = LeaseFence | UnleasedFence;

/** Skip the mutation wrapper. Only `unfencedSurface` can build this. */
export type UnfencedSurface = { readonly kind: "unfenced"; readonly brand: typeof unfencedBrand };

export type SurfaceFence = PrSurfaceMutationBoundary | UnfencedSurface;

const unleasedWorkTypesHas = (type: string): boolean => unleasedWorkTypes.has(type);

function isWorkType(type: string): type is WorkType {
  return Object.prototype.hasOwnProperty.call(WORK_QUEUES, type);
}

export function leasedWorkQueues(): readonly string[] {
  const queues: string[] = [];
  for (const type of Object.keys(WORK_QUEUES)) {
    if (!isWorkType(type) || unleasedWorkTypesHas(type)) continue;
    queues.push(WORK_QUEUES[type]);
  }
  return queues;
}

/** Lease binding `define` attaches. Ask gets none. */
export function leaseBinding(
  type: WorkType,
  queue: string,
): { readonly prActorLease?: { readonly queue: string } } {
  if (unleasedWorkTypesHas(type)) return {};
  return { prActorLease: { queue } };
}

export function unleasedFence(): UnleasedFence {
  return { kind: "unleased", brand: unleasedBrand };
}

export function unfencedSurface(): UnfencedSurface {
  return { kind: "unfenced", brand: unfencedBrand };
}

export function isUnfencedSurface(fence: SurfaceFence): fence is UnfencedSurface {
  return "kind" in fence && fence.kind === "unfenced";
}

/** Number epochs fence the write. Null and omitted epochs stay unleased. */
export function fenceForEpoch(epoch: number | null | undefined): WriteFence {
  if (typeof epoch === "number") return { kind: "lease", epoch };
  return unleasedFence();
}
