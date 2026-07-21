import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";

import { AppError } from "../../errors/appError.js";
import { CONTEXT7_BASE_URL } from "../../settings/index.js";
import { capTextOutput } from "./toolOutputBudget.js";

const resolveLibraryIdSchema = z.object({
  libraryName: z
    .string()
    .describe("Third-party library name to resolve, e.g. 'react', 'next.js', 'zod'."),
  query: z
    .string()
    .optional()
    .describe(
      "Optional ranking query; defaults to libraryName. Use to disambiguate when several packages share a name.",
    ),
});

const getLibraryDocsSchema = z.object({
  libraryId: z
    .string()
    .describe(
      "Context7 library ID returned by resolveLibraryId, e.g. '/facebook/react' or '/vercel/next.js'.",
    ),
  topic: z
    .string()
    .optional()
    .describe(
      "Optional topic or API question to focus the returned docs, e.g. 'hooks', 'middleware', 'schema typing'.",
    ),
});

export type Context7ToolResponse = {
  readonly content: string;
  readonly truncated: boolean;
  readonly returnedBytes: number;
  readonly truncationReason?: string;
};

type ReviewTool = {
  readonly description: string;
  readonly schema: z.ZodType;
  readonly run: (
    parsed: any,
    apiKey: string,
    maxResponseBytes: number,
  ) => Promise<Context7ToolResponse>;
};

function toPiTool(name: string, t: ReviewTool): PiTool {
  return {
    name,
    description: t.description,
    parameters: z.toJSONSchema(t.schema, {
      unrepresentable: "any",
    }) as PiTool["parameters"],
  };
}

function toExecutor(
  t: ReviewTool,
  apiKey: string,
  maxResponseBytes: number,
): (args: Record<string, unknown>) => Promise<Context7ToolResponse> {
  return async (args) => t.run(t.schema.parse(args), apiKey, maxResponseBytes);
}

function authHeader(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function context7Get(url: string, apiKey: string): Promise<string> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain",
      ...authHeader(apiKey),
    },
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.error ?? body.message ?? "";
    } catch {
      try {
        detail = await res.text();
      } catch {
        /* response body is unreadable; keep detail empty */
      }
    }
    throw new AppError({
      code: "context7.request_failed",
      message: `Context7 ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
      context: { status: res.status, statusText: res.statusText, url },
    });
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    const body: unknown = await res.json();
    return JSON.stringify(body, null, 2);
  }
  return await res.text();
}

function capContext7Response(text: string, maxResponseBytes: number): Context7ToolResponse {
  const capped = capTextOutput(text, maxResponseBytes, "response byte budget exceeded");
  return {
    content: capped.content,
    truncated: capped.truncated,
    returnedBytes: capped.returnedBytes,
    ...(capped.truncationReason ? { truncationReason: capped.truncationReason } : {}),
  };
}

const CONTEXT7_TOOLS: Record<string, ReviewTool> = {
  resolveLibraryId: {
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
  },
  getLibraryDocs: {
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
      const text = await context7Get(
        `${CONTEXT7_BASE_URL}/v2/context?${params.toString()}`,
        apiKey,
      );
      return capContext7Response(text, maxResponseBytes);
    },
  },
};

const CONTEXT7_TOOL_ENTRIES = Object.entries(CONTEXT7_TOOLS);
const CONTEXT7_PI_TOOLS = CONTEXT7_TOOL_ENTRIES.map(([name, tool]) => toPiTool(name, tool));

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
}): {
  piTools: PiTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<Context7ToolResponse>>;
} {
  return {
    piTools: [...CONTEXT7_PI_TOOLS],
    executors: Object.fromEntries(
      CONTEXT7_TOOL_ENTRIES.map(([name, tool]) => [
        name,
        toExecutor(tool, apiKey, maxResponseBytes),
      ]),
    ),
  };
}
