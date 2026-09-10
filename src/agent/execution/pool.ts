import { Worker } from "node:worker_threads";
import {
  CODE_MODE_EXECUTOR_POOL_SIZE,
  CODE_MODE_EXECUTOR_QUEUE_LENGTH,
  CODE_MODE_EXECUTOR_QUEUE_WAIT_MS,
  resolveCodeModeExecutorKind,
} from "../../settings/index.js";
import { CodeModeHostHalt } from "../codemode/hostHalt.js";
import { runQuickJsCell, type QuickJsCellParams, type QuickJsCellResult } from "./quickjsCell.js";

type Waiter = {
  resolve: (lease: ExecutorLease) => void;
  readonly reject: (error: unknown) => void;
};

export type ExecutorLease = {
  readonly run: (params: QuickJsCellParams) => Promise<QuickJsCellResult>;
  readonly release: () => void;
};

const waiters: Waiter[] = [];
let active = 0;

function useWorkerThreads(): boolean {
  const kind = resolveCodeModeExecutorKind();
  switch (kind) {
    case "worker_threads":
      return true;
    case "in_process":
      return false;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next.resolve(createLease());
    return;
  }
  active = Math.max(0, active - 1);
}

function createLease(): ExecutorLease {
  return {
    async run(params) {
      if (useWorkerThreads()) {
        return runInWorker(params);
      }
      return runQuickJsCell(params);
    },
    release() {
      releaseSlot();
    },
  };
}

function postToWorker(worker: Worker, message: unknown): void {
  try {
    worker.postMessage(message);
  } catch {
    // Worker already exited or terminated.
  }
}

async function runInWorker(params: QuickJsCellParams): Promise<QuickJsCellResult> {
  const worker = new Worker(new URL("./executorWorker.js", import.meta.url));
  let settled = false;
  let resolveResult!: (result: QuickJsCellResult) => void;
  let rejectResult!: (error: unknown) => void;
  const completed = new Promise<QuickJsCellResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const succeed = (result: QuickJsCellResult) => {
    if (settled) return;
    settled = true;
    resolveResult(result);
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectResult(error);
  };
  const onAbort = () => {
    postToWorker(worker, { type: "abort", executionId: params.executionId });
    fail(new CodeModeHostHalt("TIMEOUT", "Code Mode cancelled by host signal"));
  };
  worker.on("message", (message: WorkerMessage) => {
    if (message.type === "hostCall") {
      if (!params.isCurrent() || message.executionId !== params.executionId) {
        postToWorker(worker, {
          type: "hostResult",
          callId: message.callId,
          ok: false,
          error: "retired",
        });
        return;
      }
      void params
        .hostCall(message.name, message.args, message.callId, params.signal)
        .then((value) => {
          postToWorker(worker, {
            type: "hostResult",
            callId: message.callId,
            ok: true,
            value,
          });
        })
        .catch((error) => {
          postToWorker(worker, {
            type: "hostResult",
            callId: message.callId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    if (message.type === "done") {
      succeed(message.result);
    }
  });
  worker.on("error", fail);
  worker.on("exit", (code) => {
    fail(
      new CodeModeHostHalt("EXECUTION_ERROR", `Executor worker exited before completion (${code})`),
    );
  });
  params.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (params.signal.aborted) {
      onAbort();
    } else {
      postToWorker(worker, {
        type: "run",
        executionId: params.executionId,
        code: params.code,
        state: params.state,
        capabilityNames: params.capabilityNames,
      });
    }
    return await completed;
  } finally {
    params.signal.removeEventListener("abort", onAbort);
    await worker.terminate();
  }
}

type WorkerMessage =
  | {
      readonly type: "hostCall";
      readonly executionId: string;
      readonly callId: string;
      readonly name: string;
      readonly args: Record<string, unknown>;
    }
  | { readonly type: "done"; readonly result: QuickJsCellResult };

export async function acquireExecutor(signal: AbortSignal): Promise<ExecutorLease> {
  if (signal.aborted) {
    throw new CodeModeHostHalt("TIMEOUT", "Code Mode cancelled by host signal");
  }
  if (active < CODE_MODE_EXECUTOR_POOL_SIZE) {
    active += 1;
    return createLease();
  }
  if (waiters.length >= CODE_MODE_EXECUTOR_QUEUE_LENGTH) {
    throw new CodeModeHostHalt("LIMIT_EXCEEDED", "Executor pool queue is full");
  }
  return await new Promise<ExecutorLease>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject };
    waiters.push(waiter);
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new CodeModeHostHalt("TIMEOUT", "Timed out waiting for an executor"));
    }, CODE_MODE_EXECUTOR_QUEUE_WAIT_MS);
    const onAbort = () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      clearTimeout(timer);
      reject(new CodeModeHostHalt("TIMEOUT", "Code Mode cancelled by host signal"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const originalResolve = waiter.resolve;
    waiter.resolve = (lease) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      originalResolve(lease);
    };
  });
}
