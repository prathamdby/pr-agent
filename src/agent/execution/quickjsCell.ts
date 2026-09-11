import {
  newQuickJSWASMModuleFromVariant,
  RELEASE_SYNC,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import {
  CODE_MODE_CPU_BUDGET_MS,
  CODE_MODE_GUEST_HEAP_BYTES,
  CODE_MODE_GUEST_STACK_BYTES,
  CODE_MODE_INTERRUPT_CHECKS,
  CODE_MODE_MAX_ARRAY_ALLOCATION,
  CODE_MODE_MAX_SOURCE_BYTES,
  CODE_MODE_MAX_STRING_REPEAT,
  CODE_MODE_PENDING_JOBS_PER_PUMP,
  CODE_MODE_STATE_MAX_BYTES,
  CODE_MODE_TIMEOUT_MS,
} from "../../settings/index.js";
import { CodeModeHostHalt, hostCancelHalt, isCodeModeHostHalt } from "../codemode/hostHalt.js";
import type { CodeModeErrorCode } from "../codemode/result.js";
import { injectLastExpressionReturn } from "./injectReturn.js";
import { asJsonObject, asJsonValue, type JsonObject, utf8ByteLength } from "./json.js";

export type HostCall = (
  name: string,
  args: Record<string, unknown>,
  callId: string,
  signal: AbortSignal,
) => Promise<unknown>;

export type QuickJsCellParams = {
  readonly code: string;
  readonly state: JsonObject;
  readonly capabilityNames: readonly string[];
  readonly hostCall: HostCall;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly executionId: string;
};

export type QuickJsCellSuccess = {
  readonly ok: true;
  readonly output: unknown;
  readonly stagedState: JsonObject;
};

export type QuickJsCellFailure = {
  readonly ok: false;
  readonly error: {
    readonly code: CodeModeErrorCode;
    readonly message: string;
    readonly line?: number;
  };
};

export type QuickJsCellResult = QuickJsCellSuccess | QuickJsCellFailure;

let wasmModule: Promise<QuickJSWASMModule> | undefined;

function loadWasm(): Promise<QuickJSWASMModule> {
  wasmModule ??= newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
  return wasmModule;
}

function dumpError(vm: QuickJSContext, handle: QuickJSHandle): { name?: string; message: string } {
  const dumped: unknown = vm.dump(handle);
  if (typeof dumped === "string") return { message: dumped };
  if (typeof dumped === "number" || typeof dumped === "boolean") {
    return { message: String(dumped) };
  }
  if (dumped && typeof dumped === "object") {
    const row = dumped as { name?: unknown; message?: unknown };
    const message = typeof row.message === "string" ? row.message : JSON.stringify(dumped);
    return {
      name: typeof row.name === "string" ? row.name : undefined,
      message: message ?? "unknown error",
    };
  }
  return { message: "unknown error" };
}

function mapGuestFailure(error: { name?: string; message: string }): {
  code: CodeModeErrorCode;
  message: string;
} {
  const message = error.message;
  const lower = message.toLowerCase();
  if (/interrupted/i.test(lower) || error.name === "InternalError") {
    return { code: "EXECUTION_BUDGET_EXCEEDED", message: "Execution interrupt budget exceeded" };
  }
  if (/out of memory|memory limit|stack overflow/i.test(lower)) {
    return { code: "LIMIT_EXCEEDED", message };
  }
  if (/LIMIT_EXCEEDED/.test(message)) {
    return { code: "LIMIT_EXCEEDED", message };
  }
  if (/ACCESS_DENIED|FILE_NOT_FOUND|SEARCH_TRUNCATED|TOOL_INPUT_INVALID|UNKNOWN:/.test(message)) {
    return { code: "TOOL_FAILURE", message };
  }
  if (error.name === "SyntaxError") {
    return { code: "SYNTAX_ERROR", message };
  }
  return { code: "EXECUTION_ERROR", message };
}

function jsonToHandle(vm: QuickJSContext, value: unknown): QuickJSHandle {
  const json = JSON.stringify(value);
  if (json == null) return vm.null;
  const result = vm.evalCode(`(${json})`);
  if (result.error) {
    const dumped = dumpError(vm, result.error);
    result.error.dispose();
    throw new CodeModeHostHalt("EXECUTION_ERROR", dumped.message);
  }
  return result.value;
}

function haltFromInterrupt(reason: "abort" | "cpu" | "timeout"): CodeModeHostHalt {
  if (reason === "cpu") {
    return new CodeModeHostHalt("EXECUTION_BUDGET_EXCEEDED", "Execution interrupt budget exceeded");
  }
  if (reason === "timeout") {
    return new CodeModeHostHalt("TIMEOUT", `Code Mode exceeded ${CODE_MODE_TIMEOUT_MS}ms`);
  }
  return hostCancelHalt();
}

function installLimits(vm: QuickJSContext): void {
  const prelude = `
    (function () {
      const originalRepeat = String.prototype.repeat;
      String.prototype.repeat = function (count) {
        const n = Math.floor(Number(count));
        if (!Number.isFinite(n) || n < 0 || this.length * n > ${CODE_MODE_MAX_STRING_REPEAT}) {
          throw new RangeError("LIMIT_EXCEEDED: String.repeat allocation exceeds ${CODE_MODE_MAX_STRING_REPEAT} characters");
        }
        return originalRepeat.call(this, n);
      };
      const originalFrom = Array.from;
      Array.from = function () {
        const source = arguments[0];
        const length = source == null ? 0 : Number(source.length);
        if (Number.isFinite(length) && length > ${CODE_MODE_MAX_ARRAY_ALLOCATION}) {
          throw new RangeError("LIMIT_EXCEEDED: Array allocation exceeds ${CODE_MODE_MAX_ARRAY_ALLOCATION} elements");
        }
        return originalFrom.apply(this, arguments);
      };
      delete globalThis.eval;
      delete globalThis.Function;
      delete globalThis.fetch;
      delete globalThis.process;
      delete globalThis.require;
      delete globalThis.WebAssembly;
    })();
  `;
  const result = vm.evalCode(prelude);
  if (result.error) {
    const dumped = dumpError(vm, result.error);
    result.error.dispose();
    throw new CodeModeHostHalt("EXECUTION_ERROR", dumped.message);
  }
  result.value.dispose();
}

type CpuMeter = {
  interrupt: () => boolean;
  pause: () => void;
  resume: () => void;
  reason: () => "abort" | "cpu" | "timeout" | null;
};

function createCpuMeter(params: QuickJsCellParams): CpuMeter {
  const cellDeadline = Date.now() + CODE_MODE_TIMEOUT_MS;
  let cpuUsed = 0;
  let sliceStart = Date.now();
  let hostDepth = 0;
  let checks = 0;
  let reason: "abort" | "cpu" | "timeout" | null = null;
  return {
    interrupt() {
      if (reason) return true;
      if (params.signal.aborted || !params.isCurrent()) {
        reason = "abort";
        return true;
      }
      if (Date.now() > cellDeadline) {
        reason = "timeout";
        return true;
      }
      if (hostDepth > 0) return false;
      const now = Date.now();
      cpuUsed += now - sliceStart;
      sliceStart = now;
      checks += 1;
      if (cpuUsed > CODE_MODE_CPU_BUDGET_MS || checks > CODE_MODE_INTERRUPT_CHECKS) {
        reason = "cpu";
        return true;
      }
      return false;
    },
    pause() {
      if (hostDepth === 0) {
        cpuUsed += Date.now() - sliceStart;
      }
      hostDepth += 1;
    },
    resume() {
      hostDepth = Math.max(0, hostDepth - 1);
      if (hostDepth === 0) sliceStart = Date.now();
    },
    reason() {
      return reason;
    },
  };
}

function installHostTools(
  vm: QuickJSContext,
  params: QuickJsCellParams,
  callSeq: { n: number },
  meter: CpuMeter,
  deferreds: QuickJSDeferredPromise[],
  onHostHalt: (error: CodeModeHostHalt) => void,
): void {
  const toolsHandle = vm.newObject();
  for (const name of params.capabilityNames) {
    const fn = vm.newFunction(name, (argsHandle) => {
      const deferred = vm.newPromise();
      deferreds.push(deferred);
      if (!vm.alive || !params.isCurrent() || params.signal.aborted) {
        onHostHalt(hostCancelHalt());
        return deferred.handle;
      }
      const dumped = argsHandle ? vm.dump(argsHandle) : {};
      const args = asJsonObject(dumped);
      const callId = `${params.executionId}:${name}:${(callSeq.n += 1)}`;
      meter.pause();
      void params
        .hostCall(name, args, callId, params.signal)
        .then((value) => {
          meter.resume();
          if (!vm.alive || !deferred.alive || !params.isCurrent()) {
            if (deferred.alive) deferred.dispose();
            return;
          }
          const handle = jsonToHandle(vm, value);
          deferred.resolve(handle);
          handle.dispose();
        })
        .catch((error) => {
          meter.resume();
          if (isCodeModeHostHalt(error)) {
            onHostHalt(error);
            if (deferred.alive) deferred.dispose();
            return;
          }
          if (!vm.alive || !deferred.alive || !params.isCurrent()) {
            if (deferred.alive) deferred.dispose();
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          const errHandle = vm.newError(message);
          deferred.reject(errHandle);
          errHandle.dispose();
        });
      return deferred.handle;
    });
    vm.setProp(toolsHandle, name, fn);
    fn.dispose();
  }
  vm.setProp(vm.global, "tools", toolsHandle);
  toolsHandle.dispose();
}

async function pumpUntilSettled(
  runtime: QuickJSRuntime,
  vm: QuickJSContext,
  promiseHandle: QuickJSHandle,
  params: QuickJsCellParams,
  meter: CpuMeter,
  hostHalt: { current: CodeModeHostHalt | null },
): Promise<unknown> {
  const native = vm.resolvePromise(promiseHandle);
  while (true) {
    if (hostHalt.current) throw hostHalt.current;
    const interruptReason = meter.reason();
    if (interruptReason) throw haltFromInterrupt(interruptReason);
    if (params.signal.aborted || !params.isCurrent()) {
      throw hostCancelHalt();
    }
    const jobs = runtime.executePendingJobs(CODE_MODE_PENDING_JOBS_PER_PUMP);
    if (jobs.error) {
      const dumped = dumpError(vm, jobs.error);
      const mapped = mapGuestFailure(dumped);
      jobs.dispose();
      throw new CodeModeHostHalt(mapped.code, mapped.message);
    }
    if (jobs.alive) jobs.dispose();
    const raced = await Promise.race([
      native.then((result) => ({ kind: "done" as const, result })),
      new Promise<{ kind: "tick" }>((resolve) => {
        setImmediate(() => resolve({ kind: "tick" }));
      }),
    ]);
    if (raced.kind === "tick") continue;
    const finished = raced.result;
    if (hostHalt.current) throw hostHalt.current;
    if (finished.error) {
      const dumped = dumpError(vm, finished.error);
      const mapped = mapGuestFailure(dumped);
      finished.error.dispose();
      throw new CodeModeHostHalt(mapped.code, mapped.message);
    }
    const output = vm.dump(finished.value);
    finished.value.dispose();
    return output;
  }
}

function failResult(error: {
  code: CodeModeErrorCode;
  message: string;
  line?: number;
}): QuickJsCellFailure {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.line != null ? { line: error.line } : {}),
    },
  };
}

export async function runQuickJsCell(params: QuickJsCellParams): Promise<QuickJsCellResult> {
  if (utf8ByteLength(params.code) > CODE_MODE_MAX_SOURCE_BYTES) {
    return failResult({
      code: "LIMIT_EXCEEDED",
      message: `Source exceeds ${CODE_MODE_MAX_SOURCE_BYTES} bytes`,
    });
  }
  if (utf8ByteLength(params.state) > CODE_MODE_STATE_MAX_BYTES) {
    return failResult({
      code: "LIMIT_EXCEEDED",
      message: `Explicit state exceeds ${CODE_MODE_STATE_MAX_BYTES} bytes`,
    });
  }
  const QuickJS = await loadWasm();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(CODE_MODE_GUEST_HEAP_BYTES);
  runtime.setMaxStackSize(CODE_MODE_GUEST_STACK_BYTES);
  const meter = createCpuMeter(params);
  runtime.setInterruptHandler(() => meter.interrupt());
  const vm = runtime.newContext();
  const deferreds: QuickJSDeferredPromise[] = [];
  const hostHalt: { current: CodeModeHostHalt | null } = { current: null };
  let evaluated: ReturnType<QuickJSContext["evalCode"]> | undefined;
  try {
    installLimits(vm);
    const stateHandle = jsonToHandle(vm, params.state);
    vm.setProp(vm.global, "state", stateHandle);
    stateHandle.dispose();
    installHostTools(vm, params, { n: 0 }, meter, deferreds, (error) => {
      hostHalt.current = error;
    });
    const wrapped = `(async () => {\n${injectLastExpressionReturn(params.code)}\n})()`;
    evaluated = vm.evalCode(wrapped, "cell.js");
    const interruptReason = meter.reason();
    if (interruptReason) {
      return failResult(haltFromInterrupt(interruptReason));
    }
    if (hostHalt.current) return failResult(hostHalt.current);
    if (evaluated.error) {
      const dumped = dumpError(vm, evaluated.error);
      const mapped = mapGuestFailure(dumped);
      return failResult(mapped);
    }
    const output = await pumpUntilSettled(runtime, vm, evaluated.value, params, meter, hostHalt);
    const stateProp = vm.getProp(vm.global, "state");
    const stateDump = vm.dump(stateProp);
    stateProp.dispose();
    const stagedState = asJsonValue(stateDump);
    if (typeof stagedState !== "object" || stagedState === null || Array.isArray(stagedState)) {
      return failResult({
        code: "LIMIT_EXCEEDED",
        message: "Explicit state must remain a JSON object",
      });
    }
    return { ok: true, output, stagedState };
  } catch (error) {
    if (isCodeModeHostHalt(error)) return failResult(error);
    if (params.signal.aborted) {
      return failResult(hostCancelHalt());
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/LIMIT_EXCEEDED/.test(message)) {
      return failResult({ code: "LIMIT_EXCEEDED", message });
    }
    return failResult({ code: "EXECUTION_ERROR", message });
  } finally {
    runtime.removeInterruptHandler();
    for (const deferred of deferreds) {
      if (deferred.alive) deferred.dispose();
    }
    if (evaluated?.alive) evaluated.dispose();
    if (vm.alive) vm.dispose();
    if (runtime.alive) runtime.dispose();
  }
}
