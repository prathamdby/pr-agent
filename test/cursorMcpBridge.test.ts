import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as evlog from "../src/evlog.js";
import { checkMcpBearerAuth, createMcpBridge } from "../src/agent/providers/cursor/mcpBridge.js";
import { initReviewRunMetrics, snapshotReviewRunMetrics } from "../src/review/reviewRunMetrics.js";

type NoopBridge = Awaited<ReturnType<typeof createMcpBridge>>;

const noopBridgeSpec = {
  tools: [{ name: "noop", description: "noop", parameters: { type: "object" } }],
  executors: { noop: async () => "ok" },
};

async function withNoopBridge<T>(fn: (bridge: NoopBridge) => Promise<T>): Promise<T> {
  const bridge = await createMcpBridge(noopBridgeSpec);
  try {
    return await fn(bridge);
  } finally {
    await bridge.dispose();
  }
}

async function connectClient(config: NoopBridge["mcpServers"]["pr-agent"]): Promise<Client> {
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
    expect(checkMcpBearerAuth("Bearer wrong", "abc123")).toBe(false);
    expect(checkMcpBearerAuth(undefined, "abc123")).toBe(false);
  });
});

describe("createMcpBridge", () => {
  afterEach(() => {
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("exposes http mcp server config on loopback", async () => {
    await withNoopBridge(async (bridge) => {
      const config = bridge.mcpServers["pr-agent"];
      expect(config?.type).toBe("http");
      expect(config?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
      expect(config?.headers?.Authorization).toMatch(/^Bearer /);
    });
  });

  it("rejects requests without bearer token", async () => {
    await withNoopBridge(async (bridge) => {
      const res = await fetch(bridge.mcpServers["pr-agent"].url, { method: "POST" });
      expect(res.status).toBe(401);
    });
  });

  it("records tool_call metrics via ambient logger", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/mcp" }, async () => {
      initReviewRunMetrics({ provider: "cursor", model: "composer-2.5", mode: "review" });
      await withNoopBridge(async (bridge) => {
        const client = await connectClient(bridge.mcpServers["pr-agent"]);
        const result = await client.callTool({ name: "noop", arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(snapshotReviewRunMetrics()?.toolCallCount).toBe(1);
        await client.close();
      });
    });
  });

  it("records tool_call failures for unknown tools", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/mcp" }, async () => {
      initReviewRunMetrics({ provider: "cursor", model: "composer-2.5", mode: "review" });
      await withNoopBridge(async (bridge) => {
        const client = await connectClient(bridge.mcpServers["pr-agent"]);
        const result = await client.callTool({ name: "missing", arguments: {} });
        expect(result.isError).toBe(true);
        expect(snapshotReviewRunMetrics()).toMatchObject({ toolCallCount: 1, toolCallErrors: 1 });
        await client.close();
      });
    });
  });

  it("completes tool RPC without operation logger", async () => {
    await withNoopBridge(async (bridge) => {
      const client = await connectClient(bridge.mcpServers["pr-agent"]);
      const result = await client.callTool({ name: "noop", arguments: {} });
      expect(result.isError).not.toBe(true);
      await client.close();
    });
  });
});
