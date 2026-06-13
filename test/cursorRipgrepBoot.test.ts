import * as fs from "node:fs";
import { constants } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../src/posthog.js", () => ({
  posthog: {
    capture: mocks.capture,
    captureException: mocks.captureException,
  },
}));

import {
  assertCursorRipgrepConfigured,
  configureCursorRipgrepPath,
} from "../src/agent/providers/cursor/ripgrepBoot.js";

describe("configureCursorRipgrepPath", () => {
  const previous = process.env.CURSOR_RIPGREP_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CURSOR_RIPGREP_PATH;
    } else {
      process.env.CURSOR_RIPGREP_PATH = previous;
    }
  });

  it("resolves bundled rg from the cursor platform optional package", () => {
    delete process.env.CURSOR_RIPGREP_PATH;

    const rgPath = configureCursorRipgrepPath();

    expect(rgPath).toBeTruthy();
    expect(process.env.CURSOR_RIPGREP_PATH).toBe(rgPath);
    fs.accessSync(rgPath!, constants.X_OK);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cursor ripgrep configured",
      }),
    );
  });

  it("keeps an explicit CURSOR_RIPGREP_PATH", () => {
    process.env.CURSOR_RIPGREP_PATH = "/custom/rg";

    expect(configureCursorRipgrepPath()).toBe("/custom/rg");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("throws and reports to posthog when ripgrep is required but missing", () => {
    delete process.env.CURSOR_RIPGREP_PATH;

    expect(() => assertCursorRipgrepConfigured()).toThrow(/Ripgrep path not configured/);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      "worker",
      expect.objectContaining({ step: "ripgrep_required" }),
    );
  });
});
