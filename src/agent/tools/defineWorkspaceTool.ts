import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { parseToolInput } from "./parseToolInput.js";

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

export function toExecutor(
  name: string,
  t: LocalTool,
): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => {
    const parsed = parseToolInput(t.schema, args, {
      toolName: name,
      errorTitle: `${name} validation failed:`,
    });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return t.run(parsed.value);
  };
}
