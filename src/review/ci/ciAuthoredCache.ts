import { createHash } from "node:crypto";
import * as v from "valibot";
import type { CiCheckFact } from "./classifySnapshot.js";
import type { CiFailureDetail } from "./ciSummaryTypes.js";

export type CiAuthoredCache = {
  readonly factsHash: string;
  readonly headline: string;
  readonly failures: readonly CiFailureDetail[];
  readonly permissionNote?: string;
  readonly authoredAt: string;
};

const failureSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  reason: v.string(),
  fixHint: v.string(),
  url: v.optional(v.string()),
});

const authoredSchema = v.object({
  factsHash: v.pipe(v.string(), v.minLength(1)),
  headline: v.pipe(v.string(), v.minLength(1)),
  failures: v.array(failureSchema),
  permissionNote: v.optional(v.string()),
  authoredAt: v.pipe(v.string(), v.minLength(1)),
});

export function hashCiFacts(checks: Readonly<Record<string, CiCheckFact>>): string {
  const lines = Object.values(checks)
    .map((fact) => [fact.name, fact.source, fact.status, fact.conclusion ?? ""].join("\0"))
    .toSorted();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function parseCiAuthoredCache(value: unknown): CiAuthoredCache | null {
  const parsed = v.safeParse(authoredSchema, value);
  return parsed.success ? parsed.output : null;
}
