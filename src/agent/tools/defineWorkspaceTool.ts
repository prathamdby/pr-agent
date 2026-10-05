import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { AppError } from "../../errors/appError.js";
import { type AgentRunnerToolExecutor, type AgentToolCallContext } from "../providers/interface.js";
import { parseToolInput } from "./parseToolInput.js";

export type LocalTool<TResult = unknown> = {
  readonly description: string;
  readonly schema: v.GenericSchema;
  readonly execute: (name: string, raw: unknown, ctx?: AgentToolCallContext) => Promise<TResult>;
};

export function defineLocalTool<TSchema extends v.GenericSchema, TResult>(tool: {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: v.InferOutput<TSchema>, ctx?: AgentToolCallContext) => Promise<TResult>;
}): LocalTool<TResult> {
  return {
    description: tool.description,
    schema: tool.schema,
    execute: async (name, raw, ctx) => {
      const parsed = parseToolInput(tool.schema, raw, {
        toolName: name,
        errorTitle: `${name} validation failed:`,
      });
      if (!parsed.ok) {
        throw new AppError({
          domain: "tool",
          kind: "input_validation_failed",
          message: parsed.error,
          context: { toolName: name },
        });
      }
      return ctx != null ? tool.run(parsed.value, ctx) : tool.run(parsed.value);
    },
  };
}

export function toPiTool(
  name: string,
  t: Pick<LocalTool, "description" | "schema"> & { readonly run?: unknown },
): PiTool {
  return {
    name,
    description: t.description,
    parameters: toJsonSchema(t.schema, {
      errorMode: "ignore",
    }),
  };
}

export function toExecutor<TResult>(
  name: string,
  t: LocalTool<TResult>,
): (args: Parameters<AgentRunnerToolExecutor>[0], ctx?: AgentToolCallContext) => Promise<TResult> {
  return (args, ctx) => t.execute(name, args, ctx);
}
