import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { logWarn } from "../evlog.js";
import {
  MAX_REPO_POLICY_BYTES,
  MAX_REPO_POLICY_FILE_BYTES,
  MAX_REPO_POLICY_FILES,
  MAX_REPO_POLICY_INSTRUCTION_CHARS,
  MAX_REPO_POLICY_PATH_PATTERN_CHARS,
  REPO_POLICY_DIRNAME,
  REPO_POLICY_EXTENSION,
} from "../settings/index.js";

const frontmatterSchema = z
  .object({
    globs: z.union([z.string(), z.array(z.string())]).optional(),
    alwaysApply: z.boolean().optional(),
  })
  .passthrough();

type RepoPolicyRule = {
  readonly filename: string;
  readonly relativePath: string;
  readonly alwaysApply: boolean;
  readonly globs: readonly string[];
  readonly body: string;
};

export type RepoPolicy = {
  readonly rules: readonly RepoPolicyRule[];
};

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

function normalizeGlobs(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .map((glob) => glob.trim().slice(0, MAX_REPO_POLICY_PATH_PATTERN_CHARS))
    .filter((glob) => glob.length > 0);
}

function effectiveAlwaysApply(params: {
  readonly alwaysApply: boolean | undefined;
  readonly globs: readonly string[];
}): boolean {
  if (params.alwaysApply === true) return true;
  if (params.alwaysApply === false) return false;
  return params.globs.length === 0;
}

function ruleApplies(rule: RepoPolicyRule, changedFiles?: readonly string[]): boolean {
  if (rule.alwaysApply) return true;
  if (!changedFiles) return true;
  return rule.globs.some((pattern) =>
    changedFiles.some((filename) => matchesPathGlob(filename, pattern)),
  );
}

function parseMdcContent(
  raw: string,
):
  | { kind: "ok"; alwaysApply: boolean; globs: string[]; body: string }
  | { kind: "invalid"; reason: string } {
  const trimmed = raw.replace(/^\uFEFF/, "");
  let frontmatterRaw: string | undefined;
  let bodyRaw: string;

  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    if (end === -1) {
      return { kind: "invalid", reason: "unclosed frontmatter" };
    }
    frontmatterRaw = trimmed.slice(3, end).replace(/^\r?\n/, "");
    bodyRaw = trimmed.slice(end + 4).replace(/^\r?\n/, "");
  } else {
    bodyRaw = trimmed;
  }

  let alwaysApply: boolean | undefined;
  let globs: string[] = [];
  if (frontmatterRaw != null && frontmatterRaw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = parseYaml(frontmatterRaw);
    } catch {
      return { kind: "invalid", reason: "malformed frontmatter yaml" };
    }
    if (parsed != null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      return { kind: "invalid", reason: "frontmatter must be a mapping" };
    }
    const validated = frontmatterSchema.safeParse(parsed ?? {});
    if (!validated.success) {
      return { kind: "invalid", reason: "frontmatter schema validation failed" };
    }
    alwaysApply = validated.data.alwaysApply;
    globs = normalizeGlobs(validated.data.globs);
  }

  const body = bodyRaw.trim().slice(0, MAX_REPO_POLICY_INSTRUCTION_CHARS);
  if (!body) {
    return { kind: "invalid", reason: "empty body" };
  }

  return {
    kind: "ok",
    alwaysApply: effectiveAlwaysApply({ alwaysApply, globs }),
    globs,
    body,
  };
}

function policySlugFromPath(filePath: string): string {
  const parts = filePath.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return "policy";
  const raw = parts
    .map((part, index) => (index === parts.length - 1 ? part.replace(/\.[^.]+$/, "") : part))
    .join("-");
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "policy";
}

function defaultGlobsForPath(filePath: string): string[] {
  const sanitized = sanitizeRenderedPolicyText(filePath).slice(
    0,
    MAX_REPO_POLICY_PATH_PATTERN_CHARS,
  );
  if (!sanitized) return ["**/*"];
  return [sanitized];
}

function errnoCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export async function loadRepoPolicy(
  agentCwd: string,
  maxBytes: number = MAX_REPO_POLICY_BYTES,
): Promise<RepoPolicyResult> {
  const policyDir = join(agentCwd, REPO_POLICY_DIRNAME);
  let entries;
  try {
    entries = await readdir(policyDir, { withFileTypes: true });
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") {
      return { kind: "absent" };
    }
    if (code === "ENOTDIR") {
      return { kind: "invalid", reason: "not a directory" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "invalid", reason: message };
  }

  const candidates = entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(REPO_POLICY_EXTENSION) && !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .toSorted();

  if (candidates.length === 0) {
    return { kind: "absent" };
  }

  const rules: RepoPolicyRule[] = [];
  let aggregateBytes = 0;

  for (const filename of candidates.slice(0, MAX_REPO_POLICY_FILES)) {
    const absolutePath = join(policyDir, filename);
    let raw: string;
    try {
      raw = await readFile(absolutePath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn("repo_policy_rule_skipped", { path: absolutePath, reason: message });
      continue;
    }

    const byteLength = Buffer.byteLength(raw, "utf8");
    if (byteLength > MAX_REPO_POLICY_FILE_BYTES) {
      logWarn("repo_policy_rule_skipped", {
        path: absolutePath,
        reason: "file exceeds size cap",
      });
      continue;
    }
    if (aggregateBytes + byteLength > maxBytes) {
      logWarn("repo_policy_rule_skipped", {
        path: absolutePath,
        reason: "aggregate size cap exceeded",
      });
      continue;
    }

    const parsed = parseMdcContent(raw);
    if (parsed.kind === "invalid") {
      logWarn("repo_policy_rule_skipped", { path: absolutePath, reason: parsed.reason });
      continue;
    }

    aggregateBytes += byteLength;
    rules.push({
      filename,
      relativePath: `${REPO_POLICY_DIRNAME}/${filename}`,
      alwaysApply: parsed.alwaysApply,
      globs: parsed.globs,
      body: parsed.body,
    });
  }

  if (rules.length === 0) {
    return { kind: "invalid", reason: "no usable .mdc rules" };
  }
  return { kind: "ok", policy: { rules } };
}

export function renderRepoPolicyBlock(params: {
  policy: RepoPolicy;
  changedFiles?: readonly string[];
}): string {
  const { policy, changedFiles } = params;
  const lines = ["Trusted context (repo policy):"];

  for (const rule of policy.rules) {
    if (!ruleApplies(rule, changedFiles)) continue;
    lines.push(`- Rule \`${rule.relativePath}\`: ${sanitizeRenderedPolicyText(rule.body)}`);
  }

  if (lines.length === 1) {
    return "";
  }
  return lines.join("\n");
}

function renderNewMdcSuggestion(params: {
  readonly relativePath: string;
  readonly globs: readonly string[];
  readonly instruction: string;
  readonly preamble?: string;
}): string {
  const lines = [
    ...(params.preamble ? [params.preamble] : []),
    `Create \`${params.relativePath}\` with:`,
    "",
    "```mdc",
    "---",
    "globs:",
    ...params.globs.map((glob) => `  - "${glob}"`),
    "alwaysApply: false",
    "---",
    "",
    params.instruction,
    "```",
  ];
  return lines.join("\n");
}

/**
 * Render a paste-ready `.pr-agent/*.mdc` suggestion for a dismissed finding.
 * When exactly one existing rule matches the finding path, emit an append
 * fragment; otherwise emit a full starter `.mdc` file.
 */
export function renderPolicySuggestionForDismissed(params: {
  readonly filePath: string;
  readonly dismissalEvidence: string;
  readonly policyResult?: RepoPolicyResult;
}): string {
  const policyResult = params.policyResult ?? { kind: "absent" as const };
  const instruction = sanitizeRenderedPolicyText(params.dismissalEvidence).slice(
    0,
    MAX_REPO_POLICY_INSTRUCTION_CHARS,
  );
  const globs = defaultGlobsForPath(params.filePath);
  const newRelativePath = `${REPO_POLICY_DIRNAME}/${policySlugFromPath(params.filePath)}${REPO_POLICY_EXTENSION}`;

  if (policyResult.kind === "ok") {
    const matches = policyResult.policy.rules.filter((rule) =>
      ruleApplies(rule, [params.filePath]),
    );
    if (matches.length === 1) {
      const target = matches[0];
      return [`Append this to \`${target.relativePath}\`:`, "", "```md", instruction, "```"].join(
        "\n",
      );
    }
  }

  return renderNewMdcSuggestion({
    relativePath: newRelativePath,
    globs,
    instruction,
    preamble:
      policyResult.kind === "invalid"
        ? `\`${REPO_POLICY_DIRNAME}/\` exists but could not be used (${policyResult.reason}).`
        : undefined,
  });
}
