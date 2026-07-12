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
    instructions: z.string().max(MAX_REPO_POLICY_INSTRUCTION_CHARS).optional(),
    lensOverrides: z.unknown().optional(),
  })
  .strict()
  .transform(({ lensOverrides: _ignored, ...policy }) => policy);

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
    if (Object.hasOwn(parsed, "lensOverrides")) {
      logWarn("repo_policy_lens_overrides_ignored", {
        path: policyPath,
      });
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
  changedFiles?: readonly string[];
}): string {
  const { policy, changedFiles } = params;
  const lines = ["Trusted context (repo policy):"];

  if (policy.tone) {
    lines.push(`- Tone: ${sanitizeRenderedPolicyText(policy.tone)}`);
  }
  if (policy.severityFloor != null) {
    lines.push(`- Severity floor: P${policy.severityFloor} and above`);
  }

  if (policy.instructions) {
    lines.push(`- Review instructions: ${sanitizeRenderedPolicyText(policy.instructions)}`);
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

/**
 * Render a short paste-ready `.pr-agent.yml` snippet for a dismissed finding.
 * Produces a pathInstructions entry with the finding's file pattern and a
 * one-line instruction distilled from the dismissal evidence.
 */
export function renderPolicySuggestionForDismissed(params: {
  readonly filePath: string;
  readonly dismissalEvidence: string;
}): string {
  const path = sanitizeRenderedPolicyText(params.filePath).slice(
    0,
    MAX_REPO_POLICY_PATH_PATTERN_CHARS,
  );
  const instruction = sanitizeRenderedPolicyText(params.dismissalEvidence).slice(
    0,
    MAX_REPO_POLICY_INSTRUCTION_CHARS,
  );
  return [
    "```yaml",
    "version: 1",
    "pathInstructions:",
    `  - path: "${path}"`,
    `    instructions: "${instruction}"`,
    "```",
  ].join("\n");
}
