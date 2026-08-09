import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";

export type LocalTool<TSchema extends v.GenericSchema = v.GenericSchema> = {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: any) => Promise<unknown>;
};

export function defineLocalTool<TSchema extends v.GenericSchema>(tool: {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: v.InferOutput<TSchema>) => Promise<unknown>;
}): LocalTool<TSchema> {
  return tool;
}

export function toPiTool(name: string, t: LocalTool): PiTool {
  return {
    name,
    description: t.description,
    parameters: toJsonSchema(t.schema, {
      errorMode: "ignore",
    }),
  };
}

export function toExecutor(t: LocalTool): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => t.run(v.parse(t.schema, args));
}
