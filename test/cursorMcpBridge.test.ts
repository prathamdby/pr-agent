import { describe, expect, it } from "vitest";
import { checkMcpBearerAuth, createMcpBridge } from "../src/agent/cursor/mcpBridge.js";

describe("checkMcpBearerAuth", () => {
  it("accepts matching bearer token", () => {
    expect(checkMcpBearerAuth("Bearer abc123", "abc123")).toBe(true);
    expect(checkMcpBearerAuth("Bearer wrong", "abc123")).toBe(false);
    expect(checkMcpBearerAuth(undefined, "abc123")).toBe(false);
  });
});

describe("createMcpBridge", () => {
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
      const res = await fetch(config!.url!, { method: "POST" });
      expect(res.status).toBe(401);
    } finally {
      await bridge.dispose();
    }
  });
});
