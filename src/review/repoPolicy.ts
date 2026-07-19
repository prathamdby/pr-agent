import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { logWarn } from "../evlog.js";
import {
  MAX_REPO_POLICY_INSTRUCTION_CHARS,
  MAX_REPO_POLICY_PATH_INSTRUCTIONS,
  MAX_REPO_POLICY_PATH_PATTERN_CHARS,
  MAX_REPO_POLICY_TONE_CHARS,
  REPO_POLICY_FILENAME,
} from "../settings/index.js";
import type { ReviewMode } from "./reviewSchema.js";

const repoPolicySchema = z
  .object({
    version: z.literal(1),
    tone: z.string().max(MAX_REPO_POLICY_TONE_CHARS).optional(),
    severityFloor: z.number().int().min(0).max(3).optional(),
    pathInstructions: z
      .array(
        z.object({
          path: z.string().max(MAX_REPO_POLICY_PATH_PATTERN_CHARS),
          instructions: z.string().max(MAX_REPO_POLICY_INSTRUCTION_CHARS),
        }),
      )
      .max(MAX_REPO_POLICY_PATH_INSTRUCTIONS)
      .optional(),
    lensOverrides: z
      .record(
        z.string(),
        z.object({
          instructions: z.string().max(MAX_REPO_POLICY_INSTRUCTION_CHARS).optional(),
        }),
      )
      .optional(),
  })
  .strict();

export type RepoPolicy = z.infer<typeof repoPolicySchema>;

export type RepoPolicyResult =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; policy: RepoPolicy };

function matchesPathGlob(filename: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__GLOBSTAR__/g, ".*");
  return new RegExp(`^${escaped}$`).test(filename);
}

function sanitizeRenderedPolicyText(value: string): string {
  return value.split(/\r?\n/).join(" ").trim();
}

function escapeYamlDoubleQuoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export async function loadRepoPolicy(
  agentCwd: string,
  maxBytes: number,
): Promise<RepoPolicyResult> {
  const policyPath = join(agentCwd, REPO_POLICY_FILENAME);
  try {
    const fileStat = await stat(policyPath);
    if (!fileStat.isFile()) {
      return { kind: "invalid", reason: "not a file" };
    }
    if (fileStat.size > maxBytes) {
      return { kind: "invalid", reason: "file exceeds size cap" };
    }
    const raw = await readFile(policyPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
      return { kind: "invalid", reason: "file exceeds size cap" };
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      return { kind: "invalid", reason: "malformed yaml" };
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "invalid", reason: "root must be a mapping" };
    }
    const validated = repoPolicySchema.safeParse(parsed);
    if (!validated.success) {
      return { kind: "invalid", reason: "schema validation failed" };
    }
    return { kind: "ok", policy: validated.data };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { kind: "absent" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "invalid", reason: message };
  }
}

export function renderRepoPolicyBlock(params: {
  policy: RepoPolicy;
  mode: ReviewMode;
  changedFiles?: readonly string[];
}): string {
  const { policy, mode, changedFiles } = params;
  const lines = ["Trusted context (repo policy):"];

  if (policy.tone) {
    lines.push(`- Tone: ${sanitizeRenderedPolicyText(policy.tone)}`);
  }
  if (policy.severityFloor != null) {
    lines.push(`- Severity floor: P${policy.severityFloor} and above`);
  }

  const lensInstructions = policy.lensOverrides?.[mode]?.instructions;
  if (lensInstructions) {
    lines.push(`- Lens instructions: ${sanitizeRenderedPolicyText(lensInstructions)}`);
  }

  const pathEntries = policy.pathInstructions ?? [];
  const matchingPaths = changedFiles
    ? pathEntries.filter((entry) =>
        changedFiles.some((filename) => matchesPathGlob(filename, entry.path)),
      )
    : pathEntries;
  for (const entry of matchingPaths) {
    lines.push(`- Path ${entry.path}: ${sanitizeRenderedPolicyText(entry.instructions)}`);
  }

  if (lines.length === 1) {
    return "";
  }
  return lines.join("\n");
}

export function logInvalidRepoPolicy(agentCwd: string, reason: string): void {
  logWarn("repo_policy_invalid", {
    path: join(agentCwd, REPO_POLICY_FILENAME),
    reason,
  });
}

function policyEntryYaml(params: {
  readonly filePath: string;
  readonly dismissalEvidence: string;
}): { readonly path: string; readonly instruction: string; readonly entryLines: string[] } {
  const path = escapeYamlDoubleQuoted(
    sanitizeRenderedPolicyText(params.filePath).slice(0, MAX_REPO_POLICY_PATH_PATTERN_CHARS),
  );
  const instruction = escapeYamlDoubleQuoted(
    sanitizeRenderedPolicyText(params.dismissalEvidence).slice(
      0,
      MAX_REPO_POLICY_INSTRUCTION_CHARS,
    ),
  );
  return {
    path,
    instruction,
    entryLines: [`  - path: "${path}"`, `    instructions: "${instruction}"`],
  };
}

/**
 * Render a paste-ready `.pr-agent.yml` suggestion for a dismissed finding.
 * When an existing valid policy is provided, emit only the append fragment;
 * otherwise emit a full starter file so new repos know the shape.
 */
export function renderPolicySuggestionForDismissed(params: {
  readonly filePath: string;
  readonly dismissalEvidence: string;
  readonly policyResult?: RepoPolicyResult;
}): string {
  const { entryLines } = policyEntryYaml(params);
  const policyResult = params.policyResult ?? { kind: "absent" as const };

  if (policyResult.kind === "ok") {
    return [
      `Append this entry under \`pathInstructions\` in \`${REPO_POLICY_FILENAME}\`:`,
      "",
      "```yaml",
      ...entryLines,
      "```",
    ].join("\n");
  }

  if (policyResult.kind === "invalid") {
    return [
      `\`${REPO_POLICY_FILENAME}\` exists but could not be used (${policyResult.reason}).`,
      "Replace or fix it using this starter:",
      "",
      "```yaml",
      "version: 1",
      "pathInstructions:",
      ...entryLines,
      "```",
    ].join("\n");
  }

  return [
    `Create \`${REPO_POLICY_FILENAME}\` with:`,
    "",
    "```yaml",
    "version: 1",
    "pathInstructions:",
    ...entryLines,
    "```",
  ].join("\n");
}
