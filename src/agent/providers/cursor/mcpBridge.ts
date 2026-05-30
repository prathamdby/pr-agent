import crypto from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServerConfig } from "@cursor/sdk";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CURSOR_MCP_BIND_HOST,
  CURSOR_MCP_SERVER_NAME,
  CURSOR_MCP_SERVER_START_TIMEOUT_MS,
  CURSOR_MCP_TOKEN_BYTES,
  CURSOR_MAX_PORT_RETRIES,
} from "../../../settings/index.js";
import type { CursorExecutor } from "./runContext.js";
import { logDebug } from "../../../evlog.js";
import { recordReviewMetric } from "../../../review/reviewRunMetrics.js";

function safeRecordReviewMetric(event: Parameters<typeof recordReviewMetric>[0]): void {
  try {
    recordReviewMetric(event);
  } catch {
    logDebug("review_metric_record_failed", { kind: event.kind });
  }
}

export type McpBridgeOptions = {
  readonly tools: readonly PiTool[];
  readonly executors: Record<string, CursorExecutor>;
  readonly signal?: AbortSignal;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly maxToolRounds?: number;
  readonly toolRoundCounter?: { count: number };
};

export type McpBridgeHandle = {
  readonly mcpServers: Record<string, McpServerConfig>;
  readonly dispose: () => Promise<void>;
};

export function checkMcpBearerAuth(
  authorizationHeader: string | undefined,
  token: string,
): boolean {
  if (!authorizationHeader) return false;
  const [scheme, value] = authorizationHeader.split(" ", 2);
  return scheme?.toLowerCase() === "bearer" && value === token;
}

function piToolToMcpTool(tool: PiTool): McpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as McpTool["inputSchema"],
  };
}

function executorResultToMcp(result: unknown, isError = false): CallToolResult {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return {
    content: [{ type: "text", text }],
    isError: isError || undefined,
  };
}

function checkBearerAuth(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  return checkMcpBearerAuth(Array.isArray(header) ? header[0] : header, token);
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeIdleConnections?.();
  });
}

async function runWithAbortSignal<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new Error("MCP tool call aborted");
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error("MCP tool call aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void run()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function listenOnEphemeralPort(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      server.off("error", onError);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      server.off("listening", onListening);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, CURSOR_MCP_BIND_HOST);
  });
}

async function bindEphemeralHttpServer(
  createServerInstance: () => HttpServer,
  attempt = 0,
): Promise<HttpServer> {
  const server = createServerInstance();
  try {
    await listenOnEphemeralPort(server);
    return server;
  } catch (error) {
    await closeHttpServer(server).catch(() => undefined);
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "EADDRINUSE" && attempt < CURSOR_MAX_PORT_RETRIES) {
      return bindEphemeralHttpServer(createServerInstance, attempt + 1);
    }
    throw error;
  }
}

export async function createMcpBridge(options: McpBridgeOptions): Promise<McpBridgeHandle> {
  const bearerToken = crypto.randomBytes(CURSOR_MCP_TOKEN_BYTES).toString("hex");
  const endpointPath = `/mcp/${crypto.randomUUID()}`;
  const pendingCalls = new Set<AbortController>();
  let disposed = false;

  const mcpServer = new McpProtocolServer(
    { name: "pr-agent-tool-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map(piToolToMcpTool),
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const toolStarted = Date.now();

    if (disposed) {
      safeRecordReviewMetric({ kind: "tool_call", name: toolName, ok: false });
      return {
        content: [{ type: "text", text: "MCP bridge disposed" }],
        isError: true,
      };
    }

    const abortController = new AbortController();
    pendingCalls.add(abortController);
    const linkAbort = (): void => abortController.abort();
    extra.signal?.addEventListener("abort", linkAbort, { once: true });
    options.signal?.addEventListener("abort", linkAbort, { once: true });

    try {
      if (abortController.signal.aborted) {
        throw new Error("MCP tool call aborted");
      }
      if (options.maxToolRounds != null) {
        const counter = options.toolRoundCounter ?? { count: 0 };
        counter.count += 1;
        if (counter.count > options.maxToolRounds) {
          safeRecordReviewMetric({ kind: "tool_call", name: toolName, ok: false });
          return executorResultToMcp(
            `Tool round limit (${options.maxToolRounds}) reached; call submitReview with your findings.`,
            true,
          );
        }
      }
      if (options.refreshBeforeTool) {
        await runWithAbortSignal(
          () => options.refreshBeforeTool!(toolName),
          abortController.signal,
        );
      }
      const exec = options.executors[toolName];
      if (!exec) {
        safeRecordReviewMetric({ kind: "tool_call", name: toolName, ok: false });
        return {
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
      }
      const args =
        request.params.arguments && typeof request.params.arguments === "object"
          ? request.params.arguments
          : {};
      const out = await runWithAbortSignal(() => exec(args), abortController.signal);
      safeRecordReviewMetric({
        kind: "tool_call",
        name: toolName,
        ok: true,
        durationMs: Date.now() - toolStarted,
      });
      return executorResultToMcp(out);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      safeRecordReviewMetric({ kind: "tool_call", name: toolName, ok: false });
      return executorResultToMcp(message, true);
    } finally {
      extra.signal?.removeEventListener("abort", linkAbort);
      options.signal?.removeEventListener("abort", linkAbort);
      pendingCalls.delete(abortController);
    }
  });

  await mcpServer.connect(transport);

  const createHttpServer = (): HttpServer =>
    createServer((req, res) => {
      if (!checkBearerAuth(req, bearerToken)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const url = req.url ?? "";
      if (!url.startsWith(endpointPath)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      void transport.handleRequest(req, res).catch(() => undefined);
    });

  let startTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const startDeadline = new Promise<never>((_, reject) => {
    startTimeoutId = setTimeout(
      () =>
        reject(
          new Error(
            `MCP bridge HTTP server did not start within ${CURSOR_MCP_SERVER_START_TIMEOUT_MS}ms`,
          ),
        ),
      CURSOR_MCP_SERVER_START_TIMEOUT_MS,
    );
  });
  let httpServer: HttpServer;
  try {
    httpServer = await Promise.race([bindEphemeralHttpServer(createHttpServer), startDeadline]);
  } finally {
    if (startTimeoutId !== undefined) clearTimeout(startTimeoutId);
  }

  const address = httpServer.address() as AddressInfo | null;
  if (!address?.port) {
    throw new Error("MCP bridge HTTP server failed to bind");
  }

  const endpointUrl = `http://${CURSOR_MCP_BIND_HOST}:${address.port}${endpointPath}`;
  const mcpServers: Record<string, McpServerConfig> = {
    [CURSOR_MCP_SERVER_NAME]: {
      type: "http",
      url: endpointUrl,
      headers: { Authorization: `Bearer ${bearerToken}` },
    },
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const controller of pendingCalls) {
      controller.abort();
    }
    pendingCalls.clear();
    await Promise.allSettled([transport.close(), mcpServer.close()]);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
      httpServer.closeIdleConnections?.();
    });
  };

  options.signal?.addEventListener(
    "abort",
    () => {
      void dispose();
    },
    { once: true },
  );

  return { mcpServers, dispose };
}
