import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import type { BotIdentity } from "../github/appAuth.js";
import { AppError } from "../errors/appError.js";
import {
  SENSITIVE_PATH_PATTERNS,
  TRIAGE_COMMIT_BODY_MAX_BULLETS,
  TRIAGE_COMMIT_MAX_FILES,
  TRIAGE_COMMIT_SUBJECT_MAX_CHARS,
  TRIAGE_COMMIT_TYPES,
  TRIAGE_MAX_COMMIT_DIFF_LINES,
  LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  LOCAL_WORKSPACE_MAX_FETCH_BYTES,
  LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
} from "../settings/index.js";
import { isTriageControlPath } from "../agent/triage/triageWritePolicy.js";
import { createGitCredentialFiles, makeDirectoriesWritable } from "./gitCredentials.js";
import {
  assertWorkspacePath,
  cleanupStaleLocalPrWorkspaces,
  registerLiveLocalPrWorkspace,
  unregisterLiveLocalPrWorkspace,
  stripWorkspaceSymlinks,
} from "./localPrWorkspace.js";

const exec = promisify(execFile);
const WORKSPACE_ROOT_PREFIX = "pr-agent-triage-";

/** Git author/committer or Co-authored-by person. */
export type GitPerson = {
  readonly name: string;
  readonly email: string;
};

export type CommitArgs = {
  readonly files: readonly string[];
  readonly subject: string;
  readonly body?: readonly string[];
  /** When set, overrides author and committer for this commit via GIT_* env. */
  readonly person?: GitPerson;
  /** Co-authored-by trailers appended after body bullets (blank line before trailers). */
  readonly coAuthoredBy?: readonly GitPerson[];
};

/** Per-run triage commit identity: human triggerer path or App fallback. */
export type TriageCommitAttribution = {
  readonly person: GitPerson;
  readonly coAuthoredBy: readonly GitPerson[];
  readonly source: "human" | "app";
};

export type WritablePrCheckout = {
  readonly dir: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly commit: (args: CommitArgs) => Promise<{ sha: string; diff: string }>;
  readonly push: () => Promise<void>;
  readonly listCommittedShas: () => readonly string[];
  readonly listCommittedDetails: () => readonly {
    readonly sha: string;
    readonly subject: string;
    readonly diff: string;
  }[];
};

export class StaleHeadPushError extends AppError {
  constructor(message = "Pull request head moved before triage push") {
    super({ code: "triage.stale_head_push", message });
    this.name = "StaleHeadPushError";
  }
}

type WritablePrCheckoutParams = {
  readonly owner: string;
  readonly repo: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly installationToken: string;
  readonly botIdentity: BotIdentity;
  /**
   * Default identity for every commit in this checkout.
   * Human path: triggerer as author+committer and App as Co-authored-by.
   * Omitted or App source: bot author+committer with no App Co-authored-by.
   */
  readonly commitAttribution?: TriageCommitAttribution;
  readonly remoteUrlOverride?: string;
};

export function githubNoreplyEmail(userId: number, login: string): string {
  return `${userId}+${login}@users.noreply.github.com`;
}

export function botGitPerson(bot: BotIdentity): GitPerson {
  return {
    name: bot.login,
    email: githubNoreplyEmail(bot.userId, bot.login),
  };
}

/**
 * Build commit attribution for a triage run.
 * Human path when `triggerer` is set; otherwise App author+committer with no App co-author trailer.
 */
export function buildTriageCommitAttribution(params: {
  readonly botIdentity: BotIdentity;
  readonly triggerer: GitPerson | null;
}): TriageCommitAttribution {
  const bot = botGitPerson(params.botIdentity);
  if (params.triggerer == null) {
    return { person: bot, coAuthoredBy: [], source: "app" };
  }
  return {
    person: params.triggerer,
    coAuthoredBy: [bot],
    source: "human",
  };
}

/**
 * Map a GitHub user profile to a git person.
 * Bot accounts and missing login/id return null (caller falls back to App).
 * Private/missing profile email uses id-based noreply (still human path).
 */
export function gitPersonFromGithubUser(user: {
  readonly id: number;
  readonly login: string;
  readonly name?: string | null;
  readonly email?: string | null;
  readonly type?: string;
}): GitPerson | null {
  if (!Number.isFinite(user.id) || user.id <= 0) return null;
  const login = user.login?.trim();
  if (!login) return null;
  if (user.type === "Bot" || login.endsWith("[bot]")) return null;
  const name = (user.name?.trim() || login).trim();
  if (!name) return null;
  const email = (user.email?.trim() || githubNoreplyEmail(user.id, login)).trim();
  if (!email.includes("@")) return null;
  return { name, email };
}

export function formatCoAuthoredByTrailer(person: GitPerson): string {
  return `Co-authored-by: ${person.name} <${person.email}>`;
}

function validateGitPerson(person: GitPerson, field: string): void {
  const name = person.name.trim();
  const email = person.email.trim();
  if (!name || name.includes("<") || name.includes(">")) {
    throw new AppError({
      code: "pr_workspace.commit_identity_invalid",
      message: `${field} name is invalid`,
      context: { field },
    });
  }
  if (!email.includes("@") || email.includes("<") || email.includes(">")) {
    throw new AppError({
      code: "pr_workspace.commit_identity_invalid",
      message: `${field} email is invalid`,
      context: { field },
    });
  }
}

function assertSha(value: string, field: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new AppError({
      code: "pr_workspace.invalid_sha",
      message: `${field} must be a 40-character SHA`,
      context: { field },
    });
  }
}

function assertRepoPart(value: string, field: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new AppError({
      code: "pr_workspace.unsafe_repo_part",
      message: `${field} is not git-safe`,
      context: { field },
    });
  }
}

function assertHeadRef(value: string): void {
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.startsWith("-") ||
    !/^[A-Za-z0-9._/-]+$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("\\") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.split("/").some((part) => part.length === 0 || part.endsWith(".lock"))
  ) {
    throw new AppError({
      code: "pr_workspace.unsafe_head_ref",
      message: "headRef is not git-safe",
      context: { headRef: value },
    });
  }
}

function validateSubject(subject: string): void {
  if (subject.length > TRIAGE_COMMIT_SUBJECT_MAX_CHARS) {
    throw new AppError({
      code: "pr_workspace.commit_subject_too_long",
      message: `Commit subject exceeds ${TRIAGE_COMMIT_SUBJECT_MAX_CHARS} characters`,
      context: { maxChars: TRIAGE_COMMIT_SUBJECT_MAX_CHARS },
    });
  }
  if (subject.endsWith(".")) {
    throw new AppError({
      code: "pr_workspace.commit_subject_trailing_period",
      message: "Commit subject must not end with a period",
    });
  }
  const types = TRIAGE_COMMIT_TYPES.join("|");
  const match = new RegExp(`^(${types}): ([^A-Z].*)$`).exec(subject);
  if (!match) {
    throw new AppError({
      code: "pr_workspace.commit_subject_invalid",
      message: "Commit subject does not match the triage commit contract",
    });
  }
}

function validateBody(body: readonly string[] | undefined): string | undefined {
  if (!body || body.length === 0) return undefined;
  if (body.length > TRIAGE_COMMIT_BODY_MAX_BULLETS) {
    throw new AppError({
      code: "pr_workspace.commit_body_too_many_bullets",
      message: `Commit body accepts at most ${TRIAGE_COMMIT_BODY_MAX_BULLETS} bullets`,
      context: { maxBullets: TRIAGE_COMMIT_BODY_MAX_BULLETS },
    });
  }
  for (const line of body) {
    if (!line.startsWith("- ")) {
      throw new AppError({
        code: "pr_workspace.commit_body_invalid_prefix",
        message: "Commit body lines must start with '- '",
      });
    }
    if (line.endsWith(".")) {
      throw new AppError({
        code: "pr_workspace.commit_body_trailing_period",
        message: "Commit body bullets must not end with a period",
      });
    }
    const firstWord = line.slice(2).trim().split(/\s+/, 1)[0] ?? "";
    if (!/^[A-Z]/.test(firstWord)) {
      throw new AppError({
        code: "pr_workspace.commit_body_capitalization",
        message: "Commit body bullet first word must be capitalized",
      });
    }
  }
  return body.join("\n");
}

export function buildCommitCommandArgs(args: CommitArgs): readonly string[] {
  validateSubject(args.subject);
  const body = validateBody(args.body);
  const coAuthors = args.coAuthoredBy ?? [];
  for (const person of coAuthors) {
    validateGitPerson(person, "coAuthoredBy");
  }
  const trailerBlock =
    coAuthors.length === 0
      ? undefined
      : coAuthors.map((person) => formatCoAuthoredByTrailer(person)).join("\n");
  let messageBody: string | undefined;
  if (body != null && trailerBlock != null) {
    messageBody = `${body}\n\n${trailerBlock}`;
  } else if (body != null) {
    messageBody = body;
  } else if (trailerBlock != null) {
    messageBody = trailerBlock;
  }
  return messageBody == null
    ? ["commit", "-n", "-m", args.subject]
    : ["commit", "-n", "-m", args.subject, "-m", messageBody];
}

/** Env overrides so author and committer match without rewriting global user.* mid-run. */
export function gitIdentityEnv(person: GitPerson): Record<string, string> {
  validateGitPerson(person, "person");
  return {
    GIT_AUTHOR_NAME: person.name,
    GIT_AUTHOR_EMAIL: person.email,
    GIT_COMMITTER_NAME: person.name,
    GIT_COMMITTER_EMAIL: person.email,
  };
}

function validateFiles(root: string, files: readonly string[]): readonly string[] {
  const normalized = [...new Set(files.map((file) => file.replace(/\\/g, "/")))];
  if (normalized.length === 0) {
    throw new AppError({
      code: "pr_workspace.commit_fix_no_files",
      message: "commitFix requires at least one file",
    });
  }
  if (normalized.length > TRIAGE_COMMIT_MAX_FILES) {
    throw new AppError({
      code: "pr_workspace.commit_fix_too_many_files",
      message: `commitFix accepts at most ${TRIAGE_COMMIT_MAX_FILES} files`,
      context: { maxFiles: TRIAGE_COMMIT_MAX_FILES },
    });
  }
  for (const file of normalized) {
    const resolved = assertWorkspacePath(root, file);
    if (!resolved.startsWith(root + sep) && resolved !== root) {
      throw new AppError({
        code: "pr_workspace.path_traversal",
        message: `Path traversal attempt detected: ${file}`,
        context: { path: file },
      });
    }
    if (
      SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(file)) ||
      isTriageControlPath(file)
    ) {
      throw new AppError({
        code: "pr_workspace.sensitive_path",
        message: `commitFix blocked sensitive path "${file}"`,
        context: { path: file },
      });
    }
  }
  return normalized;
}

function changedLineCount(diff: string): number {
  return diff
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
    .length;
}

async function ensureFreeSpace(dir: string, minBytes: number): Promise<void> {
  const fs = await statfs(dir);
  const freeBytes = BigInt(fs.bavail) * BigInt(fs.bsize);
  if (freeBytes < BigInt(minBytes)) {
    throw new AppError({
      code: "pr_workspace.insufficient_free_space",
      message: "Insufficient free space for writable checkout",
      context: { minBytes },
    });
  }
}

async function ensureWritableCheckoutMinFreeSpace(dir: string, minBytes: number): Promise<void> {
  try {
    await ensureFreeSpace(dir, minBytes);
  } catch (error) {
    if (!(error instanceof AppError && error.code === "pr_workspace.insufficient_free_space")) {
      throw error;
    }
    await cleanupStaleLocalPrWorkspaces();
    await ensureFreeSpace(dir, minBytes);
  }
}

function gitObjectStoreBytes(countObjectsOutput: string): number {
  let sizeKiB = 0;
  let sizePackKiB = 0;
  for (const line of countObjectsOutput.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = Number(line.slice(colon + 1).trim());
    if (Number.isNaN(value)) continue;
    if (key === "size") sizeKiB = value;
    if (key === "size-pack") sizePackKiB = value;
  }
  return (sizeKiB + sizePackKiB) * 1024;
}

function classifyPushError(error: unknown): never {
  const text =
    error instanceof Error
      ? `${error.message}\n${"stderr" in error && typeof error.stderr === "string" ? error.stderr : ""}`
      : String(error);
  if (/non-fast-forward|fetch first|stale info|rejected/i.test(text)) {
    throw new StaleHeadPushError();
  }
  throw error;
}

async function removeWorkspace(rootDir: string): Promise<void> {
  await makeDirectoriesWritable(rootDir);
  await rm(rootDir, { recursive: true, force: true });
}

export async function withWritablePrCheckout<T>(
  params: WritablePrCheckoutParams,
  fn: (checkout: WritablePrCheckout) => Promise<T>,
): Promise<T> {
  const { owner, repo, headRef, headSha, installationToken, botIdentity } = params;
  assertRepoPart(owner, "owner");
  assertRepoPart(repo, "repo");
  assertHeadRef(headRef);
  assertSha(headSha, "headSha");
  await ensureWritableCheckoutMinFreeSpace(tmpdir(), LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES);

  const rootDir = await mkdtemp(join(tmpdir(), WORKSPACE_ROOT_PREFIX));
  registerLiveLocalPrWorkspace(rootDir);
  const dir = join(rootDir, "checkout");
  const remoteUrl = params.remoteUrlOverride ?? `https://github.com/${owner}/${repo}.git`;
  const credentials = await createGitCredentialFiles(rootDir, installationToken);
  const committed: { sha: string; subject: string; diff: string }[] = [];
  const defaultAttribution =
    params.commitAttribution ?? buildTriageCommitAttribution({ botIdentity, triggerer: null });
  const botPerson = botGitPerson(botIdentity);

  const baseGitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_ASKPASS: credentials.askpass,
    GIT_TOKEN_FILE: credentials.tokenFile,
  };

  const git = (
    args: readonly string[],
    timeoutMs = LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
    extraEnv?: Record<string, string>,
  ) =>
    exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: dir,
      env: extraEnv ? { ...baseGitEnv, ...extraEnv } : baseGitEnv,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });

  try {
    await mkdir(dir, { recursive: true });
    await git(["init"], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    await git(["remote", "add", "origin", remoteUrl], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    await git(
      [
        "fetch",
        "--no-tags",
        "--depth=1",
        "--no-recurse-submodules",
        "origin",
        `refs/heads/${headRef}`,
      ],
      LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
    );
    const { stdout: objectStats } = await git(
      ["count-objects", "-v"],
      LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
    );
    if (gitObjectStoreBytes(objectStats) > LOCAL_WORKSPACE_MAX_FETCH_BYTES) {
      throw new AppError({
        code: "pr_workspace.fetch_too_large",
        message: `PR fetch object store exceeds LOCAL_WORKSPACE_MAX_FETCH_BYTES (${LOCAL_WORKSPACE_MAX_FETCH_BYTES})`,
        context: { maxFetchBytes: LOCAL_WORKSPACE_MAX_FETCH_BYTES },
      });
    }
    await git(["checkout", "-f", "FETCH_HEAD"], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    const { stdout: fetchedHead } = await git(["rev-parse", "HEAD"]);
    if (fetchedHead.trim().toLowerCase() !== headSha.toLowerCase()) {
      throw new AppError({
        code: "pr_workspace.head_sha_mismatch",
        message: `Fetched PR head ${fetchedHead.trim()} does not match expected headSha ${headSha}`,
        context: { fetchedHead: fetchedHead.trim(), headSha },
      });
    }
    await stripWorkspaceSymlinks(dir);
    // Fallback identity for git ops that do not set GIT_* env (commit always sets env).
    await git(["config", "user.name", botPerson.name], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    await git(["config", "user.email", botPerson.email], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    const checkout: WritablePrCheckout = {
      dir,
      headRef,
      baseSha: headSha,
      commit: async (args) => {
        const files = validateFiles(dir, args.files);
        const person = args.person ?? defaultAttribution.person;
        const coAuthoredBy = args.coAuthoredBy ?? defaultAttribution.coAuthoredBy;
        const commitArgs = buildCommitCommandArgs({
          files: args.files,
          subject: args.subject,
          body: args.body,
          coAuthoredBy,
        });
        await git(["reset"], LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
        await git(["add", "--", ...files], LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
        const { stdout: diff } = await git(
          ["diff", "--cached", "--", ...files],
          LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
        );
        if (changedLineCount(diff) > TRIAGE_MAX_COMMIT_DIFF_LINES) {
          await git(["reset"], LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
          throw new AppError({
            code: "pr_workspace.commit_diff_not_minimal",
            message: "commitFix rejected: staged diff is not minimal",
          });
        }
        await git(commitArgs, LOCAL_WORKSPACE_FETCH_TIMEOUT_MS, gitIdentityEnv(person));
        const { stdout: sha } = await git(["rev-parse", "HEAD"], LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
        const committedSha = sha.trim();
        committed.push({ sha: committedSha, subject: args.subject, diff });
        return { sha: committedSha, diff };
      },
      push: async () => {
        try {
          await git(
            ["push", "origin", `HEAD:refs/heads/${headRef}`],
            LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
          );
        } catch (error) {
          classifyPushError(error);
        }
      },
      listCommittedShas: () => committed.map((item) => item.sha),
      listCommittedDetails: () => [...committed],
    };

    return await fn(checkout);
  } finally {
    unregisterLiveLocalPrWorkspace(rootDir);
    await credentials.cleanup().catch(() => undefined);
    await removeWorkspace(rootDir).catch(() => undefined);
  }
}
