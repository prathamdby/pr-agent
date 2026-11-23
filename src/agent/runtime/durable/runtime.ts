import { createCodemodeExtension, createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import {
  createRegistry,
  defineExtension,
  type AnyTask,
  type Harness,
  wrapTool,
  type ConversationId,
  type Extension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { CODEMODE_OPTIONS_PREFIX, parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import type { Config } from "../../../settings/index.ts";
import { stat } from "node:fs/promises";
import { isRecord } from "../../../util/typeGuards.ts";
import { logWarn } from "../../../evlog.ts";
import { errorLogFields, toAppError } from "../../../errors/appError.ts";
import { openDurableHarness, type DurableHarnessHandle } from "./harness.ts";
import { createSessionModels, type SessionModels } from "./sessionModels.ts";
import { createProviderRoutingHooks } from "./providerRouting.ts";
import { createEvidenceHooks } from "./evidenceMemo.ts";
import {
  createToolGateHooks,
  createTelemetryHooks,
  createWarmupReleaseHooks,
} from "./telemetryBridge.ts";
import { createTraceHooks, observeCompactionRequests } from "./traceBridge.ts";
import { sessionStateFor } from "./sessionState.ts";

export const CODEMODE_TIMEOUT_MS_CAP = 15_000;
export const CODEMODE_MAX_OUTPUT_TOKENS_CAP = 8_000;
export const CODEMODE_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
export const CODEMODE_MAX_WORKERS = 4;
export const RUN_SPILL_QUOTA_BYTES = 16 * 1024 * 1024;

export type DurableRuntime = {
  readonly handle: DurableHarnessHandle;
  readonly registry: Registry;
  readonly models: SessionModels;
  readonly telemetry: InMemoryTelemetryContext;
  readonly sharedHeadByConversation: Map<ConversationId, string>;
  readonly codemodeExtension: Extension;
  readonly runtimeExtension: Extension;
};

export type CodemodeAdmissionPermit = { used: boolean };

export type CodemodeWorkerAdmission = {
  readonly admit: (signal?: AbortSignal) => Promise<CodemodeAdmissionPermit>;
  readonly release: (permit: CodemodeAdmissionPermit) => void;
  readonly acquireWorker: () => () => void;
};

export function codemodeWorkerAdmission(maxWorkers = CODEMODE_MAX_WORKERS) {
  let inFlight = 0;
  const waiters: (() => void)[] = [];
  const outstanding: CodemodeAdmissionPermit[] = [];
  const release = (permit: CodemodeAdmissionPermit) => {
    const index = outstanding.indexOf(permit);
    if (index >= 0) outstanding.splice(index, 1);
    inFlight -= 1;
    const next = waiters.shift();
    next?.();
  };
  const admit = (signal?: AbortSignal) =>
    new Promise<CodemodeAdmissionPermit>((resolve, reject) => {
      const reason = () => signal?.reason ?? new Error("codemode admission aborted");
      if (signal?.aborted) {
        reject(reason());
        return;
      }
      const grant = () => {
        inFlight += 1;
        const permit: CodemodeAdmissionPermit = { used: false };
        outstanding.push(permit);
        resolve(permit);
      };
      if (inFlight < maxWorkers && waiters.length === 0) {
        grant();
        return;
      }
      const waiter = { grant, signal };
      const onAbort = () => {
        const index = waiters.indexOf(grant);
        if (index >= 0) waiters.splice(index, 1);
        reject(reason());
      };
      waiters.push(waiter.grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  const acquireWorker = () => {
    const permit = outstanding.shift();
    if (permit === undefined) {
      throw new Error(`codemode worker cap ${maxWorkers} reached`);
    }
    permit.used = true;
    return () => release(permit);
  };
  return ((pinnedReturn: CodemodeWorkerAdmission) => pinnedReturn)({
    admit,
    release,
    acquireWorker,
  });
}

export function clampCodemodeSource(code: string) {
  const lineBreak = code.indexOf("\n");
  const firstLine = lineBreak === -1 ? code : code.slice(0, lineBreak);
  if (!firstLine.startsWith(CODEMODE_OPTIONS_PREFIX)) {
    const merged = JSON.stringify({
      timeout_ms: CODEMODE_TIMEOUT_MS_CAP,
      max_output_tokens: CODEMODE_MAX_OUTPUT_TOKENS_CAP,
    });
    return ((pinnedReturn: string) => pinnedReturn)(
      `${CODEMODE_OPTIONS_PREFIX} ${merged}\n${code}`,
    );
  }
  const parsed = parseCodemodeSource(code);
  const merged = JSON.stringify({
    timeout_ms: Math.min(
      parsed.options.timeoutMs ?? CODEMODE_TIMEOUT_MS_CAP,
      CODEMODE_TIMEOUT_MS_CAP,
    ),
    max_output_tokens: Math.min(
      parsed.options.maxOutputTokens ?? CODEMODE_MAX_OUTPUT_TOKENS_CAP,
      CODEMODE_MAX_OUTPUT_TOKENS_CAP,
    ),
  });
  return ((pinnedReturn: string) => pinnedReturn)(
    `${CODEMODE_OPTIONS_PREFIX} ${merged}${lineBreak === -1 ? "" : code.slice(lineBreak)}`,
  );
}

function clampCodemodeSourceSafe(code: string) {
  try {
    return ((pinnedReturn: string) => pinnedReturn)(clampCodemodeSource(code));
  } catch {
    return ((pinnedReturn: string) => pinnedReturn)(code);
  }
}

function codemodeWrap(codemodeTool: ToolRegistration, admission: CodemodeWorkerAdmission) {
  return wrapTool(codemodeTool, (tool) => ({
    ...tool,
    async execute(args, api, context) {
      const permit = await admission.admit(context.abortSignal);
      let result;
      try {
        result = await (isRecord(args) && typeof args.code === "string"
          ? tool.execute({ ...args, code: clampCodemodeSourceSafe(args.code) }, api, context)
          : tool.execute(args, api, context));
      } finally {
        if (!permit.used) admission.release(permit);
      }
      const details = result.details;
      if (isRecord(details) && typeof details.fullOutputPath === "string") {
        const state = sessionStateFor(api.conversationId);
        if (state !== undefined) {
          const dir = details.fullOutputPath.slice(0, details.fullOutputPath.lastIndexOf("/"));
          if (dir.length > 0) state.evidence.spillRoots.add(dir);
          try {
            const info = await stat(details.fullOutputPath);
            state.evidence.spillBytes += info.size;
            if (state.evidence.spillBytes > RUN_SPILL_QUOTA_BYTES)
              state.evidence.spillExpired = true;
          } catch {}
        }
      }
      return result;
    },
  }));
}

function durableReportToLog() {
  return (report: { readonly kind: string; readonly error?: unknown }) => {
    const fields: Record<string, unknown> = { reportKind: report.kind };
    logWarn(
      "pi_durable_report",
      report.error === undefined
        ? fields
        : {
            ...fields,
            ...errorLogFields(
              toAppError(report.error, {
                domain: "runtime",
                kind: "session_send_failed",
              }),
            ),
          },
    );
  };
}

export function createRuntimeExtension(params: {
  readonly codemodeTool?: ToolRegistration;
  readonly admission?: CodemodeWorkerAdmission;
  readonly sharedHeadByConversation: Map<ConversationId, string>;
  readonly harness?: () => Harness;
}) {
  return ((pinnedReturn: Extension) => pinnedReturn)(
    defineExtension({
      name: "pr-runtime",
      hooks: [
        createProviderRoutingHooks(params.sharedHeadByConversation),
        ...createEvidenceHooks(),
        ...createToolGateHooks(),
        ...createTelemetryHooks(),
        ...createTraceHooks(),
        ...(params.harness !== undefined ? createWarmupReleaseHooks(params.harness) : []),
      ],
      wraps:
        params.codemodeTool !== undefined && params.admission !== undefined
          ? [codemodeWrap(params.codemodeTool, params.admission)]
          : [],
    }),
  );
}

export type DurableRuntimeOptions = {
  readonly tasks?: readonly AnyTask[];
};

export async function openDurableRuntime(cfg: Config, options: DurableRuntimeOptions = {}) {
  const models: SessionModels = await createSessionModels(cfg);
  const registry = createRegistry();
  const sharedHeadByConversation = new Map<ConversationId, string>();
  const telemetry = new InMemoryTelemetryContext();
  const admission = codemodeWorkerAdmission();
  const sandbox = new CodemodeSandbox({
    memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
    acquireWorker: admission.acquireWorker,
    onWorkerStarted: (exited) => {
      void exited.catch(() => {});
    },
  });
  const codemodeTool = createCodemodeTool({ sandbox, models: false });
  const codemodeExtension = createCodemodeExtension({ sandbox, models: false });
  let handle: DurableHarnessHandle;
  const runtimeExtension = createRuntimeExtension({
    codemodeTool,
    admission,
    sharedHeadByConversation,
    harness: () => handle.harness,
  });
  registry.install(codemodeExtension);
  registry.install(runtimeExtension);
  if (options.tasks !== undefined && options.tasks.length > 0) {
    registry.install(defineExtension({ name: "pr-durable-tasks", tasks: options.tasks }));
  }
  const tracedModels = observeCompactionRequests(models.models);
  handle = await openDurableHarness({
    sqliteDir: cfg.runtime.sqliteDir,
    registry,
    models: () => tracedModels,
    env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }),
    telemetry,
    onReport: durableReportToLog(),
    settings: {
      extensions: [runtimeExtension],
      afterFailedRun: "withdraw",
    },
  });
  return ((pinnedReturn: DurableRuntime | Promise<DurableRuntime>) => pinnedReturn)({
    handle,
    registry,
    models,
    telemetry,
    sharedHeadByConversation,
    codemodeExtension,
    runtimeExtension,
  });
}

const sharedRuntimes = new WeakMap<Config, Promise<DurableRuntime>>();

export function getSharedDurableRuntime(cfg: Config) {
  const existing = sharedRuntimes.get(cfg);
  if (existing !== undefined) {
    return ((pinnedReturn: Promise<DurableRuntime>) => pinnedReturn)(existing);
  }
  const created = openDurableRuntime(cfg);
  sharedRuntimes.set(cfg, created);
  created.catch(() => {
    if (sharedRuntimes.get(cfg) === created) sharedRuntimes.delete(cfg);
  });
  return ((pinnedReturn: Promise<DurableRuntime>) => pinnedReturn)(created);
}

export function replaceSharedDurableRuntime(cfg: Config, runtime: DurableRuntime) {
  sharedRuntimes.set(cfg, Promise.resolve(runtime));
}
