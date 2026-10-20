import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import * as v from "valibot";
import { renderRepoPolicyTrustGuidance } from "../prompts/shared/safety.ts";
import { logWarn } from "../evlog.ts";
import {
  isAllowlistedPolicyPath,
  MAX_REPO_POLICY_BYTES,
  MAX_REPO_POLICY_FILE_BYTES,
  MAX_REPO_POLICY_FILES,
  MAX_REPO_POLICY_INSTRUCTION_CHARS,
  MAX_REPO_POLICY_PATH_PATTERN_CHARS,
  REPO_POLICY_DIRNAME,
  REPO_POLICY_EXTENSION,
} from "../settings/index.ts";
import { errorMessage } from "../errors/errorMessage.ts";

const frontmatterSchema = v.looseObject({
  globs: v.optional(v.union([v.string(), v.array(v.string())])),
  alwaysApply: v.optional(v.boolean()),
});

export type RepoPolicyRule = {
  readonly filename: string;
  readonly relativePath: string;
  readonly alwaysApply: boolean;
  readonly globs: readonly string[];
  readonly body: string;
};

export type RepoPolicy = {
  readonly rules: readonly RepoPolicyRule[];
};

export type RepoPolicyDrop = {
  readonly filename: string;
  readonly reason: "body-cut" | "file-skipped";
  readonly omittedChars?: number;
};

export type RepoPolicyResult =
  | { kind: "absent"; drops?: readonly RepoPolicyDrop[] }
  | { kind: "invalid"; reason: string; drops?: readonly RepoPolicyDrop[] }
  | { kind: "ok"; policy: RepoPolicy; drops?: readonly RepoPolicyDrop[] };

function matchesPathGlob(filename: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const globstarMiddle = "\0GLOBSTAR_MIDDLE\0";
  const globstarTrailing = "\0GLOBSTAR_TRAILING\0";
  const globstarLeading = "\0GLOBSTAR_LEADING\0";
  const globstarStandalone = "\0GLOBSTAR_STANDALONE\0";
  const regexString = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/(^|\/)\*\*(\/|$)/g, (_match, before, after) => {
      if (before && after) return globstarMiddle;
      if (before) return globstarTrailing;
      if (after) return globstarLeading;
      return globstarStandalone;
    })
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll(globstarMiddle, "/(?:.*/)?")
    .replaceAll(globstarTrailing, "/.*")
    .replaceAll(globstarLeading, "(?:^|.*/)")
    .replaceAll(globstarStandalone, ".*");
  return new RegExp(`^${regexString}$`).test(filename.replace(/\\/g, "/"));
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

function globMatchesFile(rule: RepoPolicyRule, file: string): boolean {
  return rule.globs.some((pattern) => matchesPathGlob(file, pattern));
}

export function ruleConsidersFile(rule: RepoPolicyRule, file: string): boolean {
  return rule.alwaysApply || globMatchesFile(rule, file);
}

function ruleApplies(rule: RepoPolicyRule, changedFiles?: readonly string[]): boolean {
  if (!changedFiles) return true;
  return changedFiles.some((filename) => ruleConsidersFile(rule, filename));
}

export type PolicyCandidatePair<T extends { readonly file: string }> = {
  readonly finding: T;
  readonly rule: RepoPolicyRule;
};

export function candidatePolicyPairs<T extends { readonly file: string }>(params: {
  readonly policy: RepoPolicyResult;
  readonly findings: readonly T[];
}): readonly PolicyCandidatePair<T>[] {
  if (params.policy.kind !== "ok") {
    return [];
  }
  const pairs: PolicyCandidatePair<T>[] = [];
  for (const finding of params.findings) {
    for (const rule of params.policy.policy.rules) {
      if (ruleConsidersFile(rule, finding.file)) {
        pairs.push({ finding, rule });
      }
    }
  }
  return pairs;
}

function parseMdcContent(
  raw: string,
):
  | { kind: "ok"; alwaysApply: boolean; globs: string[]; body: string; omittedChars: number }
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
    const validated = v.safeParse(frontmatterSchema, parsed ?? {});
    if (!validated.success) {
      return { kind: "invalid", reason: "frontmatter schema validation failed" };
    }
    alwaysApply = validated.output.alwaysApply;
    globs = normalizeGlobs(validated.output.globs);
  }

  const trimmedBody = bodyRaw.trim();
  const body = trimmedBody.slice(0, MAX_REPO_POLICY_INSTRUCTION_CHARS);
  if (!body) {
    return { kind: "invalid", reason: "empty body" };
  }

  return {
    kind: "ok",
    alwaysApply: effectiveAlwaysApply({ alwaysApply, globs }),
    globs,
    body,
    omittedChars: trimmedBody.length - body.length,
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
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export type RepoPolicyCandidate = {
  readonly path: string;
  readonly body: string;
};

function policyFilename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

export async function loadRepoPolicy(
  source: string | readonly RepoPolicyCandidate[],
  maxBytes: number = MAX_REPO_POLICY_BYTES,
): Promise<RepoPolicyResult> {
  if (typeof source !== "string") return loadRepoPolicyCandidates(source, maxBytes);
  return loadRepoPolicyFromCheckout(source, maxBytes);
}

type PolicyBodySource = {
  readonly filename: string;
  readonly relativePath: string;
  readonly logPath: string;
  readonly read: () => Promise<string>;
};

async function parseRepoPolicySources(
  sources: readonly PolicyBodySource[],
  maxBytes: number,
): Promise<RepoPolicyResult> {
  if (sources.length === 0) return { kind: "absent", drops: [] };

  const rules: RepoPolicyRule[] = [];
  const drops: RepoPolicyDrop[] = [];
  let aggregateBytes = 0;

  for (const source of sources.slice(MAX_REPO_POLICY_FILES)) {
    drops.push({ filename: source.filename, reason: "file-skipped" });
    logWarn("repo_policy_rule_skipped", {
      path: source.logPath,
      reason: "file cap exceeded",
    });
  }

  for (const source of sources.slice(0, MAX_REPO_POLICY_FILES)) {
    let raw: string;
    try {
      raw = await source.read();
    } catch (error) {
      const message = errorMessage(error);
      drops.push({ filename: source.filename, reason: "file-skipped" });
      logWarn("repo_policy_rule_skipped", { path: source.logPath, reason: message });
      continue;
    }

    const byteLength = Buffer.byteLength(raw, "utf8");
    if (byteLength > MAX_REPO_POLICY_FILE_BYTES) {
      drops.push({ filename: source.filename, reason: "file-skipped" });
      logWarn("repo_policy_rule_skipped", {
        path: source.logPath,
        reason: "file exceeds size cap",
      });
      continue;
    }
    if (aggregateBytes + byteLength > maxBytes) {
      drops.push({ filename: source.filename, reason: "file-skipped" });
      logWarn("repo_policy_rule_skipped", {
        path: source.logPath,
        reason: "aggregate size cap exceeded",
      });
      continue;
    }

    const parsed = parseMdcContent(raw);
    if (parsed.kind === "invalid") {
      drops.push({ filename: source.filename, reason: "file-skipped" });
      logWarn("repo_policy_rule_skipped", { path: source.logPath, reason: parsed.reason });
      continue;
    }
    if (parsed.omittedChars > 0) {
      drops.push({
        filename: source.filename,
        reason: "body-cut",
        omittedChars: parsed.omittedChars,
      });
      logWarn("repo_policy_body_cut", {
        path: source.logPath,
        omittedChars: parsed.omittedChars,
      });
    }

    aggregateBytes += byteLength;
    rules.push({
      filename: source.filename,
      relativePath: source.relativePath,
      alwaysApply: parsed.alwaysApply,
      globs: parsed.globs,
      body: parsed.body,
    });
  }

  if (rules.length === 0) {
    return { kind: "invalid", reason: "no usable .mdc rules", drops };
  }
  return { kind: "ok", policy: { rules }, drops };
}

async function loadRepoPolicyCandidates(
  candidates: readonly RepoPolicyCandidate[],
  maxBytes: number,
): Promise<RepoPolicyResult> {
  const sources = candidates
    .filter(
      (file) => isAllowlistedPolicyPath(file.path) && file.path.endsWith(REPO_POLICY_EXTENSION),
    )
    .map((file) => ({
      filename: policyFilename(file.path),
      relativePath: file.path,
      logPath: file.path,
      read: async () => file.body,
    }))
    .toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
  return parseRepoPolicySources(sources, maxBytes);
}

async function loadRepoPolicyFromCheckout(
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
      return { kind: "absent", drops: [] };
    }
    if (code === "ENOTDIR") {
      return { kind: "invalid", reason: "not a directory", drops: [] };
    }
    const message = errorMessage(error);
    return { kind: "invalid", reason: message, drops: [] };
  }

  const sources = entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(REPO_POLICY_EXTENSION) && !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .toSorted()
    .map((filename) => {
      const absolutePath = join(policyDir, filename);
      return {
        filename,
        relativePath: `${REPO_POLICY_DIRNAME}/${filename}`,
        logPath: absolutePath,
        read: () => readFile(absolutePath, "utf8"),
      };
    });
  return parseRepoPolicySources(sources, maxBytes);
}

export function renderRepoPolicyBlock(params: {
  policy: RepoPolicy;
  changedFiles?: readonly string[];
}): string {
  const { policy, changedFiles } = params;
  const applicableRules = policy.rules.filter((rule) => ruleApplies(rule, changedFiles));
  if (applicableRules.length === 0) {
    return "";
  }

  const lines = renderRepoPolicyTrustGuidance();
  for (const rule of applicableRules) {
    lines.push(`- Rule \`${rule.relativePath}\`: ${sanitizeRenderedPolicyText(rule.body)}`);
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
