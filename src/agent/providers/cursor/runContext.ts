import type { Context } from "@earendil-works/pi-ai";

export type CursorExecutor = (args: Record<string, unknown>) => Promise<unknown>;

export type CursorRunContext = {
  readonly executors: Record<string, CursorExecutor>;
  readonly apiKey: string;
  readonly cwd?: string;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly maxToolRounds?: number;
};

const cursorRunContexts = new WeakMap<Context, CursorRunContext>();

export function attachCursorRunContext(context: Context, bundle: CursorRunContext): void {
  cursorRunContexts.set(context, bundle);
}

export function getCursorRunContext(context: Context): CursorRunContext | undefined {
  return cursorRunContexts.get(context);
}

export function detachCursorRunContext(context: Context): void {
  cursorRunContexts.delete(context);
}
