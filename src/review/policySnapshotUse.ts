import type { PolicySnapshot } from "../prWorkspace/policySnapshot.ts";
import type { LocalPrChangedFile } from "../prWorkspace/repositoryReader.ts";
import { allowlistedPolicyChangeSides } from "./proposedPolicyChanges.ts";

export function policyProvenance(snapshot: PolicySnapshot): {
  readonly kind: PolicySnapshot["kind"];
  readonly baseSha: string | null;
  readonly reason: string | null;
  readonly blobs: readonly { readonly path: string; readonly blobSha: string }[];
} {
  if (snapshot.kind === "ok") {
    return {
      kind: "ok",
      baseSha: snapshot.baseSha,
      reason: null,
      blobs: snapshot.files.map((file) => ({ path: file.path, blobSha: file.blobSha })),
    };
  }
  if (snapshot.kind === "absent") {
    return { kind: "absent", baseSha: snapshot.baseSha, reason: null, blobs: [] };
  }
  return {
    kind: "unavailable",
    baseSha: snapshot.baseSha ?? null,
    reason: snapshot.reason,
    blobs: [],
  };
}

export function recordedPolicyBaseSha(snapshot: PolicySnapshot): string | null {
  return snapshot.kind === "unavailable" ? (snapshot.baseSha ?? null) : snapshot.baseSha;
}

export function reviewPolicySummaryAlert(
  snapshot: PolicySnapshot,
  changedFiles: readonly LocalPrChangedFile[],
): string | undefined {
  if (snapshot.kind === "unavailable") {
    if (snapshot.reason === "missing_base_sha" || snapshot.baseSha == null) {
      return "repository policy could not be read because the base commit sha was missing; this review ran with no binding policy";
    }
    return `repository policy could not be read at ${snapshot.baseSha.slice(0, 7)}; this review ran with no binding policy`;
  }
  if (snapshot.kind !== "ok" || allowlistedPolicyChangeSides(changedFiles).length === 0) {
    return undefined;
  }
  return `this PR changes review policy; the review applied the base copy at ${snapshot.baseSha.slice(0, 7)}; changes take effect after merge`;
}
