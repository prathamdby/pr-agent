import { describe, expect, it } from "vitest";
import {
  buildSubmitDescriptionTool,
  createSubmitDescriptionState,
} from "../src/agent/submitDescriptionTool.js";
import { makeTestConfig } from "./helpers/config.js";

function buildTool() {
  return buildSubmitDescriptionTool({
    cfg: makeTestConfig(),
    token: "token",
    owner: "o",
    repo: "r",
    prNumber: 1,
    state: createSubmitDescriptionState(),
  }).piTool;
}

describe("submitDescription tool", () => {
  it("keeps its parameter schema identical across builds", () => {
    const first = buildTool();
    const second = buildTool();

    expect(second.parameters).toBe(first.parameters);
  });
});
