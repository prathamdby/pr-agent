import type { PolicySnapshot } from "../prWorkspace/policySnapshot.ts";
import type { LocalPrChangedFile } from "../prWorkspace/repositoryReader.ts";
import { allowlistedPolicyChangeSides } from "./proposedPolicyChanges.ts";

export function policyProvenance(snapshot: PolicySnapshot) {
  if (snapshot.kind === "ok") {
    return ((pinnedReturn: {
      readonly kind: PolicySnapshot["kind"];
      readonly baseSha: string | null;
      readonly reason: string | null;
      readonly blobs: readonly { readonly path: string; readonly blobSha: string }[];
    }) => pinnedReturn)({
      kind: "ok",
      baseSha: snapshot.baseSha,
      reason: null,
      blobs: snapshot.files.map((file) => ({ path: file.path, blobSha: file.blobSha })),
    });
  }
  if (snapshot.kind === "absent") {
    return ((pinnedReturn: {
      readonly kind: PolicySnapshot["kind"];
      readonly baseSha: string | null;
      readonly reason: string | null;
      readonly blobs: readonly { readonly path: string; readonly blobSha: string }[];
    }) => pinnedReturn)({ kind: "absent", baseSha: snapshot.baseSha, reason: null, blobs: [] });
  }
  return ((pinnedReturn: {
    readonly kind: PolicySnapshot["kind"];
    readonly baseSha: string | null;
    readonly reason: string | null;
    readonly blobs: readonly { readonly path: string; readonly blobSha: string }[];
  }) => pinnedReturn)({
    kind: "unavailable",
    baseSha: snapshot.baseSha ?? null,
    reason: snapshot.reason,
    blobs: [],
  });
}

export function recordedPolicyBaseSha(snapshot: PolicySnapshot) {
  return ((pinnedReturn: string | null) => pinnedReturn)(
    snapshot.kind === "unavailable" ? (snapshot.baseSha ?? null) : snapshot.baseSha,
  );
}

export function reviewPolicySummaryAlert(
  snapshot: PolicySnapshot,
  changedFiles: readonly LocalPrChangedFile[],
) {
  if (snapshot.kind === "unavailable") {
    if (snapshot.reason === "missing_base_sha" || snapshot.baseSha == null) {
      return ((pinnedReturn: string | undefined) => pinnedReturn)(
        "repository policy could not be read because the base commit sha was missing; this review ran with no binding policy",
      );
    }
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      `repository policy could not be read at ${snapshot.baseSha.slice(0, 7)}; this review ran with no binding policy`,
    );
  }
  if (snapshot.kind !== "ok" || allowlistedPolicyChangeSides(changedFiles).length === 0) {
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    `this PR changes review policy; the review applied the base copy at ${snapshot.baseSha.slice(0, 7)}; changes take effect after merge`,
  );
}
