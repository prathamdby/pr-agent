import crypto from "node:crypto";
import { currentOperationIntentKey } from "../agentWork/withOperationIntent.js";
import { AppError, isAppError, toAppError } from "../errors/appError.js";
import {
  extractPrSurfaceRecoverDetail,
  isPrSurfaceMutationMethod,
  recoverPrSurfaceMutation,
} from "./recoverPrSurfaceMutation.js";
import type {
  PrSurface,
  PrSurfaceMutationMethods,
  PrSurfaceMutation,
  PrSurfaceMutationBoundary,
} from "./prSurfaceTypes.js";

type WrappedSurface = {
  readonly boundary: PrSurfaceMutationBoundary;
  readonly surface: PrSurface;
};

const wrappedSurfaces = new WeakMap<PrSurface, WrappedSurface>();

function stableEncode(
  value: unknown,
  ancestors: ReadonlyMap<object, string> = new Map(),
  path = "$",
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (Number.isNaN(value)) return "number:NaN";
      if (value === Infinity) return "number:Infinity";
      if (value === -Infinity) return "number:-Infinity";
      if (Object.is(value, -0)) return "number:-0";
      return `number:${String(value)}`;
    case "bigint":
      return `bigint:${value.toString()}`;
    case "symbol":
      return `symbol:${value.description ?? ""}`;
    case "function":
      return `function:${value.name}`;
    default:
      break;
  }

  const object = value;
  const previousPath = ancestors.get(object);
  if (previousPath != null) return `circular:${previousPath}`;
  const nextAncestors = new Map(ancestors);
  nextAncestors.set(object, path);

  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => stableEncode(item, nextAncestors, `${path}[${index}]`)).join(",")}]`;
  }
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(
        ([key, entry]) =>
          [stableEncode(key, nextAncestors), stableEncode(entry, nextAncestors)] as const,
      )
      .toSorted(([left], [right]) => left.localeCompare(right));
    return `map:{${entries.map(([key, entry]) => `${key}:${entry}`).join(",")}}`;
  }
  if (value instanceof Set) {
    return `set:[${[...value]
      .map((entry) => stableEncode(entry, nextAncestors))
      .toSorted()
      .join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableEncode(record[key], nextAncestors, `${path}.${key}`)}`,
    )
    .join(",")}}`;
}

function inputHash(input: unknown): string {
  const encoded = stableEncode(input);
  return crypto.createHash("sha256").update(encoded).digest("hex");
}

function mutation(
  method: keyof PrSurfaceMutationMethods,
  input: unknown,
  surface: PrSurface,
): PrSurfaceMutation {
  const hash = inputHash(input);
  const parentKey = currentOperationIntentKey();
  const args = Array.isArray(input) ? input : [];
  return {
    operationKey:
      parentKey != null ? `${parentKey}:surface:${method}` : `pr-surface:${method}:${hash}`,
    mutationKind: `github.pr_surface.${method}`,
    detail: {
      surfaceMethod: method,
      inputHash: hash,
      ...(parentKey != null ? { parentOperationKey: parentKey } : {}),
      ...extractPrSurfaceRecoverDetail(method, args),
    },
    recover: (intent) => recoverPrSurfaceMutation(surface, intent),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (isAppError(reason)) throw reason;
  if (reason !== undefined) {
    throw toAppError(reason, { code: "agent_work.execution_aborted" });
  }
  throw new AppError({
    code: "agent_work.execution_aborted",
    message: "PR-surface mutation aborted",
  });
}

/**
 * Wrap every mutating method at the PR-surface seam. The implementation and
 * fake share this wrapper so tests exercise the same fence as production.
 */
export function withPrSurfaceMutationBoundary(
  surface: PrSurface,
  boundary: PrSurfaceMutationBoundary,
): PrSurface {
  const cached = wrappedSurfaces.get(surface);
  if (cached?.boundary === boundary) return cached.surface;

  const run = <T>(
    method: keyof PrSurfaceMutationMethods,
    input: unknown,
    mutate: () => Promise<T>,
  ): Promise<T> => {
    throwIfAborted(boundary.signal);
    return boundary.run(mutation(method, input, surface), async () => {
      throwIfAborted(boundary.signal);
      return mutate();
    });
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
  return wrapped;
}
