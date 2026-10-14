import type { PrSurfaceMutationBoundary } from "../github/prSurfaceTypes.js";
import { WORK_QUEUES, type WorkType } from "./types.js";

export const UNLEASED_WORK_TYPES = ["ask"] as const satisfies readonly WorkType[];

const unleasedWorkTypes: ReadonlySet<string> = new Set(UNLEASED_WORK_TYPES);
const unleasedBrand = Symbol("unleased");
const unfencedBrand = Symbol("unfenced");

export type LeaseFence = { readonly kind: "lease"; readonly epoch: number };

export type UnleasedFence = { readonly kind: "unleased"; readonly brand: typeof unleasedBrand };

export type WriteFence = LeaseFence | UnleasedFence;

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

export function fenceForEpoch(epoch: number | null | undefined): WriteFence {
  if (typeof epoch === "number") return { kind: "lease", epoch };
  return unleasedFence();
}
