import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { logWarn } from "../../evlog.js";
import {
  LOCAL_WORKSPACE_FFF_CALL_TIMEOUT_MS,
  LOCAL_WORKSPACE_FFF_RESPAWN_BACKOFF_MS,
} from "../../settings/index.js";
import type { FffGrepResult, FffOpenResult } from "./host.js";

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

// Development and tests run TypeScript sources directly; the build emits host.js.
const hostPath = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./host.ts" : "./host.js", import.meta.url),
);

let child: ChildProcess | null = null;
let nextId = 1;
let unavailableUntil = 0;
const pending = new Map<number, Pending>();

function failPending(reason: string): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

function retire(target: ChildProcess, reason: string): void {
  if (child !== target) return;
  child = null;
  unavailableUntil = Date.now() + LOCAL_WORKSPACE_FFF_RESPAWN_BACKOFF_MS;
  failPending(reason);
  if (target.exitCode == null && target.signalCode == null) target.kill("SIGKILL");
  logWarn("workspace_search_fff_host_retired", { reason });
}

const responseSchema = v.variant("ok", [
  v.object({ id: v.number(), ok: v.literal(true), value: v.unknown() }),
  v.object({ id: v.number(), ok: v.literal(false), error: v.string() }),
]);

function onMessage(message: unknown): void {
  const parsed = v.safeParse(responseSchema, message);
  if (!parsed.success) return;
  const response = parsed.output;
  const entry = pending.get(response.id);
  if (entry == null) return;
  pending.delete(response.id);
  clearTimeout(entry.timer);
  if (response.ok) entry.resolve(response.value);
  else entry.reject(new Error(response.error));
}

function spawnHost(): ChildProcess {
  // The host gets no environment: it reads checkouts and never needs credentials.
  const spawned = fork(hostPath, [], {
    env: {},
    execArgv: [],
    serialization: "json",
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  spawned.on("message", onMessage);
  spawned.on("error", (error) => retire(spawned, `host_error:${error.message}`));
  spawned.on("exit", (code, signal) => retire(spawned, `host_exit:${signal ?? code ?? "unknown"}`));
  spawned.unref();
  spawned.channel?.unref();
  return spawned;
}

function request(message: Record<string, unknown>): Promise<unknown> {
  if (child == null) {
    if (Date.now() < unavailableUntil) return Promise.reject(new Error("host_backoff"));
    child = spawnHost();
  }
  const target = child;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => retire(target, "host_deadline"),
      LOCAL_WORKSPACE_FFF_CALL_TIMEOUT_MS,
    );
    pending.set(id, { resolve, reject, timer });
    target.send({ ...message, id }, (error) => {
      if (error) retire(target, `host_send:${error.message}`);
    });
  });
}

const openResultSchema = v.variant("status", [
  v.object({
    status: v.literal("ready"),
    files: v.array(v.object({ path: v.string(), size: v.number() })),
  }),
  v.object({ status: v.literal("too_large"), totalFiles: v.number() }),
]);

const grepResultSchema = v.object({
  hits: v.array(v.object({ path: v.string(), line: v.number() })),
  capped: v.boolean(),
});

export async function openFffIndex(params: {
  readonly key: string;
  readonly root: string;
  readonly scanTimeoutMs: number;
  readonly maxFiles: number;
  readonly maxIndexes: number;
}): Promise<FffOpenResult> {
  const parsed = v.safeParse(openResultSchema, await request({ op: "open", ...params }));
  if (!parsed.success) throw new Error("invalid_open_result");
  return parsed.output;
}

export async function grepFffIndex(params: {
  readonly key: string;
  readonly patterns: readonly string[];
  readonly denied: readonly string[];
  readonly maxMatchesPerFile: number;
  readonly maxMatches: number;
  readonly maxFileBytes: number;
  readonly pageSize: number;
  readonly timeBudgetMs: number;
}): Promise<FffGrepResult> {
  const parsed = v.safeParse(grepResultSchema, await request({ op: "grep", ...params }));
  if (!parsed.success) throw new Error("invalid_grep_result");
  return parsed.output;
}

export function closeFffIndex(key: string): void {
  if (child == null) return;
  request({ op: "close", key }).catch(() => {});
}
