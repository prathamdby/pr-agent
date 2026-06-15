import { describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

const initCursorWorkerMock = vi.hoisted(() =>
  vi.fn(async () => ({
    modelCount: 2,
    topModels: ["composer-2.5"],
    fastModels: ["composer-2.5-fast"],
    ripgrepPath: "/usr/bin/rg",
  })),
);

vi.mock("../src/agent/providers/cursor/workerBoot.js", () => ({
  initCursorWorker: initCursorWorkerMock,
}));

import { cursorAgentRunnerProvider } from "../src/agent/providers/cursor/agentRunner.js";
import { piAgentRunnerProvider } from "../src/agent/providers/pi/index.js";

describe("AgentRunnerProvider boot", () => {
  it("dispatches cursor worker boot through the provider seam", async () => {
    const cfg = makeTestConfig({
      agentProvider: "cursor",
      cursorApiKey: "cursor-key",
      piModel: "composer-2.5",
    });

    await expect(cursorAgentRunnerProvider.boot?.(cfg)).resolves.toEqual({
      modelCount: 2,
      topModels: ["composer-2.5"],
      fastModels: ["composer-2.5-fast"],
      ripgrepPath: "/usr/bin/rg",
    });

    expect(initCursorWorkerMock).toHaveBeenCalledWith(cfg);
  });

  it("propagates cursor boot failures to the entrypoint seam", async () => {
    const error = new Error("catalog unavailable");
    initCursorWorkerMock.mockRejectedValueOnce(error);

    await expect(
      cursorAgentRunnerProvider.boot?.(
        makeTestConfig({
          agentProvider: "cursor",
          cursorApiKey: "cursor-key",
        }),
      ),
    ).rejects.toThrow("catalog unavailable");

    expect(initCursorWorkerMock).toHaveBeenCalled();
  });

  it("does not require boot for providers without startup work", () => {
    expect(piAgentRunnerProvider.boot).toBeUndefined();
  });
});
