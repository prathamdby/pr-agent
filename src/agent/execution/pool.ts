import { Worker } from "node:worker_threads";
import {
  CODE_MODE_EXECUTOR_POOL_SIZE,
  CODE_MODE_EXECUTOR_QUEUE_LENGTH,
  CODE_MODE_EXECUTOR_QUEUE_WAIT_MS,
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
  return import.meta.url.endsWith(".js");
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

async function runInWorker(params: QuickJsCellParams): Promise<QuickJsCellResult> {
  const worker = new Worker(new URL("./executorWorker.js", import.meta.url));
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  const onAbort = () => {
    worker.postMessage({ type: "abort", executionId: params.executionId });
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await new Promise<QuickJsCellResult>((resolve, reject) => {
      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "hostCall") {
          if (!params.isCurrent() || message.executionId !== params.executionId) {
            worker.postMessage({
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
              worker.postMessage({ type: "hostResult", callId: message.callId, ok: true, value });
            })
            .catch((error) => {
              worker.postMessage({
                type: "hostResult",
                callId: message.callId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          return;
        }
        if (message.type === "done") {
          resolve(message.result);
        }
      });
      worker.on("error", reject);
      worker.postMessage({
        type: "run",
        executionId: params.executionId,
        code: params.code,
        state: params.state,
        capabilityNames: params.capabilityNames,
      });
    });
  } finally {
    params.signal.removeEventListener("abort", onAbort);
    for (const waiter of pending.values()) {
      waiter.reject(new CodeModeHostHalt("TIMEOUT", "Code Mode cancelled by host signal"));
    }
    pending.clear();
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
