import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as evlog from "../src/evlog.js";
import { checkMcpBearerAuth, createMcpBridge } from "../src/agent/providers/cursor/mcpBridge.js";
import {
  initReviewRunMetrics,
  snapshotReviewRunMetrics,
} from "../src/review/run/reviewRunMetrics.js";

type NoopBridge = Awaited<ReturnType<typeof createMcpBridge>>;
type HttpMcpServerConfig = Extract<NoopBridge["mcpServers"][string], { type?: "http" | "sse" }>;

const noopBridgeSpec = {
  tools: [{ name: "noop", description: "noop", parameters: { type: "object" } }],
  executors: { noop: async () => "ok" },
};

async function withBridge<T>(
  spec: Parameters<typeof createMcpBridge>[0],
  fn: (bridge: NoopBridge) => Promise<T>,
): Promise<T> {
  const bridge = await createMcpBridge(spec);
  try {
    return await fn(bridge);
  } finally {
    await bridge.dispose();
  }
}

async function withNoopBridge<T>(fn: (bridge: NoopBridge) => Promise<T>): Promise<T> {
  return withBridge(noopBridgeSpec, fn);
}

function expectHttpMcpConfig(config: NoopBridge["mcpServers"][string] | undefined) {
  expect(config?.type).toBe("http");
  if (config == null || config.type !== "http") {
    throw new Error("expected HTTP MCP server config");
  }
  return config;
}

async function connectClient(config: HttpMcpServerConfig): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("checkMcpBearerAuth", () => {
  it("accepts matching bearer token", () => {
    expect(checkMcpBearerAuth("Bearer abc123", "abc123")).toBe(true);
  });

  it("rejects invalid bearer tokens", () => {
    expect(checkMcpBearerAuth("Bearer abc124", "abc123")).toBe(false);
    expect(checkMcpBearerAuth("Bearer wrong", "abc123")).toBe(false);
    expect(checkMcpBearerAuth(undefined, "abc123")).toBe(false);
    expect(checkMcpBearerAuth("Token abc123", "abc123")).toBe(false);
  });
});

describe("createMcpBridge", () => {
  afterEach(() => {
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("exposes http mcp server config on loopback", async () => {
    await withNoopBridge(async (bridge) => {
      const config = expectHttpMcpConfig(bridge.mcpServers["pr-agent"]);
      expect(config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
      expect(config.headers?.Authorization).toMatch(/^Bearer /);
    });
  });

  it("rejects requests without bearer token", async () => {
    await withNoopBridge(async (bridge) => {
      const config = expectHttpMcpConfig(bridge.mcpServers["pr-agent"]);
      const res = await fetch(config.url, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });
  });

  it("records tool_call metrics via ambient logger", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/mcp" }, async () => {
      initReviewRunMetrics({
        provider: "cursor",
        model: "composer-2.5",
        mode: "review",
      });
      await withNoopBridge(async (bridge) => {
        const client = await connectClient(expectHttpMcpConfig(bridge.mcpServers["pr-agent"]));
        const result = await client.callTool({ name: "noop", arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(snapshotReviewRunMetrics()?.toolCallCount).toBe(1);
        expect(snapshotReviewRunMetrics()?.toolResultBytes).toBeGreaterThan(0);
        await client.close();
      });
    });
  });

  it("records tool_call failures for unknown tools", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/mcp" }, async () => {
      initReviewRunMetrics({
        provider: "cursor",
        model: "composer-2.5",
        mode: "review",
      });
      await withNoopBridge(async (bridge) => {
        const client = await connectClient(expectHttpMcpConfig(bridge.mcpServers["pr-agent"]));
        const result = await client.callTool({
          name: "missing",
          arguments: {},
        });
        expect(result.isError).toBe(true);
        expect(snapshotReviewRunMetrics()).toMatchObject({
          toolCallCount: 1,
          toolCallErrors: 1,
          toolResultBytes: expect.any(Number),
          toolResultCharacters: expect.any(Number),
        });
        await client.close();
      });
    });
  });

  it("completes tool RPC without operation logger", async () => {
    await withNoopBridge(async (bridge) => {
      const client = await connectClient(expectHttpMcpConfig(bridge.mcpServers["pr-agent"]));
      const result = await client.callTool({ name: "noop", arguments: {} });
      expect(result.isError).not.toBe(true);
      await client.close();
    });
  });

  it("serializes object tool results as compact JSON", async () => {
    await withBridge(
      {
        tools: [{ name: "object", description: "object", parameters: { type: "object" } }],
        executors: { object: async () => ({ answer: 42, nested: { ok: true } }) },
      },
      async (bridge) => {
        const client = await connectClient(expectHttpMcpConfig(bridge.mcpServers["pr-agent"]));
        const result = await client.callTool({ name: "object", arguments: {} });
        expect(result.content).toContainEqual({
          type: "text",
          text: '{"answer":42,"nested":{"ok":true}}',
        });
        await client.close();
      },
    );
  });

  it("nudges the active structured submission tool when the tool-round limit is hit", async () => {
    await withBridge(
      {
        tools: [
          { name: "readWorkspaceFile", description: "read", parameters: { type: "object" } },
          { name: "publish_summary", description: "summary", parameters: { type: "object" } },
        ],
        executors: {
          readWorkspaceFile: async () => "ok",
          publish_summary: async () => ({ ok: true }),
        },
        maxToolRounds: 1,
        toolRoundCounter: { count: 0 },
      },
      async (bridge) => {
        const client = await connectClient(expectHttpMcpConfig(bridge.mcpServers["pr-agent"]));
        await client.callTool({ name: "readWorkspaceFile", arguments: {} });
        const limited = await client.callTool({ name: "readWorkspaceFile", arguments: {} });
        expect(limited.isError).toBe(true);
        expect(limited.content).toContainEqual({
          type: "text",
          text: "Tool round limit (1) reached; call publish_summary with your structured result.",
        });
        await client.close();
      },
    );
  });

  it("uses provider-neutral guidance when no structured submission tool is registered", async () => {
    await withBridge(
      {
        tools: [{ name: "noop", description: "noop", parameters: { type: "object" } }],
        executors: { noop: async () => "ok" },
        maxToolRounds: 0,
        toolRoundCounter: { count: 0 },
      },
      async (bridge) => {
        const client = await connectClient(expectHttpMcpConfig(bridge.mcpServers["pr-agent"]));
        const limited = await client.callTool({ name: "noop", arguments: {} });
        expect(limited.isError).toBe(true);
        expect(limited.content).toContainEqual({
          type: "text",
          text: "Tool round limit (0) reached; call your structured submission tool now.",
        });
        await client.close();
      },
    );
  });
});
