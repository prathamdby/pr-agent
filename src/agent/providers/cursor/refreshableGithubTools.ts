import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { isInstallationTokenNearExpiry } from "../../../github/githubRequestError.js";
import type { CursorExecutor } from "./runContext.js";

export type ToolExecutorBundle = {
  readonly piTools: PiTool[];
  readonly executors: Record<string, CursorExecutor>;
};

export type RefreshableToolExecutors = {
  readonly bundle: ToolExecutorBundle;
  readonly githubExecutorNames: ReadonlySet<string>;
  readonly refreshBeforeTool: (toolName: string) => Promise<void>;
  readonly getToken: () => string;
};

export function createRefreshableToolExecutors(params: {
  initialToken: string;
  tokenExpiresAtTs: number;
  build: (token: string) => ToolExecutorBundle;
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  githubToolNames?: ReadonlySet<string>;
}): RefreshableToolExecutors {
  let activeToken = params.initialToken;
  let activeExpiresAtTs = params.tokenExpiresAtTs;
  let built = params.build(activeToken);
  const executorStore: Record<string, CursorExecutor> = { ...built.executors };
  let bundle: ToolExecutorBundle = { piTools: built.piTools, executors: executorStore };
  const githubExecutorNames = params.githubToolNames ?? new Set(Object.keys(executorStore));

  const refreshBeforeTool = async (toolName: string): Promise<void> => {
    if (!githubExecutorNames.has(toolName)) return;
    if (!params.refreshInstallationToken) return;
    if (!isInstallationTokenNearExpiry(activeExpiresAtTs)) return;
    const fresh = await params.refreshInstallationToken();
    activeToken = fresh.token;
    activeExpiresAtTs = fresh.expiresAtTs;
    built = params.build(activeToken);
    Object.assign(executorStore, built.executors);
    bundle = { piTools: built.piTools, executors: executorStore };
  };

  return {
    get bundle() {
      return bundle;
    },
    githubExecutorNames,
    refreshBeforeTool,
    getToken: () => activeToken,
  };
}

export function patchExecutor(
  executors: Record<string, CursorExecutor>,
  name: string,
  wrap: (original: CursorExecutor) => CursorExecutor,
): void {
  const original = executors[name];
  if (!original) return;
  executors[name] = wrap(original);
}
