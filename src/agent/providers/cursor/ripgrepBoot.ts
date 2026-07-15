import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CURSOR_RIPGREP_PATH, ENV } from "../../../settings/index.js";
import { captureCursorWorkerEvent, captureCursorWorkerFailure } from "./cursorAnalytics.js";

function readCursorRipgrepPath(): string {
  return (process.env[ENV.CURSOR_RIPGREP_PATH] ?? DEFAULT_CURSOR_RIPGREP_PATH).trim();
}

function writeCursorRipgrepPath(value: string): void {
  process.env[ENV.CURSOR_RIPGREP_PATH] = value;
}

export function configureCursorRipgrepPath(): string | undefined {
  const configured = readCursorRipgrepPath();
  if (configured) {
    writeCursorRipgrepPath(configured);
    return configured;
  }

  const rgName = process.platform === "win32" ? "rg.exe" : "rg";
  try {
    const baseRequire = createRequire(fileURLToPath(import.meta.url));
    const sdkEntry = baseRequire.resolve("@cursor/sdk");
    const sdkRequire = createRequire(sdkEntry);
    const platformPkgJson = sdkRequire.resolve(
      `@cursor/sdk-${process.platform}-${process.arch}/package.json`,
    );
    const rgPath = path.join(path.dirname(platformPkgJson), "bin", rgName);
    accessSync(rgPath, constants.X_OK);
    writeCursorRipgrepPath(rgPath);
    captureCursorWorkerEvent("cursor ripgrep configured", {
      source: "platform_package",
    });
    return rgPath;
  } catch (error) {
    captureCursorWorkerFailure("ripgrep_resolve", error, {
      platform: `${process.platform}-${process.arch}`,
    });
    return undefined;
  }
}

export function assertCursorRipgrepConfigured(): string {
  const configured = readCursorRipgrepPath() || configureCursorRipgrepPath();
  if (configured) {
    writeCursorRipgrepPath(configured);
    return configured;
  }

  const error = new Error(
    "Ripgrep path not configured for Cursor local agent. Call configureCursorRipgrepPath() at worker boot.",
  );
  captureCursorWorkerFailure("ripgrep_required", error);
  throw error;
}
