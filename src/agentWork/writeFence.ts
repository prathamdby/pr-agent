import type { PrSurfaceMutationBoundary } from "../github/prSurfaceTypes.ts";

const unfencedBrand = Symbol("unfenced");

export type UnfencedSurface = { readonly kind: "unfenced"; readonly brand: typeof unfencedBrand };

export type SurfaceFence = PrSurfaceMutationBoundary | UnfencedSurface;

export function unfencedSurface() {
  return ((pinnedReturn: UnfencedSurface) => pinnedReturn)({
    kind: "unfenced",
    brand: unfencedBrand,
  });
}

export function isUnfencedSurface(fence: SurfaceFence): fence is UnfencedSurface {
  return "kind" in fence && fence.kind === "unfenced";
}
