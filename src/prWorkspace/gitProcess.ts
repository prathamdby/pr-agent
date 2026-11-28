import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  LOCAL_WORKSPACE_GIT_GROUP_POLL_MS,
  LOCAL_WORKSPACE_OBJECT_STORE_CAP_POLL_MS,
  LOCAL_WORKSPACE_GIT_KILL_CONFIRM_MS,
  LOCAL_WORKSPACE_GIT_KILL_GRACE_MS,
} from "../settings/index.ts";
import { objectStoreAllocatedBytes } from "./objectStoreBytes.ts";

export type GitGroupCleanup = "not_needed" | "complete" | "failed";

export type GitObjectStoreByteLimit = {
  readonly objectsDir: string;
  readonly maxBytes: number;
};

export type GitProcessResult = {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stderrLimited: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly outputLimited: boolean;
  readonly byteLimitExceeded: boolean;
  readonly objectStoreBytes: number | null;
  readonly objectStoreMonitorErrorCode: string | null;
  readonly killed: boolean;
  readonly spawnErrorCode: string | null;
  readonly cleanup: GitGroupCleanup;
  readonly cleanupErrorCode: string | null;
  readonly elapsedMs: number;
};

export type GitProcessOptions = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
  readonly stdin?: Buffer | string;
  readonly objectStoreByteLimit?: GitObjectStoreByteLimit;
};

type SignalOutcome = "delivered" | "gone" | { readonly errorCode: string };

function systemErrorCode(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return ((pinnedReturn: string) => pinnedReturn)(code);
  }
  return ((pinnedReturn: string) => pinnedReturn)("UNKNOWN");
}

function signalGroup(pgid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pgid, signal);
    return ((pinnedReturn: SignalOutcome) => pinnedReturn)("delivered");
  } catch (error) {
    const code = systemErrorCode(error);
    return ((pinnedReturn: SignalOutcome) => pinnedReturn)(
      code === "ESRCH" ? "gone" : { errorCode: code },
    );
  }
}

export function runGitProcess(args: readonly string[], options: GitProcessOptions) {
  return ((pinnedReturn: Promise<GitProcessResult>) => pinnedReturn)(
    new Promise((resolve) => {
      const startedAt = performance.now();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stderrLimited = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let exited = false;
      let closed = false;
      let timedOut = false;
      let outputLimited = false;
      let byteLimitExceeded = false;
      let objectStoreBytes: number | null = null;
      let objectStoreMonitorErrorCode: string | null = null;
      let killed = false;
      let spawnErrorCode: string | null = null;
      let termination: "idle" | "running" | GitGroupCleanup = "idle";
      let cleanupErrorCode: string | null = null;
      let settled = false;
      const timers = new Set<ReturnType<typeof setTimeout>>();

      const child = spawn("git", [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: [options.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const pgid = child.pid;

      const schedule = (ms: number, run: () => void) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          run();
        }, ms);
        timers.add(timer);
      };

      const clearTimers = () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      };

      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimers();
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        void (async () => {
          const limit = options.objectStoreByteLimit;
          if (limit != null && !byteLimitExceeded && objectStoreMonitorErrorCode == null) {
            try {
              const bytes = await objectStoreAllocatedBytes(limit.objectsDir);
              objectStoreBytes = Math.max(objectStoreBytes ?? 0, bytes);
              if (bytes > limit.maxBytes) byteLimitExceeded = true;
            } catch (error) {
              objectStoreMonitorErrorCode = systemErrorCode(error);
            }
          }
          resolve({
            stdout: Buffer.concat(stdoutChunks),
            stderr: Buffer.concat(stderrChunks),
            stderrLimited,
            exitCode,
            signal: exitSignal,
            timedOut,
            outputLimited,
            byteLimitExceeded,
            objectStoreBytes,
            objectStoreMonitorErrorCode,
            killed,
            spawnErrorCode,
            cleanup:
              termination === "idle" || termination === "running" ? "not_needed" : termination,
            cleanupErrorCode,
            elapsedMs: Math.round(performance.now() - startedAt),
          });
        })();
      };

      const maybeSettle = () => {
        if (settled) return;
        if (spawnErrorCode != null && pgid == null) {
          settle();
          return;
        }
        if (termination === "running") return;
        if (termination === "complete" || termination === "failed") {
          if (exited || termination === "failed") settle();
          return;
        }
        if (exited && closed) settle();
      };

      const finishTermination = (outcome: GitGroupCleanup, errorCode: string | null = null) => {
        if (termination !== "running") return;
        termination = outcome;
        cleanupErrorCode = errorCode;
        clearTimers();
        if (outcome === "complete" && !exited) {
          schedule(LOCAL_WORKSPACE_GIT_KILL_CONFIRM_MS, () => {
            exited = true;
            maybeSettle();
          });
        }
        maybeSettle();
      };

      const signalRunningGroup = (groupId: number, signal: 0 | "SIGKILL" | "SIGTERM") => {
        const outcome = signalGroup(groupId, signal);
        if (outcome === "delivered") return true;
        if (outcome === "gone") finishTermination("complete");
        else finishTermination("failed", outcome.errorCode);
        return false;
      };

      const pollGroupExit = (deadline: number, stage: "grace" | "confirm") => {
        if (pgid == null || termination !== "running" || !signalRunningGroup(pgid, 0)) return;
        if (performance.now() < deadline) {
          schedule(LOCAL_WORKSPACE_GIT_GROUP_POLL_MS, () => pollGroupExit(deadline, stage));
          return;
        }
        if (stage === "confirm") {
          finishTermination("complete");
          return;
        }
        if (!signalRunningGroup(pgid, "SIGKILL")) return;
        pollGroupExit(performance.now() + LOCAL_WORKSPACE_GIT_KILL_CONFIRM_MS, "confirm");
      };

      const terminate = () => {
        if (pgid == null || termination !== "idle" || settled) return;
        termination = "running";
        clearTimers();
        if (!signalRunningGroup(pgid, "SIGTERM")) return;
        killed =
          timedOut || outputLimited || byteLimitExceeded || objectStoreMonitorErrorCode != null;
        schedule(LOCAL_WORKSPACE_GIT_GROUP_POLL_MS, () =>
          pollGroupExit(performance.now() + LOCAL_WORKSPACE_GIT_KILL_GRACE_MS, "grace"),
        );
      };

      const collect = (chunks: Buffer[], stream: "stdout" | "stderr") => (chunk: Buffer) => {
        if (settled || outputLimited) return;
        const used = stream === "stdout" ? stdoutBytes : stderrBytes;
        const room = options.maxBufferBytes - used;
        const kept = chunk.length > room ? chunk.subarray(0, Math.max(room, 0)) : chunk;
        if (kept.length > 0) chunks.push(kept);
        if (stream === "stdout") stdoutBytes += kept.length;
        else stderrBytes += kept.length;
        if (chunk.length > room) {
          outputLimited = true;
          if (stream === "stderr") stderrLimited = true;
          terminate();
        }
      };

      child.stdout?.on("data", collect(stdoutChunks, "stdout"));
      child.stderr?.on("data", collect(stderrChunks, "stderr"));
      child.stdout?.on("error", () => undefined);
      child.stderr?.on("error", () => undefined);
      if (options.stdin != null && child.stdin != null) {
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.stdin);
      }

      child.on("error", (error) => {
        if (spawnErrorCode == null && !exited) spawnErrorCode = systemErrorCode(error);
        if (pgid == null) closed = true;
        maybeSettle();
      });
      child.on("exit", (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        if (pgid != null && termination === "idle" && !settled) {
          const probe = signalGroup(pgid, 0);
          if (probe === "delivered" && closed) terminate();
        }
        maybeSettle();
      });
      child.on("close", () => {
        closed = true;
        if (pgid != null && termination === "idle" && !settled && exited) {
          const probe = signalGroup(pgid, 0);
          if (probe === "delivered") {
            terminate();
            return;
          }
        }
        maybeSettle();
      });

      if (pgid != null) {
        schedule(Math.max(options.timeoutMs, 1), () => {
          if (settled || termination !== "idle") return;
          timedOut = true;
          terminate();
        });
      }

      const pollObjectStoreByteLimit = async () => {
        const limit = options.objectStoreByteLimit;
        if (limit == null) return;
        try {
          if (settled || termination !== "idle") return;
          const bytes = await objectStoreAllocatedBytes(limit.objectsDir);
          objectStoreBytes = Math.max(objectStoreBytes ?? 0, bytes);
          if (bytes > limit.maxBytes && !settled && termination === "idle") {
            byteLimitExceeded = true;
            terminate();
          }
        } catch (error) {
          objectStoreMonitorErrorCode = systemErrorCode(error);
          if (!settled && termination === "idle") terminate();
        } finally {
          if (!settled && termination === "idle") {
            schedule(LOCAL_WORKSPACE_OBJECT_STORE_CAP_POLL_MS, () => {
              void pollObjectStoreByteLimit();
            });
          }
        }
      };

      if (options.objectStoreByteLimit != null) {
        schedule(0, () => {
          void pollObjectStoreByteLimit();
        });
      }
    }),
  );
}
