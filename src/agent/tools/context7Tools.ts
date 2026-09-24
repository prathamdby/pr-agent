import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";

import { AppError } from "../../errors/appError.js";
import {
  CONTEXT7_BASE_URL,
  CONTEXT7_LIBRARY_ID_MAX_CHARS,
  CONTEXT7_LIBRARY_NAME_MAX_CHARS,
  CONTEXT7_QUERY_MAX_CHARS,
  CONTEXT7_TOPIC_MAX_CHARS,
} from "../../settings/index.js";
import {
  assertContext7LibraryId,
  assertContext7LibraryName,
  CONTEXT7_LIBRARY_ID_PATTERN,
  CONTEXT7_LIBRARY_NAME_PATTERN,
  prepareContext7OutboundText,
  redactContext7Json,
  redactContext7Response,
} from "../../security/context7OutboundPolicy.js";
import { capTextOutput } from "./toolOutputBudget.js";
import { toExecutor } from "./defineWorkspaceTool.js";
import type { AgentToolCallContext } from "../providers/interface.js";

const resolveLibraryIdSchema = v.object({
  libraryName: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(CONTEXT7_LIBRARY_NAME_MAX_CHARS),
    v.regex(CONTEXT7_LIBRARY_NAME_PATTERN, "must be a package identifier"),
    v.description("Third-party library name to resolve, e.g. 'react', 'next.js', 'zod'."),
  ),
  query: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(CONTEXT7_QUERY_MAX_CHARS),
      v.description(
        "Optional short documentation-ranking query; defaults to libraryName. Do not include source code, prompts, comments, credentials, URLs, or tool output.",
      ),
    ),
  ),
});

const getLibraryDocsSchema = v.object({
  libraryId: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(CONTEXT7_LIBRARY_ID_MAX_CHARS),
    v.regex(CONTEXT7_LIBRARY_ID_PATTERN, "must be a slash-prefixed library identifier"),
    v.description(
      "Context7 library ID returned by resolveLibraryId, e.g. '/facebook/react' or '/vercel/next.js'.",
    ),
  ),
  topic: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(CONTEXT7_TOPIC_MAX_CHARS),
      v.description(
        "Optional short topic or API question. Do not include source code, prompts, comments, credentials, URLs, or tool output.",
      ),
    ),
  ),
});

export type Context7ToolResponse = {
  readonly content: string;
  readonly truncated: boolean;
  readonly returnedBytes: number;
  readonly truncationReason?: string;
  readonly omittedResults?: number;
};

type Context7Body = { kind: "json"; value: unknown } | { kind: "text"; text: string };

type Context7ResultsBody = { results: unknown[] } & Record<string, unknown>;

function isContext7ResultsBody(value: unknown): value is Context7ResultsBody {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { results?: unknown }).results)
  );
}

export function fitContext7Json(
  value: unknown,
  maxBytes: number,
): { content: string; omittedResults: number } {
  const full = JSON.stringify(value);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return { content: full, omittedResults: 0 };
  }
  if (!isContext7ResultsBody(value)) {
    throw new AppError({
      code: "context7.response_too_large",
      message: "Context7 JSON response exceeds the byte budget and has no results array to drop",
    });
  }
  const { results } = value;
  const rest: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (key === "results") continue;
    Object.defineProperty(rest, key, {
      value: entry,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const fits = (count: number): string | undefined => {
    const body: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(rest)) {
      Object.defineProperty(body, key, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    Object.defineProperty(body, "results", {
      value: results.slice(0, count),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const content = JSON.stringify(body);
    return Buffer.byteLength(content, "utf8") <= maxBytes ? content : undefined;
  };
  if (fits(0) === undefined) {
    throw new AppError({
      code: "context7.response_too_large",
      message: "Context7 JSON response exceeds the byte budget even with no results",
    });
  }
  let low = 0;
  let high = results.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid) !== undefined) low = mid;
    else high = mid - 1;
  }
  const content = fits(low);
  if (content === undefined) {
    throw new AppError({
      code: "context7.response_too_large",
      message: "Context7 JSON response exceeds the byte budget even with no results",
    });
  }
  return { content, omittedResults: results.length - low };
}

type ReviewTool = {
  readonly description: string;
  readonly schema: v.GenericSchema;
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
    parameters: toJsonSchema(t.schema, {
      errorMode: "ignore",
    }),
  };
}

function authHeader(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

type Context7Endpoint = "/v2/libs/search" | "/v2/context";

function context7Url(endpoint: Context7Endpoint, params: Readonly<Record<string, string>>): string {
  const url = new URL(`${CONTEXT7_BASE_URL}${endpoint}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

async function context7Get(
  endpoint: Context7Endpoint,
  params: Readonly<Record<string, string>>,
  apiKey: string,
): Promise<Context7Body> {
  const url = context7Url(endpoint, params);
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
      const rawBody = await res.text();
      try {
        const body = JSON.parse(rawBody) as { error?: string; message?: string };
        detail = body.error ?? body.message ?? "";
      } catch {
        detail = rawBody;
      }
    } catch {
      /* response body is unreadable; keep detail empty */
    }
    detail = redactContext7Response(detail, apiKey);
    throw new AppError({
      code: "context7.request_failed",
      message: `Context7 ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
      context: { status: res.status, statusText: res.statusText, url },
    });
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    const body: unknown = await res.json();
    return { kind: "json", value: redactContext7Json(body, apiKey) };
  }
  return { kind: "text", text: redactContext7Response(await res.text(), apiKey) };
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

function presentContext7Body(body: Context7Body, maxResponseBytes: number): Context7ToolResponse {
  if (body.kind === "text") return capContext7Response(body.text, maxResponseBytes);
  const fitted = fitContext7Json(body.value, maxResponseBytes);
  return {
    content: fitted.content,
    truncated: fitted.omittedResults > 0,
    returnedBytes: Buffer.byteLength(fitted.content, "utf8"),
    ...(fitted.omittedResults > 0 ? { omittedResults: fitted.omittedResults } : {}),
  };
}

const CONTEXT7_TOOLS: Record<string, ReviewTool> = {
  resolveLibraryId: {
    description:
      "Resolve a short third-party library identifier (e.g. 'react') to its canonical Context7 library ID (e.g. '/facebook/react'). Always call before getLibraryDocs unless an exact slash-prefixed ID is already known. Never send source, prompts, comments, credentials, URLs, or tool output. Responses are capped; narrow the query when truncated. omittedResults counts dropped JSON result entries.",
    schema: resolveLibraryIdSchema,
    run: async ({ libraryName, query }, apiKey, maxResponseBytes) => {
      const safeLibraryName = assertContext7LibraryName(libraryName);
      const safeQuery = query == null ? "" : prepareContext7OutboundText("query", query, apiKey);
      const text = await context7Get(
        "/v2/libs/search",
        {
          libraryName: safeLibraryName,
          query: safeQuery || safeLibraryName,
        },
        apiKey,
      );
      return presentContext7Body(text, maxResponseBytes);
    },
  },
  getLibraryDocs: {
    description:
      "Fetch current documentation for a validated third-party library ID. Returns formatted prose. Use to verify a claim about upstream API shape or version-specific behaviour before flagging a finding. Never send source, prompts, comments, credentials, URLs, or tool output. Responses are capped; narrow the topic when truncated.",
    schema: getLibraryDocsSchema,
    run: async ({ libraryId, topic }, apiKey, maxResponseBytes) => {
      const safeLibraryId = assertContext7LibraryId(libraryId);
      const safeTopic = topic == null ? "" : prepareContext7OutboundText("topic", topic, apiKey);
      const params: Record<string, string> = {
        libraryId: safeLibraryId,
        type: "txt",
      };
      if (safeTopic) params.query = safeTopic;
      const text = await context7Get("/v2/context", params, apiKey);
      return presentContext7Body(text, maxResponseBytes);
    },
  },
};

const CONTEXT7_TOOL_ENTRIES = Object.entries(CONTEXT7_TOOLS);
const CONTEXT7_PI_TOOLS = CONTEXT7_TOOL_ENTRIES.map(([name, tool]) => toPiTool(name, tool));

/**
 * Library-docs lookup tools the review agent uses to verify upstream API claims.
 * Calls https://context7.com/api directly; SDK was avoided because its constructor
 * rejects missing API keys, which would break anonymous fallback.
 * See docs/adr/0002-context7-docs-tool.md.
 */
export function buildContext7Tools({
  apiKey,
  maxResponseBytes,
}: {
  apiKey: string;
  maxResponseBytes: number;
}): {
  piTools: PiTool[];
  executors: Record<
    string,
    (args: Record<string, unknown>, ctx?: AgentToolCallContext) => Promise<Context7ToolResponse>
  >;
} {
  return {
    piTools: [...CONTEXT7_PI_TOOLS],
    executors: Object.fromEntries(
      CONTEXT7_TOOL_ENTRIES.map(([name, tool]) => {
        const execute = toExecutor(name, {
          description: tool.description,
          schema: tool.schema,
          run: (parsed) => tool.run(parsed, apiKey, maxResponseBytes),
        });
        return [name, async (args, ctx?) => (await execute(args, ctx)) as Context7ToolResponse];
      }),
    ),
  };
}
