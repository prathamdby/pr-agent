import * as v from "valibot";
import { wrapUntrustedBlock } from "../../agent/prompts/promptBlocks.js";
import { createFeaturePiSession } from "../../agent/runtime/createFeatureSession.js";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import type { EvidenceLedger } from "../findings/evidenceLedger.js";
import { reviewFindingPlacementKey } from "../placement/reviewDiffPlacement.js";
import {
  candidatePolicyPairs,
  ruleConsidersFile,
  type RepoPolicyResult,
  type RepoPolicyRule,
} from "../repoPolicy.js";
import type { ReviewFinding } from "../reviewSchema.js";

const BOUND_POLICY_JUDGE_TIMEOUT_MS = 20_000;
const BOUND_POLICY_SNIPPET_MAX_CHARS = 1_500;

const yesIdsSchema = v.object({
  yes: v.array(v.string()),
});

export type BoundPolicyJudgePair = {
  readonly id: string;
  readonly relativePath: string;
  readonly body: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly detail: string;
  readonly severity: ReviewFinding["severity"];
  readonly snippet?: string;
};

export type BoundPolicyJudge = (
  pairs: readonly BoundPolicyJudgePair[],
) => Promise<readonly string[]>;

export type NumberedPolicyPair = {
  readonly id: string;
  readonly finding: ReviewFinding;
  readonly rule: RepoPolicyRule;
};

export const BOUND_POLICY_JUDGE_SYSTEM_PROMPT = [
  "You judge whether a review finding violates a bound same-repo repo policy rule.",
  "Most findings do not violate a given always-apply rule. Default no.",
  "You receive only the asked pairs. Each pair is self-contained.",
  'Reply with JSON only: {"yes":["p0"]} using pair ids from the asked list.',
  "Include an id only when the finding is an evidenced violation of that pair's rule.",
  "Never invent a path. Never emit an id that was not asked. When unsure, omit the id.",
].join("\n");

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("bound policy judge response contained no JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

/** Keep only asked pair ids. Extra or unparsable entries drop. */
export function parseBoundPolicyYesIds(
  text: string,
  askedIds: ReadonlySet<string>,
): readonly string[] {
  try {
    const parsed = v.safeParse(yesIdsSchema, extractJsonObject(text));
    if (!parsed.success) return [];
    return parsed.output.yes.filter((id) => askedIds.has(id));
  } catch {
    return [];
  }
}

export function numberCandidatePairs(
  pairs: readonly { readonly finding: ReviewFinding; readonly rule: RepoPolicyRule }[],
): readonly NumberedPolicyPair[] {
  return pairs.map((pair, index) => ({
    id: `p${index}`,
    finding: pair.finding,
    rule: pair.rule,
  }));
}

export async function citedSnippetForFinding(params: {
  readonly finding: ReviewFinding;
  readonly evidenceLedger?: EvidenceLedger;
  readonly isPathInCheckout?: (path: string) => boolean;
  readonly readCheckoutFile?: (path: string) => Promise<string | undefined>;
}): Promise<string | undefined> {
  const { finding } = params;
  if (!params.evidenceLedger?.covers(finding.file, finding.startLine, finding.endLine)) {
    return undefined;
  }
  if (params.isPathInCheckout != null && !params.isPathInCheckout(finding.file)) {
    return undefined;
  }
  if (params.readCheckoutFile == null) return undefined;
  const text = await params.readCheckoutFile(finding.file);
  if (text == null || text.length === 0) return undefined;
  const lines = text.split(/\r?\n/);
  const slice = lines
    .slice(finding.startLine - 1, finding.endLine)
    .join("\n")
    .trim();
  if (!slice) return undefined;
  return slice.slice(0, BOUND_POLICY_SNIPPET_MAX_CHARS);
}

export function buildBoundPolicyJudgePairs(
  numbered: readonly NumberedPolicyPair[],
  snippets: ReadonlyMap<string, string | undefined>,
): readonly BoundPolicyJudgePair[] {
  return numbered.map((pair) => ({
    id: pair.id,
    relativePath: pair.rule.relativePath,
    body: pair.rule.body,
    file: pair.finding.file,
    startLine: pair.finding.startLine,
    endLine: pair.finding.endLine,
    title: pair.finding.title,
    detail: pair.finding.detail,
    severity: pair.finding.severity,
    snippet: snippets.get(pair.id),
  }));
}

export function buildBoundPolicyJudgeUserMessage(pairs: readonly BoundPolicyJudgePair[]): string {
  const asked = pairs.map((pair) => pair.id).join(", ");
  const blocks = pairs.map((pair) => {
    const findingLines = [
      `id: ${pair.id}`,
      `file: ${pair.file}`,
      `lines: ${pair.startLine}-${pair.endLine}`,
      `severity: ${pair.severity}`,
      `title: ${pair.title}`,
      `detail: ${pair.detail}`,
      ...(pair.snippet ? [`snippet: ${pair.snippet}`] : []),
    ].join("\n");
    return [
      `Pair ${pair.id}`,
      `Rule \`${pair.relativePath}\`: ${pair.body}`,
      wrapUntrustedBlock("bound_policy_finding", findingLines),
    ].join("\n");
  });
  return [
    "Return the yes subset of these asked pair ids. Default no.",
    `Asked ids: ${asked}`,
    "",
    ...blocks,
  ].join("\n");
}

export function attachJudgedBoundPaths(params: {
  readonly pairs: readonly NumberedPolicyPair[];
  readonly yesIds: readonly string[];
}): ReadonlyMap<string, readonly string[]> {
  const asked = new Map(params.pairs.map((pair) => [pair.id, pair]));
  const yes = new Set(params.yesIds.filter((id) => asked.has(id)));
  const byFinding = new Map<string, string[]>();
  for (const pair of params.pairs) {
    if (!yes.has(pair.id)) continue;
    if (!ruleConsidersFile(pair.rule, pair.finding.file)) continue;
    const key = reviewFindingPlacementKey(pair.finding);
    const paths = byFinding.get(key) ?? [];
    if (!paths.includes(pair.rule.relativePath)) {
      paths.push(pair.rule.relativePath);
    }
    byFinding.set(key, paths);
  }
  return byFinding;
}

export async function resolveBoundPolicyFooters(params: {
  readonly policy: RepoPolicyResult;
  readonly sameRepo?: boolean;
  readonly findings: readonly ReviewFinding[];
  readonly judge?: BoundPolicyJudge;
  readonly evidenceLedger?: EvidenceLedger;
  readonly isPathInCheckout?: (path: string) => boolean;
  readonly readCheckoutFile?: (path: string) => Promise<string | undefined>;
}): Promise<ReadonlyMap<string, readonly string[]>> {
  const numbered = numberCandidatePairs(
    candidatePolicyPairs({
      policy: params.policy,
      sameRepo: params.sameRepo,
      findings: params.findings,
    }),
  );
  if (numbered.length === 0 || params.judge == null) {
    return new Map();
  }

  const snippets = new Map<string, string | undefined>();
  for (const pair of numbered) {
    snippets.set(
      pair.id,
      await citedSnippetForFinding({
        finding: pair.finding,
        evidenceLedger: params.evidenceLedger,
        isPathInCheckout: params.isPathInCheckout,
        readCheckoutFile: params.readCheckoutFile,
      }),
    );
  }

  const judgePairs = buildBoundPolicyJudgePairs(numbered, snippets);
  let yesIds: readonly string[] = [];
  try {
    yesIds = await params.judge(judgePairs);
  } catch (error) {
    logWarn("bound_policy_judge_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
  return attachJudgedBoundPaths({ pairs: numbered, yesIds });
}

export function createBoundPolicyJudge(cfg: Config): BoundPolicyJudge {
  return async (pairs) => {
    if (pairs.length === 0) return [];
    const askedIds = new Set(pairs.map((pair) => pair.id));
    const session = await createFeaturePiSession({
      role: "ci_summary",
      cfg,
      systemPrompt: BOUND_POLICY_JUDGE_SYSTEM_PROMPT,
      tools: [],
      executors: {},
    });
    try {
      const turn = await session.send(buildBoundPolicyJudgeUserMessage(pairs), {
        maxToolRounds: 0,
        phase: "ci_summary",
        checkpointId: "bound_policy:judge",
        deadlineMs: BOUND_POLICY_JUDGE_TIMEOUT_MS,
      });
      return parseBoundPolicyYesIds(turn.text, askedIds);
    } catch (error) {
      logWarn("bound_policy_judge_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      await session.dispose();
    }
  };
}
