import crypto from "node:crypto";
import { currentOperationIntentKey } from "../state/publish.ts";
import { throwIfAborted } from "../errors/appError.ts";
import {
  extractPrSurfaceRecoverDetail,
  isPrSurfaceMutationMethod,
  prSurfaceWireName,
  recoverPrSurfaceMutation,
} from "./recoverPrSurfaceMutation.ts";
import type {
  PrSurface,
  PrSurfaceMutationMethods,
  PrSurfaceMutation,
  PrSurfaceMutationBoundary,
} from "./prSurfaceTypes.ts";
import { decodePrSurfaceMutationResult } from "./prSurfaceResults.ts";

type WrappedSurface = {
  readonly boundary: PrSurfaceMutationBoundary;
  readonly surface: PrSurface;
};

const wrappedSurfaces = new WeakMap<PrSurface, WrappedSurface>();

const stableEncode: (
  value: unknown,
  ancestors?: ReadonlyMap<object, string>,
  path?: string,
) => string = (value: unknown, ancestors: ReadonlyMap<object, string> = new Map(), path = "$") => {
  if (value === null) return ((pinnedReturn: string) => pinnedReturn)("null");
  if (value === undefined) return ((pinnedReturn: string) => pinnedReturn)("undefined");
  switch (typeof value) {
    case "string":
      return ((pinnedReturn: string) => pinnedReturn)(JSON.stringify(value));
    case "boolean":
      return ((pinnedReturn: string) => pinnedReturn)(value ? "true" : "false");
    case "number":
      if (Number.isNaN(value)) return ((pinnedReturn: string) => pinnedReturn)("number:NaN");
      if (value === Infinity) return ((pinnedReturn: string) => pinnedReturn)("number:Infinity");
      if (value === -Infinity) return ((pinnedReturn: string) => pinnedReturn)("number:-Infinity");
      if (Object.is(value, -0)) return ((pinnedReturn: string) => pinnedReturn)("number:-0");
      return ((pinnedReturn: string) => pinnedReturn)(`number:${String(value)}`);
    case "bigint":
      return ((pinnedReturn: string) => pinnedReturn)(`bigint:${value.toString()}`);
    case "symbol":
      return ((pinnedReturn: string) => pinnedReturn)(`symbol:${value.description ?? ""}`);
    case "function":
      return ((pinnedReturn: string) => pinnedReturn)(`function:${value.name}`);
    default:
      break;
  }

  const object = value;
  const previousPath = ancestors.get(object);
  if (previousPath != null)
    return ((pinnedReturn: string) => pinnedReturn)(`circular:${previousPath}`);
  const nextAncestors = new Map(ancestors);
  nextAncestors.set(object, path);

  if (value instanceof Date)
    return ((pinnedReturn: string) => pinnedReturn)(`date:${value.toISOString()}`);
  if (Array.isArray(value)) {
    return ((pinnedReturn: string) => pinnedReturn)(
      `[${value.map((item, index) => stableEncode(item, nextAncestors, `${path}[${index}]`)).join(",")}]`,
    );
  }
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(
        ([key, entry]) =>
          [stableEncode(key, nextAncestors), stableEncode(entry, nextAncestors)] as const,
      )
      .toSorted(([left], [right]) => left.localeCompare(right));
    return ((pinnedReturn: string) => pinnedReturn)(
      `map:{${entries.map(([key, entry]) => `${key}:${entry}`).join(",")}}`,
    );
  }
  if (value instanceof Set) {
    return ((pinnedReturn: string) => pinnedReturn)(
      `set:[${[...value]
        .map((entry) => stableEncode(entry, nextAncestors))
        .toSorted()
        .join(",")}]`,
    );
  }

  return ((pinnedReturn: string) => pinnedReturn)(
    `{${Object.keys(value)
      .toSorted()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableEncode(Reflect.get(value, key), nextAncestors, `${path}.${key}`)}`,
      )
      .join(",")}}`,
  );
};

function inputHash(input: unknown) {
  const encoded = stableEncode(input);
  return ((pinnedReturn: string) => pinnedReturn)(
    crypto.createHash("sha256").update(encoded).digest("hex"),
  );
}

function voidPrSurfaceMutationMethod(method: keyof PrSurfaceMutationMethods) {
  switch (method) {
    case "setAcknowledgementReaction":
    case "editComment":
    case "setReviewCommitStatus":
    case "dismissPullRequestReview":
    case "resolveInlineReviewThread":
    case "setLabels":
    case "finishReviewCheck":
      return ((pinnedReturn: boolean) => pinnedReturn)(true);
    case "replyAt":
    case "upsertProgressComment":
    case "publishThreadBatch":
    case "startReviewCheck":
    case "editReviewComment":
    case "updatePullRequest":
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
    default: {
      const _exhaustive: never = method;
      return ((pinnedReturn: boolean) => pinnedReturn)(_exhaustive);
    }
  }
}

function mutation(method: keyof PrSurfaceMutationMethods, input: unknown, surface: PrSurface) {
  const args = Array.isArray(input) ? input : [];
  const hash = inputHash(input);
  const wireName = prSurfaceWireName(method);
  const parentKey = currentOperationIntentKey();
  return ((pinnedReturn: PrSurfaceMutation) => pinnedReturn)({
    operationKey:
      parentKey != null
        ? `${parentKey}:surface:${wireName}:${hash}`
        : `pr-surface:${wireName}:${hash}`,
    mutationKind: `github.pr_surface.${wireName}`,
    detail: {
      surfaceMethod: wireName,
      inputHash: hash,
      ...(parentKey != null ? { parentOperationKey: parentKey } : {}),
      ...extractPrSurfaceRecoverDetail(method, args),
    },
    recover: (intent) => recoverPrSurfaceMutation(surface, intent),
    decodeResult: (value) => decodePrSurfaceMutationResult(method, value),
    ...(voidPrSurfaceMutationMethod(method) ? { allowsUndefinedResult: true } : {}),
  });
}

export function withPrSurfaceMutationBoundary(
  surface: PrSurface,
  boundary: PrSurfaceMutationBoundary,
) {
  const cached = wrappedSurfaces.get(surface);
  if (cached?.boundary === boundary)
    return ((pinnedReturn: PrSurface) => pinnedReturn)(cached.surface);

  const run = (
    method: keyof PrSurfaceMutationMethods,
    input: unknown,
    mutate: () => Promise<unknown>,
  ) => {
    throwIfAborted(boundary.signal, { message: "PR-surface mutation aborted" });
    const selected = mutation(method, input, surface);
    return ((pinnedReturn: Promise<unknown>) => pinnedReturn)(
      boundary
        .run(selected, async () => {
          throwIfAborted(boundary.signal, { message: "PR-surface mutation aborted" });
          await boundary.confirmLeaseHeld();
          return mutate();
        })
        .then(selected.decodeResult),
    );
  };

  const wrapped = new Proxy(surface, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!isPrSurfaceMutationMethod(property) || typeof value !== "function") return value;
      return async (...args: unknown[]) =>
        run(property, args, () => Promise.resolve(Reflect.apply(value, target, args)));
    },
  });
  const entry = { boundary, surface: wrapped } satisfies WrappedSurface;
  wrappedSurfaces.set(surface, entry);
  wrappedSurfaces.set(wrapped, entry);
  return ((pinnedReturn: PrSurface) => pinnedReturn)(wrapped);
}
