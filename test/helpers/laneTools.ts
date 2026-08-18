import type { Tool as PiTool } from "@earendil-works/pi-ai";

export function stubLaneCatalog(names: readonly string[]): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, () => Promise<Record<string, never>>>;
} {
  const piTools = names.map((name) => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
  }));
  const executors = Object.fromEntries(names.map((name) => [name, async () => ({})]));
  return { piTools, executors };
}
