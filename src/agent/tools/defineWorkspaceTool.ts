import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";

export type LocalTool<TSchema extends z.ZodType = z.ZodTypeAny> = {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: any) => Promise<unknown>;
};

export function defineLocalTool<TSchema extends z.ZodType>(tool: {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: z.infer<TSchema>) => Promise<unknown>;
}): LocalTool<TSchema> {
  return tool;
}

export function toPiTool(name: string, t: LocalTool): PiTool {
  return {
    name,
    description: t.description,
    parameters: z.toJSONSchema(t.schema, {
      unrepresentable: "any",
    }) as PiTool["parameters"],
  };
}

export function toExecutor(t: LocalTool): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => t.run(t.schema.parse(args));
}
