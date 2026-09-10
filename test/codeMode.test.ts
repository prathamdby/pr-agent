import { describe, expect, it } from "vitest";
import { hideWorkspaceToolsBehindCodeMode } from "../src/agent/codemode/assembleExplorationTools.js";
import { buildCodeModeExecuteTool } from "../src/agent/codemode/executeTool.js";
import type { CodeModeResult } from "../src/agent/codemode/result.js";
import { runCodeModeScript } from "../src/agent/codemode/runScript.js";
import { serializeCodeModeValue } from "../src/agent/codemode/serialize.js";
import type { AgentLifecycleEvent } from "../src/agent/runtime/lifecycleEvents.js";
import { createExecutionSessionStore } from "../src/agent/execution/sessionStore.js";
import { AppError } from "../src/errors/appError.js";
import { startWorkerHealthServer } from "../src/agentWork/workerHealth.js";
import { createEvidenceLedger } from "../src/review/findings/evidenceLedger.js";
import { CODE_MODE_MAX_TOOL_CALLS } from "../src/settings/index.js";

function asResult(value: unknown): CodeModeResult {
  return value as CodeModeResult;
}

describe("Code Mode", () => {
  it("terminates while(true){} within the AST budget", async () => {
    const started = Date.now();
    const result = await runCodeModeScript({
      code: "while (true) {}",
      capabilities: {},
    });
    const elapsedMs = Date.now() - started;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXECUTION_BUDGET_EXCEEDED");
    }
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("keeps worker /health and /ready responsive during an adversarial loop", async () => {
    const health = startWorkerHealthServer({
      port: 0,
      getReadiness: async () => ({ ready: true, reasons: [], missingQueues: [] }),
    });
    if (!health.server.listening) {
      await new Promise<void>((resolve) => health.server.once("listening", () => resolve()));
    }
    const address = health.server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const running = runCodeModeScript({
        code: "while (true) {}",
        capabilities: {},
      });
      const healthStarted = Date.now();
      const [healthRes, readyRes, script] = await Promise.all([
        fetch(`${base}/health`),
        fetch(`${base}/ready`),
        running,
      ]);
      expect(Date.now() - healthStarted).toBeLessThan(200);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.text()).toBe("ok");
      expect(readyRes.status).toBe(200);
      expect(await readyRes.text()).toBe("ready");
      expect(script.ok).toBe(false);
      if (!script.ok) expect(script.error.code).toBe("EXECUTION_BUDGET_EXCEEDED");
    } finally {
      await health.close();
    }
  });

  it("halts native memory bloat from String.repeat", async () => {
    const before = process.memoryUsage().heapUsed;
    const result = await runCodeModeScript({
      code: '"x".repeat(100000000)',
      capabilities: {},
    });
    const after = process.memoryUsage().heapUsed;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
    expect(after - before).toBeLessThan(8 * 1024 * 1024);
  });

  it("rejects ReDoS-prone regular expressions", async () => {
    const started = Date.now();
    const result = await runCodeModeScript({
      code: 'new RegExp("(a+)+$").test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaX")',
      capabilities: {},
    });
    expect(Date.now() - started).toBeLessThan(500);
    if (!result.ok) {
      expect(["EXECUTION_BUDGET_EXCEEDED", "TIMEOUT", "LIMIT_EXCEEDED"]).toContain(
        result.error.code,
      );
    }
  });

  it.each([
    "Promise.resolve().then(() => { while (true) {} })",
    "new Promise((resolve) => { while (true) {} })",
  ])("keeps %s on the host halt path", async (code) => {
    const started = Date.now();
    const result = await runCodeModeScript({ code, capabilities: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXECUTION_BUDGET_EXCEEDED");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("halts Array.from allocations beyond the cap", async () => {
    const before = process.memoryUsage().heapUsed;
    const result = await runCodeModeScript({
      code: "Array.from({ length: 100000 })",
      capabilities: {},
    });
    const after = process.memoryUsage().heapUsed;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
    expect(after - before).toBeLessThan(8 * 1024 * 1024);
  });

  it.each([
    '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaX".replace(new RegExp("(a+)+$"), "x")',
    '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaX".replaceAll(new RegExp("(a+)+$", "g"), "x")',
    '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaX".search(new RegExp("(a+)+$"))',
    '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaX".split(new RegExp("(a+)+$"))',
    '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaX".matchAll(new RegExp("(a+)+$", "g"))',
  ])("rejects ReDoS-prone patterns for %s", async (code) => {
    const started = Date.now();
    const result = await runCodeModeScript({ code, capabilities: {} });
    expect(Date.now() - started).toBeLessThan(500);
    if (!result.ok) {
      expect(["EXECUTION_BUDGET_EXCEEDED", "TIMEOUT", "LIMIT_EXCEEDED"]).toContain(
        result.error.code,
      );
    }
  });

  it("halts doubling concatenation before a huge allocation", async () => {
    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    const result = await runCodeModeScript({
      code: `
        let s = "x";
        while (true) {
          s = s + s;
        }
      `,
      capabilities: {},
    });
    const after = process.memoryUsage().heapUsed;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["LIMIT_EXCEEDED", "EXECUTION_BUDGET_EXCEEDED"]).toContain(result.error.code);
    }
    expect(Date.now() - started).toBeLessThan(500);
    expect(after - before).toBeLessThan(8 * 1024 * 1024);
  });

  it("returns structured diagnostics for syntax errors", async () => {
    const result = await runCodeModeScript({
      code: "const x = {",
      capabilities: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SYNTAX_ERROR");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it("executes class syntax as JavaScript", async () => {
    const result = await runCodeModeScript({
      code: "class Foo { value() { return 4 } }; new Foo().value()",
      capabilities: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe(4);
  });

  it("halts after more than 25 capability calls", async () => {
    let calls = 0;
    const result = await runCodeModeScript({
      code: `
        const out = [];
        for (let i = 0; i < 30; i = i + 1) {
          out.push(await tools.listChangedFiles());
        }
        out
      `,
      capabilities: {
        listChangedFiles: async () => {
          calls += 1;
          return { files: [] };
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
    expect(calls).toBe(CODE_MODE_MAX_TOOL_CALLS);
  });

  it("truncates oversized script output", async () => {
    const result = await runCodeModeScript({
      code: '({ items: Array(200).fill("n"), text: "x".repeat(40000) })',
      capabilities: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.output as {
        items: { truncated: true; omittedCount: number };
        text: string;
      };
      expect(output.items.truncated).toBe(true);
      expect(output.items.omittedCount).toBeGreaterThan(0);
      expect(typeof output.text).toBe("string");
      expect(output.text.length).toBeLessThan(40000);
    }
  });

  it("propagates ACCESS_DENIED from path fencing", async () => {
    const result = await runCodeModeScript({
      code: 'await tools.readWorkspaceFile({ path: "../secret.env" })',
      capabilities: {
        readWorkspaceFile: async () => {
          throw new AppError({
            code: "pr_workspace.path_traversal",
            message: "Path traversal attempt detected: ../secret.env",
            context: { path: "../secret.env" },
          });
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_FAILURE");
      expect(result.error.message).toContain("ACCESS_DENIED");
    }
    expect(result.toolCalls[0]?.status).toBe("error");
  });

  it("halts on host cancel even when the script uses try/catch", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCodeModeScript({
      code: `
          try {
            while (true) {}
          } catch (error) {
            try { while (true) {} } catch (ignored) {}
          }
          "escaped"
        `,
      capabilities: {},
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  it("hides workspace tools from the model catalog and keeps execute", () => {
    const bundle = hideWorkspaceToolsBehindCodeMode({
      piTools: [
        { name: "listChangedFiles", description: "list", parameters: { type: "object" } },
        { name: "searchCodeIndex", description: "index", parameters: { type: "object" } },
      ],
      executors: {
        listChangedFiles: async () => ({ files: [] }),
        searchCodeIndex: async () => ({ unavailable: true }),
      },
    });
    expect(bundle.piTools.map((tool) => tool.name)).toEqual(["execute", "searchCodeIndex"]);
    expect(bundle.executors.execute).toBeTypeOf("function");
    expect(bundle.executors.listChangedFiles).toBeTypeOf("function");
  });

  it("returns a successful compact tools.* result", async () => {
    const execute = buildCodeModeExecuteTool({
      capabilities: {
        listChangedFiles: async () => ({ files: [{ path: "src/a.ts" }] }),
      },
    });
    const result = asResult(
      await execute.executor({
        code: "const listed = await tools.listChangedFiles(); listed.files.map((f) => f.path)",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toEqual(["src/a.ts"]);
      expect(result.toolCalls).toEqual([
        { tool: "listChangedFiles", status: "completed", input: {} },
      ]);
    }
  });

  it("marks serializer truncation with omittedCount", () => {
    const serialized = serializeCodeModeValue(["a", "b", "c"], { maxArrayLength: 2 });
    expect(serialized).toEqual({
      truncated: true,
      omittedCount: 1,
      reason: "array_length_limit",
      value: ["a", "b"],
    });
  });

  it("supports object destructuring", async () => {
    const result = await runCodeModeScript({
      code: "const { a } = { a: 1 }; a",
      capabilities: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe(1);
  });

  it("does not retain variables across execute cells", async () => {
    const first = await runCodeModeScript({
      code: "var retainedValue = 7; retainedValue",
      capabilities: {},
    });
    expect(first.ok).toBe(true);
    const second = await runCodeModeScript({
      code: "retainedValue",
      capabilities: {},
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.message).toMatch(/retainedValue/i);
    }
  });

  it("emits execution success distinct from a returned execution failure", async () => {
    const events: Array<{ kind: string; outcome?: string }> = [];
    const sink = {
      emit: (event: { kind: string; outcome?: string }) => events.push(event),
      role: "ask" as const,
      provider: "openai",
      model: "gpt-4o-mini",
    };
    const success = await runCodeModeScript({
      code: "1 + 1",
      capabilities: {},
      ...sink,
    });
    const failure = await runCodeModeScript({
      code: "throw new Error('nope')",
      capabilities: {},
      ...sink,
    });
    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
    expect(events.map((event) => event.outcome)).toEqual(["success", "execution_failure"]);
    expect(events.every((event) => event.kind === "execution")).toBe(true);
  });

  it("emits cancelled when the host signal is already aborted", async () => {
    const events: AgentLifecycleEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    await runCodeModeScript({
      code: "1",
      capabilities: {},
      signal: controller.signal,
      emit: (event) => events.push(event),
      role: "ask",
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(events[0]?.kind).toBe("execution");
    if (events[0]?.kind === "execution") {
      expect(events[0].outcome).toBe("cancelled");
      expect(events[0].terminationReason).toBe("host_cancel");
    }
  });

  it("overlaps two delayed host reads inside one Promise.all", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await runCodeModeScript({
      code: `await Promise.all([
        tools.readWorkspaceFile({ path: "a.ts" }),
        tools.readWorkspaceFile({ path: "b.ts" }),
      ])`,
      capabilities: {
        readWorkspaceFile: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => {
            setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { path: "x.ts", content: "ok", startLine: 1, endLine: 1 };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(2);
  });

  it("commits explicit state only after a successful cell", async () => {
    const execute = buildCodeModeExecuteTool({ capabilities: {} });
    const first = asResult(await execute.executor({ code: "state.flag = 7; state.flag" }));
    const second = asResult(await execute.executor({ code: "state.flag" }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.output).toBe(7);

    const session = createExecutionSessionStore();
    let releaseHost: (() => void) | undefined;
    const aborted = runCodeModeScript({
      code: 'state.flag = 99; await tools.readWorkspaceFile({ path: "a.ts" }); state.flag',
      session,
      capabilities: {
        readWorkspaceFile: async () =>
          new Promise((resolve) => {
            releaseHost = () => resolve({ path: "a.ts", content: "x", startLine: 1, endLine: 1 });
          }),
      },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    session.closeAdmission();
    session.invalidate();
    releaseHost?.();
    const abortedResult = await aborted;
    expect(abortedResult.ok).toBe(false);
    const afterAbort = await runCodeModeScript({
      code: "Object.prototype.hasOwnProperty.call(state, 'flag')",
      session,
      capabilities: {},
    });
    expect(afterAbort.ok).toBe(true);
    if (afterAbort.ok) expect(afterAbort.output).toBe(false);
  });

  it("keeps a truncated file read as a string and records only delivered lines", async () => {
    const headSha = "abc123";
    const ledger = createEvidenceLedger(headSha);
    const lines = Array.from(
      { length: 800 },
      (_, index) => `line-${String(index + 1).padStart(3, "0")}:${"x".repeat(80)}`,
    ).join("\n");
    const result = await runCodeModeScript({
      code: `const file = await tools.readWorkspaceFile({ path: "big.ts" });
        ({ kind: typeof file.content, length: file.content.length, truncated: file.truncation && file.truncation.truncated })`,
      capabilities: {
        readWorkspaceFile: async () => ({
          path: "big.ts",
          content: lines,
          startLine: 1,
          endLine: 800,
        }),
      },
      evidenceLedger: ledger,
      headSha,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.output as { kind: string; length: number; truncated: boolean };
      expect(output.kind).toBe("string");
      expect(output.length).toBeLessThan(lines.length);
      expect(output.truncated).toBe(true);
    }
    expect(ledger.covers("big.ts", 1, 1)).toBe(true);
    expect(ledger.covers("big.ts", 800, 800)).toBe(false);
  });
});
