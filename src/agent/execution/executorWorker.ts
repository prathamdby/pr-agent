import { parentPort } from "node:worker_threads";
import { runQuickJsCell } from "./quickjsCell.js";
import type { JsonObject } from "./json.js";
import type { QuickJsCellResult } from "./quickjsCell.js";

if (!parentPort) {
  throw new Error("executorWorker must run as a worker thread");
}

const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: unknown) => void }
>();
const abortByExecution = new Map<string, AbortController>();

type HostMessage =
  | {
      readonly type: "run";
      readonly executionId: string;
      readonly code: string;
      readonly state: JsonObject;
      readonly capabilityNames: readonly string[];
    }
  | {
      readonly type: "hostResult";
      readonly callId: string;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: string;
    }
  | { readonly type: "abort"; readonly executionId: string };

parentPort.on("message", (message: HostMessage) => {
  if (message.type === "hostResult") {
    const waiter = pending.get(message.callId);
    if (!waiter) return;
    pending.delete(message.callId);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(new Error(message.error ?? "host call failed"));
    return;
  }
  if (message.type === "abort") {
    abortByExecution.get(message.executionId)?.abort();
    for (const waiter of pending.values()) {
      waiter.reject(new Error("aborted"));
    }
    pending.clear();
    return;
  }
  if (message.type === "run") {
    const controller = new AbortController();
    abortByExecution.set(message.executionId, controller);
    void runQuickJsCell({
      code: message.code,
      state: message.state,
      capabilityNames: message.capabilityNames,
      executionId: message.executionId,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      hostCall: (name, args, callId, signal) =>
        new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          pending.set(callId, { resolve, reject });
          parentPort?.postMessage({
            type: "hostCall",
            executionId: message.executionId,
            callId,
            name,
            args,
          });
        }),
    })
      .then((result: QuickJsCellResult) => {
        abortByExecution.delete(message.executionId);
        parentPort?.postMessage({ type: "done", result });
      })
      .catch((error: unknown) => {
        abortByExecution.delete(message.executionId);
        for (const waiter of pending.values()) {
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        }
        pending.clear();
        parentPort?.postMessage({
          type: "done",
          result: {
            ok: false,
            error: {
              code: "EXECUTION_ERROR",
              message: error instanceof Error ? error.message : String(error),
            },
          },
        });
      });
  }
});
