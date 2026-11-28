import {
  botGitPerson,
  buildTriageCommitAttribution,
  formatCoAuthoredByTrailer,
  type GitPerson,
  type TriageCommitAttribution,
} from "../agent/triage/commitAttribution.ts";
import {
  createWritableRepositoryReader,
  runWorkspaceGit,
  assertWorkspacePath,
  type RepositoryReader,
} from "./repositoryReader.ts";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { BotIdentity } from "../github/appAuth.ts";
import { AppError, isAppError } from "../errors/appError.ts";
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
} from "../settings/index.ts";
import {
  isTriageControlPath,
  normalizeRepoRelativePath,
} from "../agent/triage/triageWritePolicy.ts";
import { cleanupStaleLocalPrWorkspaces, stripWorkspaceSymlinks } from "./localPrWorkspace.ts";
import { assertObjectStoreWithinCap, objectStoreAllocatedBytes } from "./objectStoreBytes.ts";
import {
  allocateWorkspaceResource,
  WRITABLE_WORKSPACE_ROOT_PREFIX,
  assertGitSha,
  assertGitRepoPart,
  ensureWorkspaceFreeSpaceAfterSweep,
} from "./workspaceResource.ts";

export type CommitArgs = {
  readonly files: readonly string[];
  readonly subject: string;
  readonly body?: readonly string[];
  readonly person?: GitPerson;
  readonly coAuthoredBy?: readonly GitPerson[];
};

export type WritablePrCheckout = {
  readonly dir: string;
  readonly reader: RepositoryReader;
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
    super({ domain: "triage", kind: "stale_head_push", message });
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
  readonly commitAttribution?: TriageCommitAttribution;
  readonly beforeCommit?: () => Promise<void>;
  readonly beforePush?: () => Promise<void>;
  readonly remoteUrlOverride?: string;
  readonly maxFetchBytes?: number;
};

function gitPersonHasForbiddenChars(value: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    value.includes("\r") || value.includes("\n") || value.includes("\0"),
  );
}

function validateGitPerson(person: GitPerson, field: string) {
  const name = person.name.trim();
  const email = person.email.trim();
  if (!name || name.includes("<") || name.includes(">") || gitPersonHasForbiddenChars(name)) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "commit_identity_invalid",
      message: `${field} name is invalid`,
      context: { field },
    });
  }
  if (
    !email.includes("@") ||
    email.includes("<") ||
    email.includes(">") ||
    gitPersonHasForbiddenChars(email)
  ) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "commit_identity_invalid",
      message: `${field} email is invalid`,
      context: { field },
    });
  }
}

function assertHeadRef(value: string) {
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
      domain: "pr_workspace",
      kind: "unsafe_head_ref",
      message: "headRef is not git-safe",
      context: { headRef: value },
    });
  }
}

function validateSubject(subject: string) {
  if (subject.length > TRIAGE_COMMIT_SUBJECT_MAX_CHARS) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "commit_subject_too_long",
      message: `Commit subject exceeds ${TRIAGE_COMMIT_SUBJECT_MAX_CHARS} characters`,
      context: { maxChars: TRIAGE_COMMIT_SUBJECT_MAX_CHARS },
    });
  }
  if (subject.endsWith(".")) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "commit_subject_trailing_period",
      message: "Commit subject must not end with a period",
    });
  }
  const types = TRIAGE_COMMIT_TYPES.join("|");
  const match = new RegExp(`^(${types}): ([^A-Z].*)$`).exec(subject);
  if (!match) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "commit_subject_invalid",
      message: "Commit subject does not match the triage commit contract",
    });
  }
}

function validateBody(body: readonly string[] | undefined) {
  if (!body || body.length === 0)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (body.length > TRIAGE_COMMIT_BODY_MAX_BULLETS) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "commit_body_too_many_bullets",
      message: `Commit body accepts at most ${TRIAGE_COMMIT_BODY_MAX_BULLETS} bullets`,
      context: { maxBullets: TRIAGE_COMMIT_BODY_MAX_BULLETS },
    });
  }
  for (const line of body) {
    if (!line.startsWith("- ")) {
      throw new AppError({
        domain: "pr_workspace",
        kind: "commit_body_invalid_prefix",
        message: "Commit body lines must start with '- '",
      });
    }
    if (line.endsWith(".")) {
      throw new AppError({
        domain: "pr_workspace",
        kind: "commit_body_trailing_period",
        message: "Commit body bullets must not end with a period",
      });
    }
    const firstWord = line.slice(2).trim().split(/\s+/, 1)[0] ?? "";
    if (!/^[A-Z]/.test(firstWord)) {
      throw new AppError({
        domain: "pr_workspace",
        kind: "commit_body_capitalization",
        message: "Commit body bullet first word must be capitalized",
      });
    }
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(body.join("\n"));
}

export function buildCommitCommandArgs(args: CommitArgs) {
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
  return ((pinnedReturn: readonly string[]) => pinnedReturn)(
    messageBody == null
      ? ["commit", "-n", "-m", args.subject]
      : ["commit", "-n", "-m", args.subject, "-m", messageBody],
  );
}

export function gitIdentityEnv(person: GitPerson) {
  validateGitPerson(person, "person");
  return ((pinnedReturn: Record<string, string>) => pinnedReturn)({
    GIT_AUTHOR_NAME: person.name,
    GIT_AUTHOR_EMAIL: person.email,
    GIT_COMMITTER_NAME: person.name,
    GIT_COMMITTER_EMAIL: person.email,
  });
}

function isBlockedCommitPath(canonicalPath: string) {
  const normalized = normalizeRepoRelativePath(canonicalPath);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    normalized.split("/").some((segment) => segment.toLowerCase() === ".git") ||
      SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized)) ||
      isTriageControlPath(normalized),
  );
}

async function lstatOrNull(candidatePath: string) {
  return ((pinnedReturn: Awaited<ReturnType<typeof lstat>> | null) => pinnedReturn)(
    await lstat(candidatePath).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        return null;
      }
      throw error;
    }),
  );
}

async function validateCommitFile(root: string, realRoot: string, requestedPath: string) {
  if (requestedPath.includes("\0")) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "path_traversal",
      message: `Path traversal attempt detected: ${requestedPath}`,
      context: { path: requestedPath },
    });
  }
  const fullPath = assertWorkspacePath(root, requestedPath);
  const canonicalPath = relative(root, fullPath).replace(/\\/g, "/");
  if (canonicalPath.length === 0 || canonicalPath === ".") {
    throw new AppError({
      domain: "pr_workspace",
      kind: "path_traversal",
      message: `Path traversal attempt detected: ${requestedPath}`,
      context: { path: requestedPath },
    });
  }
  if (isBlockedCommitPath(canonicalPath)) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "sensitive_path",
      message: `commitFix blocked sensitive path "${canonicalPath}"`,
      context: { path: canonicalPath },
    });
  }

  const segments = canonicalPath.split("/");
  let deepestExistingPath = root;
  let deepestExistingDepth = 0;
  let leafEntry: Awaited<ReturnType<typeof lstat>> | null = null;

  for (let index = 0; index < segments.length; index += 1) {
    const segmentPath = resolve(root, ...segments.slice(0, index + 1));
    const entry = await lstatOrNull(segmentPath);
    if (entry == null) break;
    if (entry.isSymbolicLink()) {
      throw new AppError({
        domain: "pr_workspace",
        kind: "symlink_escape",
        message: `Symlink escape blocked: ${requestedPath}`,
        context: { path: canonicalPath },
      });
    }
    deepestExistingPath = segmentPath;
    deepestExistingDepth = index + 1;
    if (index === segments.length - 1) {
      leafEntry = entry;
    }
  }

  if (leafEntry != null) {
    if (!leafEntry.isFile()) {
      throw new AppError({
        domain: "pr_workspace",
        kind: "path_traversal",
        message: `commitFix only accepts regular file paths: ${canonicalPath}`,
        context: { path: canonicalPath },
      });
    }
  }

  const realDeepest = await realpath(deepestExistingPath);
  if (realDeepest !== realRoot && !realDeepest.startsWith(realRoot + sep)) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "symlink_escape",
      message: `Symlink escape blocked: ${requestedPath}`,
      context: { path: canonicalPath },
    });
  }

  const realRelativeBase = relative(realRoot, realDeepest).replace(/\\/g, "/");
  const missingSuffix = segments.slice(deepestExistingDepth);
  const resolvedCanonicalPath = [
    ...(realRelativeBase.length > 0 ? [realRelativeBase] : []),
    ...missingSuffix,
  ].join("/");

  if (isBlockedCommitPath(resolvedCanonicalPath)) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "sensitive_path",
      message: `commitFix blocked sensitive path "${resolvedCanonicalPath}"`,
      context: { path: resolvedCanonicalPath },
    });
  }

  return ((pinnedReturn: { path: string; missing: boolean }) => pinnedReturn)({
    path: resolvedCanonicalPath,
    missing: leafEntry == null,
  });
}

async function validateFiles(
  root: string,
  files: readonly string[],
  git: (args: readonly string[]) => Promise<{ stdout: string }>,
) {
  if (files.length === 0) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "commit_fix_no_files",
      message: "commitFix requires at least one file",
    });
  }
  const realRoot = await realpath(root);
  const validated: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const { path: canonical, missing } = await validateCommitFile(root, realRoot, file);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    validated.push(canonical);
    if (validated.length > TRIAGE_COMMIT_MAX_FILES) {
      throw new AppError({
        domain: "pr_workspace",
        kind: "commit_fix_too_many_files",
        message: `commitFix accepts at most ${TRIAGE_COMMIT_MAX_FILES} files`,
        context: { maxFiles: TRIAGE_COMMIT_MAX_FILES },
      });
    }
    if (missing) {
      const { stdout } = await git(["ls-tree", "-z", "HEAD", "--", `:(literal)${canonical}`]);
      if (
        !/^100(?:644|755) blob [a-f0-9]+\t/.test(stdout) ||
        stdout.slice(stdout.indexOf("\t") + 1) !== `${canonical}\0`
      ) {
        throw new AppError({
          domain: "pr_workspace",
          kind: "path_traversal",
          message: `commitFix requires an exact tracked file for deletion: ${canonical}`,
          context: { path: canonical },
        });
      }
    }
  }
  return ((pinnedReturn: readonly string[]) => pinnedReturn)(validated);
}

function changedLineCount(diff: string) {
  return ((pinnedReturn: number) => pinnedReturn)(
    diff
      .split("\n")
      .filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
      .length,
  );
}

function classifyPushError(error: unknown): never {
  const stderr = isAppError(error) ? error.context.stderr : undefined;
  if (
    typeof stderr === "string" &&
    /non-fast-forward|fetch first|stale info|rejected/i.test(stderr)
  ) {
    throw new StaleHeadPushError();
  }
  throw error;
}

export async function withWritablePrCheckout<T>(
  params: WritablePrCheckoutParams,
  fn: (checkout: WritablePrCheckout) => Promise<T>,
) {
  const { owner, repo, headRef, headSha, installationToken, botIdentity } = params;
  assertGitRepoPart(owner, "owner");
  assertGitRepoPart(repo, "repo");
  assertHeadRef(headRef);
  assertGitSha(headSha, "headSha");
  await ensureWorkspaceFreeSpaceAfterSweep(
    tmpdir(),
    LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
    "Insufficient free space for writable checkout",
    () => cleanupStaleLocalPrWorkspaces(),
  );

  const resource = await allocateWorkspaceResource({
    prefix: WRITABLE_WORKSPACE_ROOT_PREFIX,
    installationToken,
  });
  try {
    const rootDir = resource.rootDir;
    const credentials = resource.credentials;
    const dir = join(rootDir, "checkout");
    const remoteUrl = params.remoteUrlOverride ?? `https://github.com/${owner}/${repo}.git`;
    const maxFetchBytes = params.maxFetchBytes ?? LOCAL_WORKSPACE_MAX_FETCH_BYTES;
    const committed: { sha: string; subject: string; diff: string }[] = [];
    const defaultAttribution =
      params.commitAttribution ?? buildTriageCommitAttribution({ botIdentity, triggerer: null });
    const botPerson = botGitPerson(botIdentity);

    const git = (
      args: readonly string[],
      timeoutMs = LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
      extraEnv?: Record<string, string>,
    ) =>
      runWorkspaceGit(args, {
        cwd: dir,
        timeoutMs,
        askpass: credentials.askpass,
        tokenFile: credentials.tokenFile,
        extraEnv,
        objectStoreByteLimit: {
          objectsDir: join(dir, ".git", "objects"),
          maxBytes: maxFetchBytes,
        },
        redactSecrets: [installationToken],
      });

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
    assertObjectStoreWithinCap(
      await objectStoreAllocatedBytes(join(dir, ".git", "objects")),
      maxFetchBytes,
    );
    await git(["checkout", "-f", "FETCH_HEAD"], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    assertObjectStoreWithinCap(
      await objectStoreAllocatedBytes(join(dir, ".git", "objects")),
      maxFetchBytes,
    );
    const { stdout: fetchedHead } = await git(["rev-parse", "HEAD"]);
    if (fetchedHead.trim().toLowerCase() !== headSha.toLowerCase()) {
      throw new AppError({
        domain: "pr_workspace",
        kind: "head_sha_mismatch",
        message: `Fetched PR head ${fetchedHead.trim()} does not match expected headSha ${headSha}`,
        context: { fetchedHead: fetchedHead.trim(), headSha },
      });
    }
    await stripWorkspaceSymlinks(dir);
    await git(["config", "user.name", botPerson.name], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    await git(["config", "user.email", botPerson.email], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    const checkout: WritablePrCheckout = {
      dir,
      reader: createWritableRepositoryReader(dir, {
        objectsDir: join(dir, ".git", "objects"),
        maxBytes: maxFetchBytes,
      }),
      headRef,
      baseSha: headSha,
      commit: async (args) => {
        const files = await validateFiles(dir, args.files, git);
        const person = args.person ?? defaultAttribution.person;
        const coAuthoredBy = args.coAuthoredBy ?? defaultAttribution.coAuthoredBy;
        const commitArgs = buildCommitCommandArgs({
          files,
          subject: args.subject,
          body: args.body,
          coAuthoredBy,
        });
        const pathspecs = files.map((file) => `:(literal)${file}`);
        await git(["reset"], LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
        await git(["add", "--", ...pathspecs], LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
        const { stdout: diff } = await git(
          ["diff", "--cached", "--", ...pathspecs],
          LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
        );
        if (changedLineCount(diff) > TRIAGE_MAX_COMMIT_DIFF_LINES) {
          await git(["reset"], LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
          throw new AppError({
            domain: "pr_workspace",
            kind: "commit_diff_not_minimal",
            message: "commitFix rejected: staged diff is not minimal",
          });
        }
        await params.beforeCommit?.();
        await git(commitArgs, LOCAL_WORKSPACE_FETCH_TIMEOUT_MS, gitIdentityEnv(person));
        const { stdout: sha } = await git(["rev-parse", "HEAD"], LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
        const committedSha = sha.trim();
        committed.push({ sha: committedSha, subject: args.subject, diff });
        return { sha: committedSha, diff };
      },
      push: async () => {
        await params.beforePush?.();
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

    return ((pinnedReturn: T | Promise<T>) => pinnedReturn)(await fn(checkout));
  } finally {
    await resource.release();
  }
}
