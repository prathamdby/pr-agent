import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runtimeImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file == null) continue;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    // Drop type-only imports so `import type { Config }` does not pull config/Pi.
    const stripped = text
      .replace(/^import\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
      .replace(/^import\s+type\s+[^;]+;?\s*$/gm, "");
    for (const match of stripped.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      let spec = match[1];
      if (spec.endsWith(".js")) spec = `${spec.slice(0, -3)}.ts`;
      else if (!spec.endsWith(".ts")) spec = `${spec}.ts`;
      const next = resolve(dirname(file), spec).replace(`${process.cwd()}/`, "");
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

describe("web import graph", () => {
  it("keeps webhook server free of worker executors and orchestrator", () => {
    const graph = runtimeImportGraph("src/effect/server.ts");
    expect(graph.size).toBeLessThan(120);
    expect(graph.has("src/agentWork/runtime.ts")).toBe(true);
    expect(graph.has("src/agentWork/worker.ts")).toBe(false);
    expect(graph.has("src/agentWork/workerRuntime.ts")).toBe(false);
    expect(graph.has("src/agentWork/executors/index.ts")).toBe(false);
    expect(graph.has("src/review/orchestrator/orchestratorRun.ts")).toBe(false);
    expect(graph.has("src/agent/runtime/piSession.ts")).toBe(false);
    expect(graph.has("src/settings/modelsJson.ts")).toBe(false);
  });
});
