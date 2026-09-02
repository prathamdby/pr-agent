import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { AppError } from "../../errors/appError.js";
import { assertWorkspacePath } from "../../prWorkspace/localPrWorkspace.js";
import { SENSITIVE_PATH_PATTERNS } from "../../settings/index.js";

/**
 * Execution-control and package-publishing surfaces triage must not modify.
 * Kept separate from credential-oriented SENSITIVE_PATH_PATTERNS so ask/review
 * tooling is not unexpectedly broadened.
 */
export const TRIAGE_CONTROL_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.github(\/|$)/i,
  /(^|\/)\.husky(\/|$)/i,
  /(^|\/)\.git\/hooks(\/|$)/i,
  /(^|\/)CODEOWNERS$/i,
  /(^|\/)\.pre-commit-config\.ya?ml$/i,
  /(^|\/)lefthook\.ya?ml$/i,
  /(^|\/)Dockerfile(?:\.[^/]+)?$/i,
  /(^|\/)docker-compose[^/]*\.ya?ml$/i,
  /(^|\/)compose[^/]*\.ya?ml$/i,
  /(^|\/)Chart\.ya?ml$/i,
  /(^|\/)values(?:\.[^/]+)?\.ya?ml$/i,
  /(^|\/)helm(\/|$)/i,
  /(^|\/)k8s(\/|$)/i,
  /(^|\/)kubernetes(\/|$)/i,
  /(^|\/)deploy(\/|$)/i,
  /(^|\/)deployment[s]?(\/|$)/i,
  /(^|\/)\.terraform(\/|$)/i,
  /\.tf$/i,
  /(^|\/)vercel\.json$/i,
  /(^|\/)netlify\.toml$/i,
  /(^|\/)fly\.toml$/i,
  /(^|\/)Procfile$/i,
  /(^|\/)\.circleci(\/|$)/i,
  /(^|\/)\.gitlab-ci\.ya?ml$/i,
  /(^|\/)cloudbuild\.ya?ml$/i,
  /(^|\/)buildspec\.ya?ml$/i,
  /(^|\/)Jenkinsfile$/i,
  /(^|\/)\.buildkite(\/|$)/i,
  /(^|\/)azure-pipelines(?:\.[^/]+)?\.ya?ml$/i,
  /(^|\/)\.travis\.ya?ml$/i,
  /(^|\/)bitbucket-pipelines\.ya?ml$/i,
  /(^|\/)appveyor\.ya?ml$/i,
  /(^|\/)\.drone\.ya?ml$/i,
  /(^|\/)Taskfile(?:\.[^/]+)?\.ya?ml$/i,
  /(^|\/)Makefile$/i,
  /(^|\/)package\.json$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)nub\.jsonc$/i,
  /(^|\/)\.yarnrc(?:\.yml)?$/i,
  /(^|\/)\.pnpmfile\.cjs$/i,
  /(^|\/)pnpm-workspace\.ya?ml$/i,
  /(^|\/)\.pubignore$/i,
  /(^|\/)pubspec\.ya?ml$/i,
  /(^|\/)\.gitmodules$/i,
  /(^|\/)pyproject\.toml$/i,
  /(^|\/)setup\.(?:py|cfg)$/i,
  /(^|\/)Cargo\.toml$/i,
  /(^|\/)go\.(?:mod|work)$/i,
  /(^|\/)Gemfile$/i,
  /(^|\/)build\.gradle(?:\.kts)?$/i,
  /(^|\/)pom\.xml$/i,
  /(^|\/)CMakeLists\.txt$/i,
  /(^|\/)bunfig\.toml$/i,
  /(^|\/)deno\.jsonc?$/i,
];

/** New files may only be created under these explicitly safe path classes. */
export const TRIAGE_SAFE_NEW_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)(__)?tests?(__)?\//i,
  /(^|\/)docs?\//i,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/i,
  /\.md$/i,
];

export function normalizeRepoRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

export function isTriageControlPath(path: string): boolean {
  const normalized = normalizeRepoRelativePath(path);
  return (
    SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    TRIAGE_CONTROL_PATH_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function isTriageSafeNewFilePath(path: string): boolean {
  const normalized = normalizeRepoRelativePath(path);
  if (isTriageControlPath(normalized)) return false;
  return TRIAGE_SAFE_NEW_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function throwBlocked(code: string, message: string, path: string): never {
  throw new AppError({
    code,
    message,
    context: { path },
  });
}

async function assertResolvedInsideRoot(root: string, candidate: string): Promise<string> {
  const realRoot = await realpath(root);
  const realCandidate = await realpath(candidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throwBlocked(
      "triage.symlink_escape_blocked",
      `Blocked path that resolves outside the triage checkout: "${candidate}"`,
      candidate,
    );
  }
  return realCandidate;
}

/**
 * Resolve a writable triage path, denying control-plane surfaces, path traversal,
 * and symlink escapes. Edits are limited to finding-implicated paths; creates must
 * match an explicitly safe path class.
 */
export async function assertTriageWritablePath(params: {
  readonly root: string;
  readonly path: string;
  readonly mode: "edit" | "create" | "stage";
  readonly implicatedPaths: ReadonlySet<string>;
}): Promise<{ readonly fullPath: string; readonly relativePath: string }> {
  const normalized = normalizeRepoRelativePath(params.path);
  const implicated = new Set(
    [...params.implicatedPaths].map((entry) => normalizeRepoRelativePath(entry)),
  );
  if (isTriageControlPath(normalized)) {
    throwBlocked(
      "triage.control_path_blocked",
      `Blocked triage write to control-plane path "${normalized}"`,
      normalized,
    );
  }

  if (params.mode === "edit") {
    if (!implicated.has(normalized)) {
      throwBlocked(
        "triage.path_not_implicated",
        `Triage may only edit files implicated by the finding inventory (blocked "${normalized}")`,
        normalized,
      );
    }
  }

  if (params.mode === "create" && !isTriageSafeNewFilePath(normalized)) {
    throwBlocked(
      "triage.unsafe_new_file_blocked",
      `Triage may only create files in explicitly safe path classes (blocked "${normalized}")`,
      normalized,
    );
  }

  if (params.mode === "stage") {
    if (!implicated.has(normalized) && !isTriageSafeNewFilePath(normalized)) {
      throwBlocked(
        "triage.path_not_implicated",
        `Triage may only stage implicated finding files or explicitly safe new files (blocked "${normalized}")`,
        normalized,
      );
    }
  }

  const fullPath = assertWorkspacePath(params.root, normalized);

  const probePath = params.mode === "create" ? dirname(fullPath) : fullPath;
  const probeStat = await lstat(probePath).catch(() => null);
  if (probeStat != null) {
    await assertResolvedInsideRoot(params.root, probePath);
  }

  return {
    fullPath,
    relativePath: relative(params.root, fullPath).replace(/\\/g, "/"),
  };
}

export function assertTriageStagePaths(params: {
  readonly root: string;
  readonly files: readonly string[];
  readonly implicatedPaths: ReadonlySet<string>;
}): Promise<readonly string[]> {
  return Promise.all(
    params.files.map(async (file) => {
      const resolved = await assertTriageWritablePath({
        root: params.root,
        path: file,
        mode: "stage",
        implicatedPaths: params.implicatedPaths,
      });
      return resolved.relativePath;
    }),
  );
}
