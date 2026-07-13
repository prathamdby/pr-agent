import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  DEFAULT_MAX_PR_FILES_LISTED,
  DEFAULT_MAX_PR_FILES_PATCH_BYTES,
  ENV,
  EXTERNAL_ENV,
} from "../src/settings/index.js";

const ENV_EXAMPLE_PATH = path.join(process.cwd(), ".env.example");
const SRC_ROOT = path.join(process.cwd(), "src");

function parseEnvExampleKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    keys.push(trimmed.slice(0, eq).trim());
  }
  return keys;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("settings inventory", () => {
  it("ENV keys match loadConfig surface", () => {
    const envValues = Object.values(ENV);
    expect(envValues).toContain("PORT");
    expect(envValues).toContain("DATABASE_URL");
    expect(envValues).toContain(ENV.POSTHOG_PROJECT_TOKEN);
    expect(envValues).toContain(ENV.POSTHOG_HOST);
    expect(envValues).toContain(ENV.POSTHOG_ENABLED);
    expect(envValues).toContain(ENV.POSTHOG_EXCEPTION_AUTOCAPTURE);
    expect(new Set(envValues).size).toBe(envValues.length);
  });

  it(".env.example documents every loadConfig env key", () => {
    const content = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");
    const documented = parseEnvExampleKeys(content);
    const documentedSet = new Set(documented);
    const cataloguedKeys: ReadonlySet<string> = new Set([
      ...Object.values(ENV),
      ...Object.values(EXTERNAL_ENV),
    ]);

    for (const key of Object.values(ENV)) {
      expect(documentedSet.has(key), `missing ${key} in .env.example`).toBe(true);
    }

    for (const key of documented) {
      expect(cataloguedKeys.has(key), `${key} in .env.example is not catalogued`).toBe(true);
    }
  });

  it("high-risk defaults match settings/defaults.ts", () => {
    const content = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");
    const documented = parseEnvExampleKeys(content);
    const readExample = (key: string): string | undefined => {
      const line = content.split("\n").find((l) => l.trim().startsWith(`${key}=`));
      if (!line) return undefined;
      return line.split("=")[1]?.trim();
    };

    expect(readExample(ENV.MAX_PR_FILES_LISTED)).toBe(String(DEFAULT_MAX_PR_FILES_LISTED));
    expect(readExample(ENV.MAX_PR_FILES_PATCH_BYTES)).toBe(
      String(DEFAULT_MAX_PR_FILES_PATCH_BYTES),
    );
    expect(readExample(ENV.WEBHOOK_MAX_BODY_BYTES)).toBe(String(DEFAULT_WEBHOOK_MAX_BODY_BYTES));
    expect(documented.length).toBeGreaterThan(20);
  });

  it("PostHog keys are not read as raw process.env outside settings/config", () => {
    const allowed = new Set([
      path.join(SRC_ROOT, "config.ts"),
      path.join(SRC_ROOT, "settings", "envKeys.ts"),
      path.join(SRC_ROOT, "settings", "defaults.ts"),
    ]);
    const rawPosthogEnv = /process\.env(?:\.POSTHOG_[A-Z0-9_]+|\[[^\]]*POSTHOG_[A-Z0-9_]+)/;
    const offenders: string[] = [];

    for (const file of listTsFiles(SRC_ROOT)) {
      if (allowed.has(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      if (rawPosthogEnv.test(content)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
