import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { AppError } from "../../errors/appError.js";
import { type AgentRunnerToolExecutor, type AgentToolCallContext } from "../providers/interface.js";
import { parseToolInput } from "./parseToolInput.js";

export type LocalTool<TSchema extends v.GenericSchema = v.GenericSchema> = {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: any, ctx?: AgentToolCallContext) => Promise<unknown>;
};

export function defineLocalTool<TSchema extends v.GenericSchema>(tool: {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: v.InferOutput<TSchema>, ctx?: AgentToolCallContext) => Promise<unknown>;
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

export function toExecutor(name: string, t: LocalTool): AgentRunnerToolExecutor {
  return async (args, ctx) => {
    const parsed = parseToolInput(t.schema, args, {
      toolName: name,
      errorTitle: `${name} validation failed:`,
    });
    if (!parsed.ok) {
      throw new AppError({
        code: "tool.input_validation_failed",
        message: parsed.error,
        context: { toolName: name },
      });
    }
    return ctx != null ? t.run(parsed.value, ctx) : t.run(parsed.value);
  };
}
