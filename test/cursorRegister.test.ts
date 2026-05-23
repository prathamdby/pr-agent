import { describe, expect, it } from "vitest";
import { getApiProvider } from "@earendil-works/pi-ai";
import {
  isCursorProviderRegistered,
  registerCursorProvider,
  resetCursorProviderRegistrationForTests,
} from "../src/agent/cursor/register.js";

describe("registerCursorProvider", () => {
  it("registers cursor-sdk api provider", () => {
    resetCursorProviderRegistrationForTests();
    expect(isCursorProviderRegistered()).toBe(false);
    registerCursorProvider();
    expect(isCursorProviderRegistered()).toBe(true);
    expect(getApiProvider("cursor-sdk")).toBeDefined();
  });
});
