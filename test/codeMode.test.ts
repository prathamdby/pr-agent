import { describe, expect, it } from "vitest";
import { hideWorkspaceToolsBehindCodeMode } from "../src/agent/codemode/assembleExplorationTools.js";
import { runWithCodeModeContext } from "../src/agent/codemode/context.js";
import { buildCodeModeExecuteTool } from "../src/agent/codemode/executeTool.js";
import type { CodeModeResult } from "../src/agent/codemode/result.js";
import { runCodeModeScript } from "../src/agent/codemode/runScript.js";
import { serializeCodeModeValue } from "../src/agent/codemode/serialize.js";
import { AppError } from "../src/errors/appError.js";
import { startWorkerHealthServer } from "../src/agentWork/workerHealth.js";
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
    expect(elapsedMs).toBeLessThan(100);
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
    expect(Date.now() - started).toBeLessThan(100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
  });

  it("keeps Promise.then and new Promise on the host halt path", async () => {
    for (const code of [
      "Promise.resolve().then(() => { while (true) {} })",
      "new Promise((resolve) => { while (true) {} })",
    ]) {
      const started = Date.now();
      const result = await runCodeModeScript({ code, capabilities: {} });
      expect(result.ok, code).toBe(false);
      if (!result.ok) expect(result.error.code, code).toBe("EXECUTION_BUDGET_EXCEEDED");
      expect(Date.now() - started, code).toBeLessThan(100);
    }
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

  it("rejects ReDoS-prone patterns on string methods", async () => {
    const input = '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaX"';
    const scripts = [
      `${input}.replace(new RegExp("(a+)+$"), "x")`,
      `${input}.replaceAll(new RegExp("(a+)+$", "g"), "x")`,
      `${input}.search(new RegExp("(a+)+$"))`,
      `${input}.split(new RegExp("(a+)+$"))`,
      `${input}.matchAll(new RegExp("(a+)+$", "g"))`,
    ];
    for (const code of scripts) {
      const started = Date.now();
      const result = await runCodeModeScript({ code, capabilities: {} });
      expect(Date.now() - started, code).toBeLessThan(100);
      expect(result.ok, code).toBe(false);
      if (!result.ok) expect(result.error.code, code).toBe("LIMIT_EXCEEDED");
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
    if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
    expect(Date.now() - started).toBeLessThan(100);
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

  it("returns structured diagnostics for unsupported constructs", async () => {
    const result = await runCodeModeScript({
      code: "class Foo {}",
      capabilities: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXECUTION_ERROR");
      expect(result.error.message).toContain("Unsupported language construct");
    }
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
        text: { truncated: true; value: string };
      };
      expect(output.items.truncated).toBe(true);
      expect(output.items.omittedCount).toBeGreaterThan(0);
      expect(output.text.truncated).toBe(true);
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
    const result = await runWithCodeModeContext({ signal: controller.signal }, () =>
      runCodeModeScript({
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
      }),
    );
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
});
