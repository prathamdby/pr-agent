import { describe, expect, it } from "vitest";
import { getApiProvider } from "@earendil-works/pi-ai";
import { registerCursorProvider } from "../src/agent/providers/cursor/register.js";

describe("registerCursorProvider", () => {
  it("registers cursor-sdk api provider", () => {
    registerCursorProvider();
    expect(getApiProvider("cursor-sdk")).toBeDefined();
  });
});
