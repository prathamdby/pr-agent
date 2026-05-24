import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as evlog from "../src/evlog.js";
import { checkMcpBearerAuth, createMcpBridge } from "../src/agent/cursor/mcpBridge.js";
import { initReviewRunMetrics, snapshotReviewRunMetrics } from "../src/agent/reviewRunMetrics.js";

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
    const bridge = await createMcpBridge({
      tools: [{ name: "noop", description: "noop", parameters: { type: "object" } }],
      executors: { noop: async () => "ok" },
    });
    try {
      const config = bridge.mcpServers["pr-agent"];
      expect(config?.type).toBe("http");
      expect(config?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
      expect(config?.headers?.Authorization).toMatch(/^Bearer /);
    } finally {
      await bridge.dispose();
    }
  });

  it("rejects requests without bearer token", async () => {
    const bridge = await createMcpBridge({
      tools: [{ name: "noop", description: "noop", parameters: { type: "object" } }],
      executors: { noop: async () => "ok" },
    });
    try {
      const config = bridge.mcpServers["pr-agent"];
      const res = await fetch(config.url, { method: "POST" });
      expect(res.status).toBe(401);
    } finally {
      await bridge.dispose();
    }
  });

  it("records tool_call metrics via ambient logger", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/mcp" }, async () => {
      initReviewRunMetrics({ provider: "cursor", model: "composer-2.5", mode: "review" });
      const bridge = await createMcpBridge({
        tools: [{ name: "noop", description: "noop", parameters: { type: "object" } }],
        executors: { noop: async () => "ok" },
      });
      try {
        const config = bridge.mcpServers["pr-agent"];
        const transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers },
        });
        const client = new Client({ name: "test", version: "1.0.0" });
        await client.connect(transport);
        const result = await client.callTool({ name: "noop", arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(snapshotReviewRunMetrics()?.toolCallCount).toBe(1);
        await client.close();
      } finally {
        await bridge.dispose();
      }
    });
  });

  it("completes tool RPC without operation logger", async () => {
    const bridge = await createMcpBridge({
      tools: [{ name: "noop", description: "noop", parameters: { type: "object" } }],
      executors: { noop: async () => "ok" },
    });
    try {
      const config = bridge.mcpServers["pr-agent"];
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      });
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(transport);
      const result = await client.callTool({ name: "noop", arguments: {} });
      expect(result.isError).not.toBe(true);
      await client.close();
    } finally {
      await bridge.dispose();
    }
  });
});
