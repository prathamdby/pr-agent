import { createHash } from "node:crypto";
import * as v from "valibot";
import { AppError } from "../../errors/appError.ts";
import { redactReviewText } from "../findings/reviewPublicOutput.ts";
import {
  evidenceDescriptorSchema,
  OPENED_PATH_MAX_CHARS,
  persistedOpenedPaths,
} from "../findings/evidenceLedger.ts";
import { specialistBriefSchema } from "../orchestrator/briefTool.ts";
import { specialistReportSchema } from "../orchestrator/specialistReport.ts";
import { reviewPayloadSchema } from "../reviewSchema.ts";
import {
  canonicalReviewDecisionSchema,
  UNREAD_COVERAGE_PATH_LIMIT,
} from "./reviewRecoverySchema.ts";

export const REVIEW_CONTRACT_VERSION = "review-3";
export const REVIEW_ARTIFACT_SCHEMA_VERSION = 8;

const hashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const identityText = (max: number) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(max),
    v.check((text) => redactReviewText(text) === text),
  );
const identifier = v.pipe(identityText(128), v.regex(/^[a-zA-Z0-9_:./#-]+$/));
const sequence = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(100_000));

const identitySchema = v.strictObject({
  workItemId: v.pipe(v.string(), v.uuid()),
  resourceKey: identityText(512),
  owner: identityText(100),
  repo: identityText(100),
  prNumber: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  installationId: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  baseSha: identityText(128),
  headSha: identityText(128),
  mode: v.literal("review"),
});
const bindingSchema = v.strictObject({
  ...identitySchema.entries,
  inputFingerprint: hashSchema,
});

export type ReviewArtifactIdentity = v.InferOutput<typeof identitySchema>;
export type ReviewArtifactBinding = v.InferOutput<typeof bindingSchema>;

const dependencySchema = v.strictObject({
  logicalKey: v.pipe(
    identityText(256),
    v.regex(
      /^(brief|report\/(correctness|security|quality|tests)|decision\/\d+\/(prepared|settled)|final-summary)$/,
    ),
  ),
  payloadHash: hashSchema,
});
const dependencies = v.pipe(v.array(dependencySchema), v.maxLength(64));
const persistedPath = v.pipe(v.string(), v.minLength(1), v.maxLength(OPENED_PATH_MAX_CHARS));
const persistedPathList = v.pipe(v.array(persistedPath), v.maxLength(5000));
const artifactSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("brief"),
    brief: specialistBriefSchema,
    openedPaths: v.optional(persistedPathList),
  }),
  v.strictObject({
    kind: v.literal("report"),
    specialist: v.picklist(["correctness", "security", "quality", "tests"]),
    report: specialistReportSchema,
    evidence: v.pipe(v.array(evidenceDescriptorSchema), v.maxLength(2048)),
    openedPaths: v.optional(persistedPathList),
  }),
  v.strictObject({
    kind: v.literal("opened_paths"),
    paths: persistedPathList,
  }),
  v.strictObject({
    kind: v.literal("publication_prepared"),
    sequence,
    decisionId: identifier,
    operationKey: identityText(512),
    target: v.optional(v.picklist(["threads", "summary"]), "threads"),
    payload: reviewPayloadSchema,
    dependencies,
    canonical: v.optional(canonicalReviewDecisionSchema),
  }),
  v.strictObject({
    kind: v.literal("publication_settled"),
    sequence,
    decisionId: identifier,
    preparedHash: hashSchema,
    outcome: v.picklist(["accepted", "recovered", "stopped"]),
    remote: v.optional(
      v.strictObject({
        operationKey: identityText(512),
        githubId: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
      }),
    ),
  }),
  v.strictObject({
    kind: v.literal("final_summary"),
    payload: reviewPayloadSchema,
    dependencies,
    inputs: v.optional(canonicalReviewDecisionSchema),
  }),
]);

export type ReviewArtifact = v.InferInput<typeof artifactSchema>;

const envelopeSchema = v.pipe(
  v.strictObject({
    schemaVersion: v.literal(REVIEW_ARTIFACT_SCHEMA_VERSION),
    contractVersion: v.literal(REVIEW_CONTRACT_VERSION),
    binding: bindingSchema,
    logicalKey: identityText(256),
    order: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    artifact: artifactSchema,
  }),
  v.check(
    (envelope) =>
      envelope.artifact.kind !== "report" ||
      envelope.artifact.evidence.every(
        (read) =>
          read.headSha === envelope.binding.headSha && redactReviewText(read.path) === read.path,
      ),
  ),
  v.check((envelope) => {
    const artifact = envelope.artifact;
    const descriptors =
      artifact.kind === "publication_prepared" && artifact.canonical?.kind === "threads"
        ? artifact.canonical.evidence
        : [];
    return descriptors.every(
      (read) =>
        read.headSha === envelope.binding.headSha && redactReviewText(read.path) === read.path,
    );
  }),
);
export type ReviewArtifactEnvelope = v.InferOutput<typeof envelopeSchema>;

export function reviewArtifactInvalid(reason: string): never {
  throw new AppError({
    domain: "publish_store",
    kind: "invalid_detail",
    message: "Review recovery artifact violates its storage contract",
    context: { reason },
  });
}

export function encodeReviewArtifact(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return entry;
  });
}

export function reviewArtifactHash(envelope: ReviewArtifactEnvelope): string {
  return createHash("sha256").update(encodeReviewArtifact(envelope), "utf8").digest("hex");
}

export function createReviewArtifactBinding(
  identity: ReviewArtifactIdentity,
  inputDigest: string,
): ReviewArtifactBinding {
  const parsed = v.safeParse(identitySchema, identity);
  if (!parsed.success || !v.is(hashSchema, inputDigest)) reviewArtifactInvalid("artifact_identity");
  return {
    ...parsed.output,
    inputFingerprint: createHash("sha256")
      .update(
        encodeReviewArtifact({
          identity: parsed.output,
          inputDigest,
          schemaVersion: REVIEW_ARTIFACT_SCHEMA_VERSION,
          contractVersion: REVIEW_CONTRACT_VERSION,
        }),
      )
      .digest("hex"),
  };
}

function logicalIdentity(artifact: ReviewArtifactEnvelope["artifact"]) {
  switch (artifact.kind) {
    case "brief":
      return { logicalKey: "brief", order: 0 };
    case "opened_paths":
      return { logicalKey: "opened-paths", order: 5 };
    case "report":
      return {
        logicalKey: `report/${artifact.specialist}`,
        order: 10 + ["correctness", "security", "quality", "tests"].indexOf(artifact.specialist),
      };
    case "publication_prepared":
      return {
        logicalKey: `decision/${artifact.sequence}/prepared`,
        order: 100 + artifact.sequence * 2,
      };
    case "publication_settled":
      return {
        logicalKey: `decision/${artifact.sequence}/settled`,
        order: 101 + artifact.sequence * 2,
      };
    case "final_summary":
      return { logicalKey: "final-summary", order: 1_000_000 };
    default: {
      const exhaustive: never = artifact;
      return exhaustive;
    }
  }
}

function redactStructuredOutput(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "string" ? redactReviewText(entry) : entry,
    ),
  );
}

function boundUnreadPaths(paths: readonly string[]): string[] {
  return persistedOpenedPaths(paths).slice(0, UNREAD_COVERAGE_PATH_LIMIT);
}

type ArtifactCanonical = NonNullable<
  Extract<ReviewArtifact, { kind: "publication_prepared" }>["canonical"]
>;

function boundPartialCoverage<T extends { readonly paths?: readonly string[] }>(coverage: T): T {
  if (coverage.paths == null) return coverage;
  return { ...coverage, paths: boundUnreadPaths(coverage.paths) };
}

function sanitizeCanonical(canonical: ArtifactCanonical): ArtifactCanonical {
  if (canonical.kind === "summary") {
    if (canonical.coverage.kind !== "partial") return canonical;
    return { ...canonical, coverage: boundPartialCoverage(canonical.coverage) };
  }
  const coverage = canonical.coverage;
  const openedPaths =
    canonical.openedPaths == null
      ? canonical.openedPaths
      : persistedOpenedPaths(canonical.openedPaths);
  if (coverage == null || coverage.kind !== "partial") {
    if (openedPaths === canonical.openedPaths) return canonical;
    return { ...canonical, openedPaths };
  }
  return {
    ...canonical,
    coverage: boundPartialCoverage(coverage),
    ...(openedPaths == null ? {} : { openedPaths }),
  };
}

function sanitizeArtifact(artifact: ReviewArtifact): ReviewArtifact {
  switch (artifact.kind) {
    case "brief":
    case "report":
      return artifact.openedPaths == null
        ? artifact
        : { ...artifact, openedPaths: persistedOpenedPaths(artifact.openedPaths) };
    case "opened_paths":
      return { ...artifact, paths: persistedOpenedPaths(artifact.paths) };
    case "publication_prepared":
      return artifact.canonical == null
        ? artifact
        : { ...artifact, canonical: sanitizeCanonical(artifact.canonical) };
    case "final_summary":
      return artifact.inputs == null
        ? artifact
        : { ...artifact, inputs: sanitizeCanonical(artifact.inputs) };
    default:
      return artifact;
  }
}

export function createReviewArtifactEnvelope(
  binding: ReviewArtifactBinding,
  artifact: ReviewArtifact,
): ReviewArtifactEnvelope {
  const parsed = v.safeParse(artifactSchema, sanitizeArtifact(artifact));
  if (!parsed.success || !v.is(bindingSchema, binding)) reviewArtifactInvalid("artifact_schema");
  const artifactValue = parsed.output;
  let output: unknown = artifactValue;
  switch (artifactValue.kind) {
    case "brief":
      output = { ...artifactValue, brief: redactStructuredOutput(artifactValue.brief) };
      break;
    case "opened_paths":
      output = { ...artifactValue, paths: redactStructuredOutput(artifactValue.paths) };
      break;
    case "report":
      output = { ...artifactValue, report: redactStructuredOutput(artifactValue.report) };
      break;
    case "publication_prepared":
      output = {
        ...artifactValue,
        payload: redactStructuredOutput(artifactValue.payload),
        ...(artifactValue.canonical
          ? { canonical: redactStructuredOutput(artifactValue.canonical) }
          : {}),
      };
      break;
    case "final_summary":
      output = {
        ...artifactValue,
        payload: redactStructuredOutput(artifactValue.payload),
        ...(artifactValue.inputs ? { inputs: redactStructuredOutput(artifactValue.inputs) } : {}),
      };
      break;
    case "publication_settled":
      break;
  }
  const redacted = v.safeParse(artifactSchema, output);
  if (!redacted.success) reviewArtifactInvalid("artifact_redaction");
  const envelope = v.safeParse(envelopeSchema, {
    schemaVersion: REVIEW_ARTIFACT_SCHEMA_VERSION,
    contractVersion: REVIEW_CONTRACT_VERSION,
    binding: v.parse(bindingSchema, binding),
    ...logicalIdentity(redacted.output),
    artifact: redacted.output,
  });
  if (!envelope.success) reviewArtifactInvalid("artifact_schema");
  return envelope.output;
}

export function parseReviewArtifactEnvelope(value: unknown): ReviewArtifactEnvelope | null {
  const parsed = v.safeParse(envelopeSchema, value);
  if (!parsed.success) return null;
  try {
    const rebuilt = createReviewArtifactEnvelope(parsed.output.binding, parsed.output.artifact);
    return encodeReviewArtifact(rebuilt) === encodeReviewArtifact(parsed.output) ? rebuilt : null;
  } catch (error) {
    if (error instanceof AppError && error.code === "publish_store.invalid_detail") return null;
    throw error;
  }
}

export function reviewArtifactDependencies(envelope: ReviewArtifactEnvelope) {
  const artifact = envelope.artifact;
  return artifact.kind === "publication_prepared" || artifact.kind === "final_summary"
    ? artifact.dependencies
    : [];
}
