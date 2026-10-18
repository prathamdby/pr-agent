import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  LOCAL_WORKSPACE_GIT_GROUP_POLL_MS,
  LOCAL_WORKSPACE_GIT_KILL_CONFIRM_MS,
  LOCAL_WORKSPACE_GIT_KILL_GRACE_MS,
} from "../settings/index.ts";

export type GitGroupCleanup = "not_needed" | "complete" | "failed";

export type GitProcessResult = {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stderrLimited: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly outputLimited: boolean;
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
};

type SignalOutcome = "delivered" | "gone" | { readonly errorCode: string };

function systemErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code;
  }
  return "UNKNOWN";
}

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): SignalOutcome {
  try {
    process.kill(-pgid, signal);
    return "delivered";
  } catch (error) {
    const code = systemErrorCode(error);
    return code === "ESRCH" ? "gone" : { errorCode: code };
  }
}

export function runGitProcess(
  args: readonly string[],
  options: GitProcessOptions,
): Promise<GitProcessResult> {
  return new Promise((resolve) => {
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pgid = child.pid;

    const schedule = (ms: number, run: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
    };

    const clearTimers = (): void => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        stderrLimited,
        exitCode,
        signal: exitSignal,
        timedOut,
        outputLimited,
        killed,
        spawnErrorCode,
        cleanup: termination === "idle" || termination === "running" ? "not_needed" : termination,
        cleanupErrorCode,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    };

    const maybeSettle = (): void => {
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

    const finishTermination = (outcome: GitGroupCleanup, errorCode: string | null = null): void => {
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

    const confirmGone = (deadline: number): void => {
      if (pgid == null) return;
      const probe = signalGroup(pgid, 0);
      if (probe === "gone") {
        finishTermination("complete");
        return;
      }
      if (probe !== "delivered") {
        finishTermination("failed", probe.errorCode);
        return;
      }
      if (performance.now() >= deadline) {
        finishTermination("complete");
        return;
      }
      schedule(LOCAL_WORKSPACE_GIT_GROUP_POLL_MS, () => confirmGone(deadline));
    };

    const escalate = (): void => {
      if (pgid == null || termination !== "running") return;
      const outcome = signalGroup(pgid, "SIGKILL");
      if (outcome === "gone") {
        finishTermination("complete");
        return;
      }
      if (outcome !== "delivered") {
        finishTermination("failed", outcome.errorCode);
        return;
      }
      confirmGone(performance.now() + LOCAL_WORKSPACE_GIT_KILL_CONFIRM_MS);
    };

    const watchGrace = (deadline: number): void => {
      if (pgid == null || termination !== "running") return;
      const probe = signalGroup(pgid, 0);
      if (probe === "gone") {
        finishTermination("complete");
        return;
      }
      if (probe !== "delivered") {
        finishTermination("failed", probe.errorCode);
        return;
      }
      if (performance.now() >= deadline) {
        escalate();
        return;
      }
      schedule(LOCAL_WORKSPACE_GIT_GROUP_POLL_MS, () => watchGrace(deadline));
    };

    const terminate = (): void => {
      if (pgid == null || termination !== "idle" || settled) return;
      termination = "running";
      clearTimers();
      const outcome = signalGroup(pgid, "SIGTERM");
      if (outcome === "gone") {
        finishTermination("complete");
        return;
      }
      if (outcome !== "delivered") {
        finishTermination("failed", outcome.errorCode);
        return;
      }
      killed = timedOut || outputLimited;
      schedule(LOCAL_WORKSPACE_GIT_GROUP_POLL_MS, () =>
        watchGrace(performance.now() + LOCAL_WORKSPACE_GIT_KILL_GRACE_MS),
      );
    };

    const collect =
      (chunks: Buffer[], stream: "stdout" | "stderr") =>
      (chunk: Buffer): void => {
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
  });
}
