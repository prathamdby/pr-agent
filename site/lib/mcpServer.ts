import { renderResourceLinks } from "./agentResources.ts";
import {
  LIST_TOOL_NAME,
  MCP_TOOLS,
  QUERY_TOOL_NAME,
  type AgentToolDefinition,
} from "./agentTools.ts";
import { answerAgentQuery, parseAgentQuery, renderAnswerText } from "./llmsKnowledge.ts";

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

function rpcId(value: unknown) {
  if (value === undefined) {
    return ((pinnedReturn: RpcId | undefined) => pinnedReturn)(undefined);
  }
  if (value === null || typeof value === "string" || typeof value === "number") {
    return ((pinnedReturn: RpcId | undefined) => pinnedReturn)(value);
  }
  return ((pinnedReturn: RpcId | undefined) => pinnedReturn)(undefined);
}

function parseRpc(raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return ((pinnedReturn: ParsedRpc) => pinnedReturn)({ kind: "parse_error" });
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return ((pinnedReturn: ParsedRpc) => pinnedReturn)({ kind: "invalid" });
  }
  if (!Object.hasOwn(value, "id")) {
    return ((pinnedReturn: ParsedRpc) => pinnedReturn)({
      kind: "notification",
      method: value.method,
      params: value.params,
    });
  }
  const id = rpcId(value.id);
  if (id === undefined) {
    return ((pinnedReturn: ParsedRpc) => pinnedReturn)({ kind: "invalid" });
  }
  return ((pinnedReturn: ParsedRpc) => pinnedReturn)({
    kind: "request",
    id,
    method: value.method,
    params: value.params,
  });
}

function jsonResponse(status: number, body: unknown, extra?: HeadersInit) {
  const headers = new Headers(JSON_HEADERS);
  if (extra !== undefined) {
    const more = new Headers(extra);
    for (const [name, value] of more) {
      headers.set(name, value);
    }
  }
  return ((pinnedReturn: Response) => pinnedReturn)(
    new Response(JSON.stringify(body), { status, headers }),
  );
}

function rpcResult(id: RpcId, result: unknown) {
  return ((pinnedReturn: Response) => pinnedReturn)(
    jsonResponse(200, { jsonrpc: "2.0", id, result }),
  );
}

function rpcError(id: RpcId, code: number, message: string) {
  const status = code === -32700 || code === -32600 ? 400 : 200;
  return ((pinnedReturn: Response) => pinnedReturn)(
    jsonResponse(status, { jsonrpc: "2.0", id, error: { code, message } }),
  );
}

function protocolVersion(params: unknown) {
  if (!isRecord(params) || typeof params.protocolVersion !== "string") {
    return ((pinnedReturn: string) => pinnedReturn)(SERVER_PROTOCOL);
  }
  const requested = params.protocolVersion;
  for (const supported of SUPPORTED_PROTOCOLS) {
    if (supported === requested) {
      return ((pinnedReturn: string) => pinnedReturn)(requested);
    }
  }
  return ((pinnedReturn: string) => pinnedReturn)(SERVER_PROTOCOL);
}

function toolArguments(params: unknown) {
  if (params === undefined) {
    return ((pinnedReturn: Record<string, unknown> | null) => pinnedReturn)({});
  }
  if (!isRecord(params)) {
    return ((pinnedReturn: Record<string, unknown> | null) => pinnedReturn)(null);
  }
  const args = params.arguments;
  if (args === undefined) {
    return ((pinnedReturn: Record<string, unknown> | null) => pinnedReturn)({});
  }
  if (!isRecord(args)) {
    return ((pinnedReturn: Record<string, unknown> | null) => pinnedReturn)(null);
  }
  return ((pinnedReturn: Record<string, unknown> | null) => pinnedReturn)(args);
}

function toolName(params: unknown) {
  if (!isRecord(params) || typeof params.name !== "string" || params.name === "") {
    return ((pinnedReturn: string | null) => pinnedReturn)(null);
  }
  return ((pinnedReturn: string | null) => pinnedReturn)(params.name);
}

function toolText(text: string, isError = false) {
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({
    content: [{ type: "text", text }],
    isError,
  });
}

function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case QUERY_TOOL_NAME: {
      const query = args.query;
      if (typeof query !== "string") {
        return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)(
          toolText("query must be a string", true),
        );
      }
      return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)(
        toolText(renderAnswerText(answerAgentQuery(parseAgentQuery(query)))),
      );
    }
    case LIST_TOOL_NAME:
      return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)(
        toolText(renderResourceLinks()),
      );
    default:
      return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)(
        toolText(`Unknown tool: ${name}`, true),
      );
  }
}

function toolDescriptor(tool: AgentToolDefinition) {
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
}

function handleRequest(message: Extract<ParsedRpc, { kind: "request" }>) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return ((pinnedReturn: Response) => pinnedReturn)(
        rpcResult(id, {
          protocolVersion: protocolVersion(params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "Read-only. query_pr_agent answers from this site's profile. No authentication.",
        }),
      );
    case "ping":
      return ((pinnedReturn: Response) => pinnedReturn)(rpcResult(id, {}));
    case "tools/list":
      return ((pinnedReturn: Response) => pinnedReturn)(
        rpcResult(id, { tools: MCP_TOOLS.map(toolDescriptor) }),
      );
    case "tools/call": {
      const name = toolName(params);
      const args = toolArguments(params);
      if (name === null || args === null) {
        return ((pinnedReturn: Response) => pinnedReturn)(
          rpcError(id, -32602, "tools/call needs a tool name and object arguments"),
        );
      }
      return ((pinnedReturn: Response) => pinnedReturn)(rpcResult(id, callTool(name, args)));
    }
    default:
      return ((pinnedReturn: Response) => pinnedReturn)(
        rpcError(id, -32601, `method not found: ${method}`),
      );
  }
}

export function mcpMethodNotAllowed() {
  return ((pinnedReturn: Response) => pinnedReturn)(
    jsonResponse(
      405,
      {
        error: "method_not_allowed",
        detail: "POST a single JSON-RPC message. This server does not open an SSE stream.",
      },
      { Allow: "POST" },
    ),
  );
}

function declaredBodyTooLarge(request: Request) {
  const header = request.headers.get("content-length");
  if (header === null) {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  if (!/^\d+$/.test(header)) {
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(Number(header) > MAX_BODY_BYTES);
}

async function readCappedBody(request: Request) {
  if (declaredBodyTooLarge(request)) {
    await request.body?.cancel();
    return ((pinnedReturn: (Uint8Array | null) | Promise<Uint8Array | null>) => pinnedReturn)(null);
  }
  const body = request.body;
  if (body === null) {
    return ((pinnedReturn: (Uint8Array | null) | Promise<Uint8Array | null>) => pinnedReturn)(
      new Uint8Array(),
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      return ((pinnedReturn: (Uint8Array | null) | Promise<Uint8Array | null>) => pinnedReturn)(
        null,
      );
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return ((pinnedReturn: (Uint8Array | null) | Promise<Uint8Array | null>) => pinnedReturn)(bytes);
}

export async function mcpPostResponse(request: Request) {
  const bytes = await readCappedBody(request);
  if (bytes === null) {
    return ((pinnedReturn: Response | Promise<Response>) => pinnedReturn)(
      rpcError(null, -32600, "request is too large"),
    );
  }
  const message = parseRpc(new TextDecoder().decode(bytes));
  switch (message.kind) {
    case "parse_error":
      return ((pinnedReturn: Response | Promise<Response>) => pinnedReturn)(
        rpcError(null, -32700, "parse error"),
      );
    case "invalid":
      return ((pinnedReturn: Response | Promise<Response>) => pinnedReturn)(
        rpcError(null, -32600, "invalid request"),
      );
    case "notification":
      return ((pinnedReturn: Response | Promise<Response>) => pinnedReturn)(
        new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } }),
      );
    case "request":
      return ((pinnedReturn: Response | Promise<Response>) => pinnedReturn)(handleRequest(message));
    default: {
      const _exhaustive: never = message;
      return ((pinnedReturn: Response | Promise<Response>) => pinnedReturn)(_exhaustive);
    }
  }
}
