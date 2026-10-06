export type TraceKind = "execution" | "session" | "generation" | "tool" | "compaction";
export type TracePartKind =
  | "system"
  | "user"
  | "assistant_text"
  | "thinking"
  | "tool_args"
  | "tool_result";
export type TracePart = {
  readonly kind: TracePartKind;
  readonly sha256: string;
  readonly body: string;
  readonly bytes: number;
  readonly redactions: number;
};
export type TraceSpan = {
  readonly id: string;
  readonly executionId: string;
  readonly parentId: string | null;
  readonly workItemId: string | null;
  readonly kind: TraceKind;
  readonly role: string | null;
  phase: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly specialist: string | null;
  readonly startedAt: Date;
  endedAt: Date;
  ttftMs: number | null;
  reasoningMs: number | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  costUsd: number | null;
  costSource: "provider" | "catalog" | "unknown";
  status: "ok" | "error" | "cancelled";
  errorCode: string | null;
  readonly attrs: Record<string, string | number | boolean | null>;
  readonly parts: TracePart[];
};
