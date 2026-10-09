import { renderResourceLinks } from "./agentResources.js";
import {
  LIST_TOOL_NAME,
  MCP_TOOLS,
  QUERY_TOOL_NAME,
  type AgentToolDefinition,
} from "./agentTools.js";
import { answerAgentQuery, parseAgentQuery, renderAnswerText } from "./llmsKnowledge.js";

const JSON_TYPE = "application/json; charset=utf-8";
const SERVER_NAME = "pr-agent-site";
const SERVER_VERSION = "1.0.0";
const SERVER_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = ["2025-03-26", "2025-06-18", "2025-11-25"] as const;
const MAX_BODY_BYTES = 64 * 1024;

const JSON_HEADERS = {
  "Content-Type": JSON_TYPE,
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

type RpcId = string | number | null;

type ParsedRpc =
  | { readonly kind: "parse_error" }
  | { readonly kind: "invalid" }
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  | {
      readonly kind: "request";
      readonly id: RpcId;
      readonly method: string;
      readonly params: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcId(value: unknown): RpcId | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  return undefined;
}

function parseRpc(raw: string): ParsedRpc {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "parse_error" };
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return { kind: "invalid" };
  }
  if (!Object.hasOwn(value, "id")) {
    return { kind: "notification", method: value.method, params: value.params };
  }
  const id = rpcId(value.id);
  if (id === undefined) {
    return { kind: "invalid" };
  }
  return { kind: "request", id, method: value.method, params: value.params };
}

function jsonResponse(status: number, body: unknown, extra?: HeadersInit): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extra !== undefined) {
    const more = new Headers(extra);
    for (const [name, value] of more) {
      headers.set(name, value);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function rpcResult(id: RpcId, result: unknown): Response {
  return jsonResponse(200, { jsonrpc: "2.0", id, result });
}

function rpcError(id: RpcId, code: number, message: string): Response {
  const status = code === -32700 || code === -32600 ? 400 : 200;
  return jsonResponse(status, { jsonrpc: "2.0", id, error: { code, message } });
}

function protocolVersion(params: unknown): string {
  if (!isRecord(params) || typeof params.protocolVersion !== "string") {
    return SERVER_PROTOCOL;
  }
  const requested = params.protocolVersion;
  for (const supported of SUPPORTED_PROTOCOLS) {
    if (supported === requested) {
      return requested;
    }
  }
  return SERVER_PROTOCOL;
}

function toolArguments(params: unknown): Record<string, unknown> | null {
  if (params === undefined) {
    return {};
  }
  if (!isRecord(params)) {
    return null;
  }
  const args = params.arguments;
  if (args === undefined) {
    return {};
  }
  if (!isRecord(args)) {
    return null;
  }
  return args;
}

function toolName(params: unknown): string | null {
  if (!isRecord(params) || typeof params.name !== "string" || params.name === "") {
    return null;
  }
  return params.name;
}

function toolText(text: string, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case QUERY_TOOL_NAME: {
      const query = args.query;
      if (typeof query !== "string") {
        return toolText("query must be a string", true);
      }
      return toolText(renderAnswerText(answerAgentQuery(parseAgentQuery(query))));
    }
    case LIST_TOOL_NAME:
      return toolText(renderResourceLinks());
    default:
      return toolText(`Unknown tool: ${name}`, true);
  }
}

function toolDescriptor(tool: AgentToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function handleRequest(message: Extract<ParsedRpc, { kind: "request" }>): Response {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: protocolVersion(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Read-only. query_pr_agent answers from this site's profile. No authentication.",
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: MCP_TOOLS.map(toolDescriptor) });
    case "tools/call": {
      const name = toolName(params);
      const args = toolArguments(params);
      if (name === null || args === null) {
        return rpcError(id, -32602, "tools/call needs a tool name and object arguments");
      }
      return rpcResult(id, callTool(name, args));
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** GET is not a session stream. Clients POST one JSON-RPC message at a time. */
export function mcpMethodNotAllowed(): Response {
  return jsonResponse(
    405,
    {
      error: "method_not_allowed",
      detail: "POST a single JSON-RPC message. This server does not open an SSE stream.",
    },
    { Allow: "POST" },
  );
}

export async function mcpPostResponse(request: Request): Promise<Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return rpcError(null, -32600, "request is too large");
  }
  const message = parseRpc(raw);
  switch (message.kind) {
    case "parse_error":
      return rpcError(null, -32700, "parse error");
    case "invalid":
      return rpcError(null, -32600, "invalid request");
    case "notification":
      return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
    case "request":
      return handleRequest(message);
    default: {
      const _exhaustive: never = message;
      return _exhaustive;
    }
  }
}
