import { describe, expect, it } from "vitest";
import {
  clampCodemodeSource,
  codemodeWorkerAdmission,
  CODEMODE_MAX_OUTPUT_TOKENS_CAP,
  CODEMODE_MAX_WORKERS,
  CODEMODE_MEMORY_LIMIT_BYTES,
  CODEMODE_TIMEOUT_MS_CAP,
  durableHarnessSettings,
  RUN_SPILL_QUOTA_BYTES,
} from "../src/agent/runtime/durable/runtime.ts";
import {
  CODE_MODE_ERROR_CODES,
  CODE_MODE_HOST_CANCEL_MESSAGE,
  CODE_MODE_CAP_REASONS,
  CodeModeHostHalt,
  codeModeHaltFromPayload,
  codeModeHaltPayload,
  emptyCodeModeCapHits,
  isCodeModeCapReason,
  isCodeModeErrorCode,
  isCodeModeHostHalt,
} from "../src/agent/runtime/durable/codemodeCaps.ts";
import {
  buildWorkspaceTools,
  hideWorkspaceToolsBehindCodeMode,
} from "../src/agent/runtime/durable/piTools.ts";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.ts";
import { makeTestConfig } from "./helpers/config.ts";

describe("durableHarnessSettings", () => {
  it("carries the provider retry knobs into the request stream", () => {
    const settings = durableHarnessSettings(
      makeTestConfig({
        provider: { retryMax: 3, maxRetryDelayMs: 12_345 },
      }),
      { name: "pr-runtime", tools: [] },
    );
    expect(settings.afterFailedRun).toBe("withdraw");
    expect(settings.stream).toEqual({ maxRetries: 3, maxRetryDelayMs: 12_345 });
  });
});

describe("codemode constants", () => {
  it("locks the sandbox and spill budgets", () => {
    expect(CODEMODE_MEMORY_LIMIT_BYTES).toBe(128 * 1024 * 1024);
    expect(CODEMODE_MAX_WORKERS).toBe(4);
    expect(CODEMODE_TIMEOUT_MS_CAP).toBe(15_000);
    expect(CODEMODE_MAX_OUTPUT_TOKENS_CAP).toBe(8_000);
    expect(RUN_SPILL_QUOTA_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe("codemodeWorkerAdmission", () => {
  it("queues a fifth concurrent codemode run, then admits it when a worker exits", async () => {
    const admission = codemodeWorkerAdmission();
    const first = await Promise.all([
      admission.admit(),
      admission.admit(),
      admission.admit(),
      admission.admit(),
    ]);
    let fifthAdmitted = false;
    const fifth = admission.admit().then((permit) => {
      fifthAdmitted = true;
      return permit;
    });
    expect(await Promise.race([fifth.then(() => true), Promise.resolve(false)])).toBe(false);
    expect(admission.acquireWorker).not.toThrow();
    const releaseFirstWorker = admission.acquireWorker();
    releaseFirstWorker();
    const fifthPermit = await fifth;
    expect(fifthAdmitted).toBe(true);
    expect(fifthPermit.used).toBe(false);
    admission.release(fifthPermit);
    for (const permit of first.slice(1)) admission.release(permit);
    expect(admission.acquireWorker).toThrow(/worker cap 4/);
  });

  it("rejects a queued admission when the signal aborts", async () => {
    const admission = codemodeWorkerAdmission();
    await Promise.all([admission.admit(), admission.admit(), admission.admit(), admission.admit()]);
    const controller = new AbortController();
    const pending = admission.admit(controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});

describe("clampCodemodeSource", () => {
  it("prepends clamped options to bare source", () => {
    const clamped = clampCodemodeSource("await 1;");
    const firstLine = clamped.slice(0, clamped.indexOf("\n"));
    expect(firstLine.startsWith("// @options:")).toBe(true);
    const options = JSON.parse(firstLine.slice("// @options:".length)) as {
      timeout_ms: number;
      max_output_tokens: number;
    };
    expect(options).toEqual({ timeout_ms: 15_000, max_output_tokens: 8_000 });
    expect(clamped.endsWith("await 1;")).toBe(true);
  });

  it("clamps oversized @options before journaling", () => {
    const clamped = clampCodemodeSource(
      '// @options: {"timeout_ms": 60000, "max_output_tokens": 20000}\nawait 1;',
    );
    const firstLine = clamped.slice(0, clamped.indexOf("\n"));
    const options = JSON.parse(firstLine.slice("// @options:".length)) as {
      timeout_ms: number;
      max_output_tokens: number;
    };
    expect(options).toEqual({ timeout_ms: 15_000, max_output_tokens: 8_000 });
  });

  it("keeps tighter model-written @options", () => {
    const clamped = clampCodemodeSource(
      '// @options: {"timeout_ms": 1000, "max_output_tokens": 500}\nawait 1;',
    );
    const firstLine = clamped.slice(0, clamped.indexOf("\n"));
    const options = JSON.parse(firstLine.slice("// @options:".length)) as {
      timeout_ms: number;
      max_output_tokens: number;
    };
    expect(options).toEqual({ timeout_ms: 1000, max_output_tokens: 500 });
  });

  it("passes an invalid @options line through as an error", () => {
    expect(() => clampCodemodeSource("// @options: not-json\nawait 1;")).toThrow();
  });
});

describe("codemode capability errors", () => {
  it("recognizes the declared error codes and cap reasons", () => {
    for (const code of CODE_MODE_ERROR_CODES) {
      expect(isCodeModeErrorCode(code)).toBe(true);
    }
    expect(isCodeModeErrorCode("NOPE")).toBe(false);
    for (const reason of CODE_MODE_CAP_REASONS) {
      expect(isCodeModeCapReason(reason)).toBe(true);
    }
    expect(isCodeModeCapReason("nope")).toBe(false);
  });

  it("round-trips a CodeModeHostHalt through its payload", () => {
    const halt = new CodeModeHostHalt("TIMEOUT", "timed out", {
      line: 3,
      reason: "guest_cpu",
    });
    expect(isCodeModeHostHalt(halt)).toBe(true);
    const restored = codeModeHaltFromPayload(codeModeHaltPayload(halt));
    expect(restored).toBeInstanceOf(CodeModeHostHalt);
    expect(restored.code).toBe("TIMEOUT");
    expect(restored.line).toBe(3);
    expect(restored.reason).toBe("guest_cpu");
  });

  it("maps foreign errors to EXECUTION_ERROR payloads", () => {
    const payload = codeModeHaltPayload(new Error("plain"));
    expect(payload.code).toBe("EXECUTION_ERROR");
    expect(codeModeHaltFromPayload(payload).message).toBe("plain");
  });

  it("exposes the cancel message and empty cap hit ledger", () => {
    expect(CODE_MODE_HOST_CANCEL_MESSAGE).toContain("cancelled");
    const hits = emptyCodeModeCapHits();
    expect(Object.keys(hits).toSorted()).toEqual([...CODE_MODE_CAP_REASONS].toSorted());
    expect(Object.values(hits).every((count) => count === 0)).toBe(true);
  });
});

describe("workspace tool mode metadata", () => {
  it("marks read_pinned safe, read_spill unsafe, emitEvidence tools-only", async () => {
    const workspace = mockLocalPrWorkspace("/tmp", {
      checkoutPaths: new Set(["src/a.ts"]),
    });
    const bundle = buildWorkspaceTools(workspace.reader);
    expect(bundle.toolMeta.read_pinned?.replay).toBe("safe");
    expect(bundle.toolMeta.read_spill?.replay).toBe("unsafe");
    expect(bundle.toolMeta.emitEvidence?.callers).toEqual(["tools"]);
    const spill = bundle.durableTools.find((tool) => tool.name === "read_spill");
    const emit = bundle.durableTools.find((tool) => tool.name === "emitEvidence");
    expect(spill?.replay).toBe("unsafe");
    expect(emit?.callers).toEqual(["tools"]);
  });

  it("hides investigation tools behind codemode callers", async () => {
    const workspace = mockLocalPrWorkspace("/tmp", {
      checkoutPaths: new Set(["src/a.ts"]),
    });
    const bundle = hideWorkspaceToolsBehindCodeMode(buildWorkspaceTools(workspace.reader));
    expect(bundle.toolMeta.getWorkspaceDiff?.callers).toEqual(["tools"]);
    expect(bundle.toolMeta.read_pinned?.callers).toEqual(["tools"]);
  });
});
