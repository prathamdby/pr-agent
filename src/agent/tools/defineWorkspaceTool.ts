import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { AppError } from "../../errors/appError.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import type { JsonValue } from "../../util/jsonValue.js";
import { parseToolInput } from "./parseToolInput.js";

export type ToolOutput = JsonValue;
export type ToolExecutor = AgentRunnerToolExecutor;

export type LocalTool<TSchema extends v.GenericSchema = v.GenericSchema> = {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: v.InferOutput<TSchema>) => Promise<ToolOutput>;
};

export function defineLocalTool<TSchema extends v.GenericSchema>(tool: {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: v.InferOutput<TSchema>) => Promise<ToolOutput>;
}): LocalTool<TSchema> {
  return tool;
}

export function toPiTool<TSchema extends v.GenericSchema>(
  name: string,
  t: LocalTool<TSchema>,
): PiTool {
  return {
    name,
    description: t.description,
    parameters: toJsonSchema(t.schema, {
      errorMode: "ignore",
    }),
  };
}

export function toExecutor<TSchema extends v.GenericSchema>(
  name: string,
  t: LocalTool<TSchema>,
): ToolExecutor {
  return async (args) => {
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
    return t.run(parsed.value);
  };
}
