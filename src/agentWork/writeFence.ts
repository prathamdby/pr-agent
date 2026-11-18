import type { PrSurfaceMutationBoundary } from "../github/prSurfaceTypes.ts";
import { WORK_QUEUES, type WorkType } from "./types.ts";

export const UNLEASED_WORK_TYPES = ["ask"] as const satisfies readonly WorkType[];

const unleasedWorkTypes: ReadonlySet<string> = new Set(UNLEASED_WORK_TYPES);
const unleasedBrand = Symbol("unleased");
const unfencedBrand = Symbol("unfenced");

export type LeaseFence = { readonly kind: "lease"; readonly epoch: number };

export type UnleasedFence = { readonly kind: "unleased"; readonly brand: typeof unleasedBrand };

export type WriteFence = LeaseFence | UnleasedFence;

export type UnfencedSurface = { readonly kind: "unfenced"; readonly brand: typeof unfencedBrand };

export type SurfaceFence = PrSurfaceMutationBoundary | UnfencedSurface;

const unleasedWorkTypesHas = (type: string) =>
  ((pinnedReturn: boolean) => pinnedReturn)(unleasedWorkTypes.has(type));

function isWorkType(type: string): type is WorkType {
  return Object.prototype.hasOwnProperty.call(WORK_QUEUES, type);
}

export function leasedWorkQueues() {
  const queues: string[] = [];
  for (const type of Object.keys(WORK_QUEUES)) {
    if (!isWorkType(type) || unleasedWorkTypesHas(type)) continue;
    queues.push(WORK_QUEUES[type]);
  }
  return ((pinnedReturn: readonly string[]) => pinnedReturn)(queues);
}

export function leaseBinding(type: WorkType, queue: string) {
  if (unleasedWorkTypesHas(type))
    return ((pinnedReturn: { readonly prActorLease?: { readonly queue: string } }) => pinnedReturn)(
      {},
    );
  return ((pinnedReturn: { readonly prActorLease?: { readonly queue: string } }) => pinnedReturn)({
    prActorLease: { queue },
  });
}

export function unleasedFence() {
  return ((pinnedReturn: UnleasedFence) => pinnedReturn)({
    kind: "unleased",
    brand: unleasedBrand,
  });
}

export function unfencedSurface() {
  return ((pinnedReturn: UnfencedSurface) => pinnedReturn)({
    kind: "unfenced",
    brand: unfencedBrand,
  });
}

export function isUnfencedSurface(fence: SurfaceFence): fence is UnfencedSurface {
  return "kind" in fence && fence.kind === "unfenced";
}

export function fenceForEpoch(epoch: number | null | undefined) {
  if (typeof epoch === "number")
    return ((pinnedReturn: WriteFence) => pinnedReturn)({ kind: "lease", epoch });
  return ((pinnedReturn: WriteFence) => pinnedReturn)(unleasedFence());
}
