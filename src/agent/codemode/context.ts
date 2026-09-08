import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentLifecycleEvent } from "../runtime/lifecycleEvents.js";
import type { AgentSessionRole } from "../runtime/types.js";

export type CodeModeRunContext = {
  readonly signal?: AbortSignal;
  readonly emit?: (event: AgentLifecycleEvent) => void;
  readonly role?: AgentSessionRole;
  readonly provider?: string;
  readonly model?: string;
};

const storage = new AsyncLocalStorage<CodeModeRunContext>();

export function runWithCodeModeContext<T>(context: CodeModeRunContext, fn: () => T): T {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...context }, fn);
}

export function getCodeModeContext(): CodeModeRunContext {
  return storage.getStore() ?? {};
}
