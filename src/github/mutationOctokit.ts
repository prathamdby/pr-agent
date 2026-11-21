import { Octokit } from "@octokit/rest";

export const MUTATION_WRITE_TIMEOUT_MS = 20_000;

export type MutationOctokit = Octokit;

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export function isMutationRequest(options: {
  readonly method?: string;
  readonly url?: string;
  readonly [key: string]: unknown;
}) {
  const method = (options.method ?? "GET").toUpperCase();
  if (READ_METHODS.has(method)) return false;
  if (options.url === "/graphql") {
    return typeof options.query === "string" && /^\s*mutation\b/.test(options.query);
  }
  return true;
}

export function createMutationOctokit(params: {
  readonly token?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}) {
  const octokit = new Octokit({
    ...(params.token !== undefined ? { auth: params.token } : {}),
    ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
  });
  const timeoutMs = params.timeoutMs ?? MUTATION_WRITE_TIMEOUT_MS;
  octokit.hook.wrap("request", (request, options) => {
    const writeTimeout = AbortSignal.timeout(timeoutMs);
    const callerSignal = options.request?.signal;
    return request({
      ...options,
      request: {
        ...options.request,
        signal:
          callerSignal instanceof AbortSignal
            ? AbortSignal.any([callerSignal, writeTimeout])
            : writeTimeout,
      },
    });
  });
  return ((pinnedReturn: MutationOctokit) => pinnedReturn)(octokit);
}
