import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";

import { AppError } from "../../errors/appError.js";
import { CONTEXT7_BASE_URL } from "../../settings/index.js";
import type { AgentRunnerToolExecutorMap } from "../providers/interface.js";
import {
  isJsonObject,
  isJsonString,
  parseJsonText,
  type JsonObject,
} from "../../util/jsonValue.js";
import { parseToolInput } from "./parseToolInput.js";
import { capTextOutput } from "./toolOutputBudget.js";

const resolveLibraryIdSchema = v.object({
  libraryName: v.pipe(
    v.string(),
    v.description("Third-party library name to resolve, e.g. 'react', 'next.js', 'zod'."),
  ),
  query: v.pipe(
    v.optional(v.string()),
    v.description(
      "Optional ranking query; defaults to libraryName. Use to disambiguate when several packages share a name.",
    ),
  ),
});

const getLibraryDocsSchema = v.object({
  libraryId: v.pipe(
    v.string(),
    v.description(
      "Context7 library ID returned by resolveLibraryId, e.g. '/facebook/react' or '/vercel/next.js'.",
    ),
  ),
  topic: v.pipe(
    v.optional(v.string()),
    v.description(
      "Optional topic or API question to focus the returned docs, e.g. 'hooks', 'middleware', 'schema typing'.",
    ),
  ),
});

export type Context7ToolResponse = {
  readonly content: string;
  readonly truncated: boolean;
  readonly returnedBytes: number;
  readonly truncationReason?: string;
};

type ReviewTool<TSchema extends v.GenericSchema = v.GenericSchema> = {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (
    parsed: v.InferOutput<TSchema>,
    apiKey: string,
    maxResponseBytes: number,
  ) => Promise<Context7ToolResponse>;
};

function toPiTool<TSchema extends v.GenericSchema>(name: string, t: ReviewTool<TSchema>): PiTool {
  return {
    name,
    description: t.description,
    parameters: toJsonSchema(t.schema, {
      errorMode: "ignore",
    }),
  };
}

function toExecutor<TSchema extends v.GenericSchema>(
  name: string,
  t: ReviewTool<TSchema>,
  apiKey: string,
  maxResponseBytes: number,
): (args: JsonObject) => Promise<Context7ToolResponse> {
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
    return t.run(parsed.value, apiKey, maxResponseBytes);
  };
}

async function context7ErrorDetail(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return "";
  try {
    const parsed = parseJsonText(text);
    if (!isJsonObject(parsed)) return "";
    const error = parsed.error;
    if (error !== undefined && isJsonString(error) && error.length > 0) return error;
    const message = parsed.message;
    if (message !== undefined && isJsonString(message) && message.length > 0) return message;
    return "";
  } catch {
    return text;
  }
}

type Context7RequestHeaders = {
  Accept: string;
  Authorization?: string;
};

async function context7Get(url: string, apiKey: string): Promise<string> {
  const headers: Context7RequestHeaders = {
    Accept: "application/json, text/plain",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const detail = await context7ErrorDetail(res);
    throw new AppError({
      code: "context7.request_failed",
      message: `Context7 ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
      context: { status: res.status, statusText: res.statusText, url },
    });
  }

  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    const body = parseJsonText(text);
    return JSON.stringify(body, null, 2);
  }
  return text;
}

function capContext7Response(text: string, maxResponseBytes: number): Context7ToolResponse {
  const capped = capTextOutput(text, maxResponseBytes, "response byte budget exceeded");
  if (capped.truncationReason) {
    return {
      content: capped.content,
      truncated: capped.truncated,
      returnedBytes: capped.returnedBytes,
      truncationReason: capped.truncationReason,
    };
  }
  return {
    content: capped.content,
    truncated: capped.truncated,
    returnedBytes: capped.returnedBytes,
  };
}

const resolveLibraryIdTool: ReviewTool<typeof resolveLibraryIdSchema> = {
  description:
    "Resolve an external library name (e.g. 'react') to its canonical Context7 library ID (e.g. '/facebook/react'). Always call before getLibraryDocs unless an exact slash-prefixed ID is already known. Responses are capped; narrow the query when truncated.",
  schema: resolveLibraryIdSchema,
  run: async ({ libraryName, query }, apiKey, maxResponseBytes) => {
    const params = new URLSearchParams({
      libraryName,
      query: query?.trim() || libraryName,
    });
    const text = await context7Get(
      `${CONTEXT7_BASE_URL}/v2/libs/search?${params.toString()}`,
      apiKey,
    );
    return capContext7Response(text, maxResponseBytes);
  },
};

const getLibraryDocsTool: ReviewTool<typeof getLibraryDocsSchema> = {
  description:
    "Fetch current documentation for a third-party library by its Context7 library ID. Returns formatted prose. Use to verify a claim about upstream API shape or version-specific behaviour before flagging a finding. Responses are capped; narrow the topic when truncated.",
  schema: getLibraryDocsSchema,
  run: async ({ libraryId, topic }, apiKey, maxResponseBytes) => {
    const params = new URLSearchParams({
      libraryId,
      type: "txt",
    });
    const topicTrimmed = topic?.trim();
    if (topicTrimmed) params.set("query", topicTrimmed);
    const text = await context7Get(`${CONTEXT7_BASE_URL}/v2/context?${params.toString()}`, apiKey);
    return capContext7Response(text, maxResponseBytes);
  },
};

const CONTEXT7_PI_TOOLS = [
  toPiTool("resolveLibraryId", resolveLibraryIdTool),
  toPiTool("getLibraryDocs", getLibraryDocsTool),
];

export type Context7ToolExecutors = {
  readonly resolveLibraryId: (args: JsonObject) => Promise<Context7ToolResponse>;
  readonly getLibraryDocs: (args: JsonObject) => Promise<Context7ToolResponse>;
};

export type Context7Tools = {
  readonly piTools: PiTool[];
  readonly executors: Context7ToolExecutors;
};

/**
 * Library-docs lookup tools the review agent uses to verify upstream API claims.
 * Calls https://context7.com/api directly; SDK was avoided because its constructor
 * rejects missing API keys, which would break anonymous fallback.
 * See docs/adr/0003-context7-docs-tool.md.
 */
export function buildContext7Tools({
  apiKey,
  maxResponseBytes,
}: {
  apiKey: string;
  maxResponseBytes: number;
}): Context7Tools {
  return {
    piTools: [...CONTEXT7_PI_TOOLS],
    executors: {
      resolveLibraryId: toExecutor(
        "resolveLibraryId",
        resolveLibraryIdTool,
        apiKey,
        maxResponseBytes,
      ),
      getLibraryDocs: toExecutor("getLibraryDocs", getLibraryDocsTool, apiKey, maxResponseBytes),
    } satisfies AgentRunnerToolExecutorMap,
  };
}
