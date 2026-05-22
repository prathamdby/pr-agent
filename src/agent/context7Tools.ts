import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";

import { CONTEXT7_BASE_URL } from "../settings/index.js";

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

type ReviewTool = {
  readonly description: string;
  readonly schema: z.ZodType;
  readonly run: (parsed: any) => Promise<unknown>;
};

function toPiTool(name: string, t: ReviewTool): PiTool {
  return {
    name,
    description: t.description,
    parameters: z.toJSONSchema(t.schema, { unrepresentable: "any" }) as PiTool["parameters"],
  };
}

function toExecutor(t: ReviewTool): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => t.run(t.schema.parse(args));
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
    throw new Error(`Context7 ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await res.json();
    return JSON.stringify(body, null, 2);
  }
  return await res.text();
}

/**
 * Library-docs lookup tools the review agent uses to verify upstream API claims.
 * Calls https://context7.com/api directly; SDK was avoided because its constructor
 * rejects missing API keys, which would break anonymous fallback.
 * See docs/adr/0003-context7-docs-tool.md.
 */
export function buildContext7Tools({ apiKey }: { apiKey: string }): {
  piTools: PiTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const resolveLibraryId: ReviewTool = {
    description:
      "Resolve an external library name (e.g. 'react') to its canonical Context7 library ID (e.g. '/facebook/react'). Always call before getLibraryDocs unless an exact slash-prefixed ID is already known.",
    schema: resolveLibraryIdSchema,
    run: async ({ libraryName, query }) => {
      const params = new URLSearchParams({
        libraryName,
        query: query?.trim() || libraryName,
      });
      return context7Get(`${CONTEXT7_BASE_URL}/v2/libs/search?${params.toString()}`, apiKey);
    },
  };

  const getLibraryDocs: ReviewTool = {
    description:
      "Fetch current documentation for a third-party library by its Context7 library ID. Returns formatted prose. Use to verify a claim about upstream API shape or version-specific behaviour before flagging a finding.",
    schema: getLibraryDocsSchema,
    run: async ({ libraryId, topic }) => {
      const params = new URLSearchParams({
        libraryId,
        type: "txt",
      });
      const topicTrimmed = topic?.trim();
      if (topicTrimmed) params.set("query", topicTrimmed);
      return context7Get(`${CONTEXT7_BASE_URL}/v2/context?${params.toString()}`, apiKey);
    },
  };

  const tools = { resolveLibraryId, getLibraryDocs };
  const entries = Object.entries(tools);

  return {
    piTools: entries.map(([name, t]) => toPiTool(name, t)),
    executors: Object.fromEntries(entries.map(([name, t]) => [name, toExecutor(t)])),
  };
}
