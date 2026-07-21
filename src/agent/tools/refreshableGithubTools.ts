import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { AppError } from "../../errors/appError.js";
import { isInstallationTokenNearExpiry } from "../../github/installationTokenExpiry.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";

export type ToolExecutorBundle = {
  readonly piTools: PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
};

export type RefreshableToolExecutors = {
  readonly bundle: ToolExecutorBundle;
  readonly githubExecutorNames: ReadonlySet<string>;
  readonly refreshBeforeTool: (toolName: string) => Promise<void>;
  /** Near-expiry refresh that updates the live holder used by `getToken()` (decision 27). */
  readonly refreshNearExpiry: () => Promise<void>;
  /** Apply a freshly minted token into the live holder and rebuild GitHub executors. */
  readonly applyFreshToken: (fresh: { token: string; expiresAtTs: number }) => void;
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs: () => number;
};

export function createRefreshableToolExecutors(params: {
  initialToken: string;
  tokenExpiresAtTs: number;
  tokenTtlMs: number;
  build: (token: string, expiresAtTs: number) => ToolExecutorBundle;
  refreshInstallationToken?: () => Promise<{
    token: string;
    expiresAtTs: number;
  }>;
  githubToolNames?: ReadonlySet<string>;
}): RefreshableToolExecutors {
  if (!Number.isFinite(params.tokenTtlMs) || params.tokenTtlMs <= 0) {
    throw new AppError({
      code: "provider.invalid_token_ttl",
      message: "tokenTtlMs must be a positive finite duration in milliseconds",
    });
  }
  let activeToken = params.initialToken;
  let activeExpiresAtTs = params.tokenExpiresAtTs;
  let built = params.build(activeToken, activeExpiresAtTs);
  const executorStore: Record<string, AgentRunnerToolExecutor> = { ...built.executors };
  let bundle: ToolExecutorBundle = {
    piTools: built.piTools,
    executors: executorStore,
  };
  const githubExecutorNames = params.githubToolNames ?? new Set(Object.keys(executorStore));

  const applyFreshToken = (fresh: { token: string; expiresAtTs: number }): void => {
    activeToken = fresh.token;
    activeExpiresAtTs = fresh.expiresAtTs;
    built = params.build(activeToken, activeExpiresAtTs);
    Object.assign(executorStore, built.executors);
    bundle = { piTools: built.piTools, executors: executorStore };
  };

  const refreshNearExpiry = async (): Promise<void> => {
    if (!params.refreshInstallationToken) return;
    if (!isInstallationTokenNearExpiry(activeExpiresAtTs)) return;
    const fresh = await params.refreshInstallationToken();
    applyFreshToken(fresh);
  };

  const refreshBeforeTool = async (toolName: string): Promise<void> => {
    if (!githubExecutorNames.has(toolName)) return;
    await refreshNearExpiry();
  };

  return {
    get bundle() {
      return bundle;
    },
    githubExecutorNames,
    refreshBeforeTool,
    refreshNearExpiry,
    applyFreshToken,
    getToken: () => activeToken,
    getTokenExpiresAtTs: () => activeExpiresAtTs,
  };
}
