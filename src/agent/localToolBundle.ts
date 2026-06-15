import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";

export type LocalTool<TSchema extends z.ZodType = z.ZodType> = {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: z.infer<TSchema>) => Promise<unknown>;
};

export function defineLocalTool<TSchema extends z.ZodType>(
  tool: LocalTool<TSchema>,
): LocalTool<TSchema> {
  return tool;
}

function toPiTool(name: string, t: LocalTool): PiTool {
  return {
    name,
    description: t.description,
    parameters: z.toJSONSchema(t.schema, {
      unrepresentable: "any",
    }) as PiTool["parameters"],
  };
}

function toExecutor(t: LocalTool): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => t.run(t.schema.parse(args));
}

export function defineLocalToolBundle(tools: Record<string, LocalTool>): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  return {
    piTools: Object.entries(tools).map(([name, tool]) => toPiTool(name, tool)),
    executors: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, toExecutor(tool)]),
    ),
  };
}
